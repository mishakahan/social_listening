import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
import { extractAttributesForBatch } from "./attribute-extraction.js";
import {
  DEFAULT_ENTITY_TYPES,
  type EntityTypeConfig,
  type TpRawSignal,
  type InsertTpSignalEntity,
} from "@workspace/db";

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

// ---------------------------------------------------------------------------
// Per-company entity-type taxonomy
// ---------------------------------------------------------------------------

// Re-export for any other module that wants to inspect the built-in fallback.
export { DEFAULT_ENTITY_TYPES };

/**
 * Read the entity-type taxonomy from the company's pipeline_config. Falls back
 * to DEFAULT_ENTITY_TYPES if the config is missing/empty (e.g. for a brand-new
 * company before its first save).
 */
async function getEntityTypesForCompany(
  companyId: number
): Promise<EntityTypeConfig[]> {
  try {
    const cfg = await storage.getPipelineConfig(companyId);
    const types = (cfg.entityTypes ?? []).filter((t) => t && t.id);
    return types.length > 0 ? types : DEFAULT_ENTITY_TYPES;
  } catch (err) {
    logger.warn(
      { err, companyId },
      "Failed to load entity-type config, falling back to defaults"
    );
    return DEFAULT_ENTITY_TYPES;
  }
}

/**
 * Read the per-company core vocabulary — terms that should NEVER be extracted
 * as a trend because they are part of the company's everyday category language
 * (e.g. "chocolate", "pizza", "gelato" for a confectionery client).
 */
async function getCoreVocabularyForCompany(
  companyId: number
): Promise<string[]> {
  try {
    const cfg = await storage.getPipelineConfig(companyId);
    return (cfg.coreVocabulary ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
  } catch (err) {
    logger.warn({ err, companyId }, "Failed to load core vocabulary; treating as empty");
    return [];
  }
}

function buildSystemPrompt(
  types: EntityTypeConfig[],
  coreVocabulary: string[]
): string {
  const guideLines = types
    .map((t) => {
      const examples = t.examples ? ` (e.g. ${t.examples})` : "";
      const desc = t.description ? ` — ${t.description}` : "";
      return `- ${t.id}: ${t.label}${examples}${desc}`;
    })
    .join("\n");
  const idList = types.map((t) => t.id).join(" | ");

  // Inject the company-specific core vocabulary as an explicit exclusion list,
  // and always include the generic "no bare category words / no bare locations"
  // rules. These two rules are the single biggest lever against the pipeline
  // surfacing things like "Chocolate", "Pizza", or "Milano" as trends.
  const coreVocabClause = coreVocabulary.length > 0
    ? `\n- CORE VOCABULARY EXCLUSION: do NOT extract any of these bare category words (they are this company's everyday vocabulary, not trends): ${coreVocabulary.join(", ")}. They are only meaningful as part of a multi-word, qualified entity (e.g. "dubai chocolate" is OK, "chocolate" alone is not).`
    : "";

  return `You are a trend-extraction assistant for a consumer-goods trend radar. For each social media post provided, identify the salient entities and classify them using the taxonomy below.

Entity type taxonomy:
${guideLines}

Output strict JSON: an array of objects, one per input signal (in same order). Each object:
{
  "signalIndex": <number>,
  "entities": [
    { "label": "<canonical name>", "type": "<one of: ${idList}>", "span": "<mention text>", "sentiment": "positive"|"neutral"|"negative" }
  ]
}

Rules:
- Only extract entities explicitly or strongly implied by the text.
- Normalize labels: title case (or original casing for proper nouns and aesthetic tags), no hashtag symbols, singular form.
- Pick the most specific type that fits. Use the most-generic / catch-all type only as a last resort.
- AVOID GENERIC CATEGORY WORDS: do NOT extract bare common nouns like "chocolate", "pizza", "coffee", "pasta", "pastry", "cake", "cookie", "ice cream", "dessert", "snack", "drink" unless they appear with a distinguishing qualifier (e.g. "dubai chocolate", "cottage cheese pasta", "miso brownie"). If the only candidate is a bare category word, return nothing for that signal.
- AVOID BARE LOCATION NAMES: do NOT extract a bare city, region, or country name (e.g. "Milano", "Toscana", "Paris") as a provenance entity. Only extract a provenance when it qualifies a specific product (e.g. "Piedmontese hazelnut", "single-origin Madagascar chocolate"). Travel/lifestyle mentions of a place alone are not trends.${coreVocabClause}
- Max 5 entities per signal.
- If no entities found, use "entities": [].
- Do not add commentary, only valid JSON.`;
}

interface ExtractedEntity {
  label: string;
  type: string;
  span: string;
  sentiment: "positive" | "neutral" | "negative";
}

interface ExtractionResult {
  signalIndex: number;
  entities: ExtractedEntity[];
}

async function callGpt(
  signals: TpRawSignal[],
  systemPrompt: string
): Promise<ExtractionResult[]> {
  const inputLines = signals.map((s, i) => {
    const text = [s.text, ...(s.hashtags ?? [])].filter(Boolean).join(" ").slice(0, 500);
    return `[${i}] platform=${s.platform} text=${JSON.stringify(text)}`;
  });

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: inputLines.join("\n") },
    ],
  });

  const raw = response.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(raw) as { [key: string]: ExtractionResult[] } | ExtractionResult[];
  // The model may wrap in a key or return an array directly
  if (Array.isArray(parsed)) return parsed;
  const firstKey = Object.keys(parsed)[0];
  if (firstKey && Array.isArray((parsed as any)[firstKey])) {
    return (parsed as any)[firstKey] as ExtractionResult[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main extraction function with retry
// ---------------------------------------------------------------------------

export async function extractEntitiesForBatch(
  companyId: number,
  signals: TpRawSignal[]
): Promise<void> {
  if (signals.length === 0) return;

  // Load the per-company entity taxonomy and build the prompt from it.
  const entityTypes = await getEntityTypesForCompany(companyId);
  const allowedTypeIds = new Set(entityTypes.map((t) => t.id));
  // If the user kept a catch-all type ("other"), use it for unknown LLM
  // outputs; otherwise we drop unknown entities rather than silently
  // misclassifying them into an arbitrary user category.
  const fallbackTypeId = allowedTypeIds.has("other") ? "other" : null;
  // Load the per-company core vocabulary and build a normalized Set for
  // case-insensitive exact-match filtering. The same list is also injected
  // into the prompt as a soft instruction; this Set is the hard guarantee.
  const coreVocabulary = await getCoreVocabularyForCompany(companyId);
  const coreVocabSet = new Set(coreVocabulary.map((s) => s.trim().toLowerCase()));
  const systemPrompt = buildSystemPrompt(entityTypes, coreVocabulary);

  let results: ExtractionResult[] = [];
  let attempts = 0;

  while (attempts < 3) {
    try {
      results = await callGpt(signals, systemPrompt);
      break;
    } catch (err: any) {
      attempts++;
      if (attempts >= 3) {
        logger.error({ err, companyId, count: signals.length }, "Entity extraction GPT call failed after retries");
        await storage.markSignalsExtractionFailed(signals.map((s) => s.id));
        return;
      }
      logger.warn({ err, attempt: attempts }, "GPT call failed, retrying after backoff");
      await new Promise((r) => setTimeout(r, 1000 * attempts));
    }
  }

  const signalEntityRows: InsertTpSignalEntity[] = [];
  const successfulIds: number[] = [];
  // Per-signal entity-id lists, used to derive unordered co-occurrence pairs
  // (Task #3). Kept in the same insertion order as signalEntityRows so the
  // batch helper can write both tables in a single transaction.
  const entityIdsBySignal = new Map<number, number[]>();

  for (const result of results) {
    const signal = signals[result.signalIndex];
    if (!signal) continue;

    successfulIds.push(signal.id);

    for (const entity of result.entities) {
      if (!entity.label || !entity.type) continue;

      // Hard core-vocabulary filter: drop bare matches against the company's
      // configured stoplist regardless of what type the LLM assigned. This is
      // the belt-and-braces complement to the prompt-level instruction.
      const labelNorm = entity.label.trim().toLowerCase();
      if (coreVocabSet.has(labelNorm)) continue;

      // Coerce unexpected types to the configured fallback so a single bad
      // LLM output (or a type the user removed) doesn't poison the entity
      // table. If the user removed the catch-all "other" type, drop unknown
      // entities rather than silently misclassifying them.
      let safeType: string;
      if (allowedTypeIds.has(entity.type)) {
        safeType = entity.type;
      } else if (fallbackTypeId) {
        safeType = fallbackTypeId;
      } else {
        continue;
      }

      // Resolve synonym if one exists in the synonym table
      const canonicalLabel = await storage.resolveSynonym(companyId, entity.label, safeType);

      // Re-check core vocab against the canonical (post-synonym) label too,
      // in case a synonym maps an alias onto a core-vocab term.
      if (coreVocabSet.has(canonicalLabel.trim().toLowerCase())) continue;

      // Upsert the entity
      const entityRecord = await storage.upsertEntity(
        companyId,
        canonicalLabel,
        safeType,
        entity.label !== canonicalLabel ? entity.label : undefined
      );

      // Update mention stats on the entity
      await storage.updateEntityMentionStats(entityRecord.id, {
        mentions: 1,
        firstSeenAt: signal.postedAt ?? signal.capturedAt,
        lastSeenAt: signal.postedAt ?? signal.capturedAt,
      });

      signalEntityRows.push({
        rawSignalId: signal.id,
        entityId: entityRecord.id,
        mentionTextSpan: entity.span || null,
        sentiment: entity.sentiment ?? null,
        sentimentConfidence: null,
      });

      const existing = entityIdsBySignal.get(signal.id) ?? [];
      existing.push(entityRecord.id);
      entityIdsBySignal.set(signal.id, existing);
    }
  }

  const perSignalPairs = signals
    .filter((s) => (entityIdsBySignal.get(s.id) ?? []).length >= 2)
    .map((s) => ({
      companyId,
      rawSignalId: s.id,
      postedAt: s.postedAt ?? s.capturedAt,
      entityIds: entityIdsBySignal.get(s.id) ?? [],
    }));

  await storage.bulkInsertSignalEntitiesAndCoOccurrences(
    signalEntityRows,
    perSignalPairs
  );

  // Mark all signals in this batch as extracted (including ones with no entities)
  const allIds = signals.map((s) => s.id);
  await storage.markSignalsExtracted(allIds);

  logger.info(
    { companyId, signalCount: signals.length, entityLinks: signalEntityRows.length },
    "Entity extraction batch done"
  );

  // Category-scoped attribute extraction (Task #4). Best-effort: a failure
  // here logs but never throws so the entity batch stays "done".
  try {
    await extractAttributesForBatch(companyId, signals);
  } catch (err) {
    logger.warn(
      { err, companyId, signalCount: signals.length },
      "Attribute extraction batch threw; ignoring (best-effort)"
    );
  }
}

// ---------------------------------------------------------------------------
// Run entity extraction for all pending signals for a company
// ---------------------------------------------------------------------------

export async function runEntityExtraction(
  companyId: number,
  options?: {
    batchSize?: number;
    actorRunId?: number;
    maxBatches?: number;
    concurrency?: number;
  }
): Promise<{ processed: number; entityLinks: number }> {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn("OPENAI_API_KEY not set — skipping entity extraction");
    return { processed: 0, entityLinks: 0 };
  }

  const batchSize = options?.batchSize ?? 20;
  const maxBatches = options?.maxBatches ?? 50;
  // Each batch is one LLM round-trip and they were run strictly one at a time,
  // so the whole stage sat idle waiting on the network: ~60 signals/min, which
  // is ~7 hours for a 25k backlog. Nothing about the work is sequential — the
  // batches are disjoint sets of signals.
  //
  // This was previously unsafe: upsertEntity was select-then-insert, so two
  // batches meeting the same new label both inserted and produced duplicate
  // entities. It is now an atomic ON CONFLICT against a unique index, so
  // concurrent batches converge on one row instead of racing.
  const concurrency = Math.max(1, options?.concurrency ?? 6);
  let processed = 0;
  let batchCount = 0;

  while (batchCount < maxBatches) {
    // Claim enough work for every worker in this wave. Signals are marked
    // done/failed by extractEntitiesForBatch, so the next fetch cannot hand the
    // same rows out twice — waves are sequential, workers within a wave are not.
    const wave = await storage.getUnextractedSignals(
      companyId,
      batchSize * concurrency,
      options?.actorRunId
    );
    if (wave.length === 0) break;

    const batches: TpRawSignal[][] = [];
    for (let i = 0; i < wave.length; i += batchSize) {
      batches.push(wave.slice(i, i + batchSize));
      if (batchCount + batches.length >= maxBatches) break;
    }

    // One rejection must not lose the whole wave: extractEntitiesForBatch marks
    // its own signals failed, and allSettled lets the other workers finish.
    const results = await Promise.allSettled(
      batches.map((b) => extractEntitiesForBatch(companyId, b))
    );
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        logger.warn({ err: r.reason, size: batches[i]!.length }, "Extraction batch failed");
      } else {
        processed += batches[i]!.length;
      }
    });
    batchCount += batches.length;

    if (wave.length < batchSize * concurrency) break; // drained
  }

  logger.info({ companyId, processed, batchCount, concurrency }, "Entity extraction run complete");
  return { processed, entityLinks: 0 };
}
