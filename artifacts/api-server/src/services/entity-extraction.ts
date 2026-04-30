import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
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

function buildSystemPrompt(types: EntityTypeConfig[]): string {
  const guideLines = types
    .map((t) => {
      const examples = t.examples ? ` (e.g. ${t.examples})` : "";
      const desc = t.description ? ` — ${t.description}` : "";
      return `- ${t.id}: ${t.label}${examples}${desc}`;
    })
    .join("\n");
  const idList = types.map((t) => t.id).join(" | ");
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
  const systemPrompt = buildSystemPrompt(entityTypes);

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

  for (const result of results) {
    const signal = signals[result.signalIndex];
    if (!signal) continue;

    successfulIds.push(signal.id);

    for (const entity of result.entities) {
      if (!entity.label || !entity.type) continue;

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
    }
  }

  await storage.bulkInsertSignalEntities(signalEntityRows);

  // Mark all signals in this batch as extracted (including ones with no entities)
  const allIds = signals.map((s) => s.id);
  await storage.markSignalsExtracted(allIds);

  logger.info(
    { companyId, signalCount: signals.length, entityLinks: signalEntityRows.length },
    "Entity extraction batch done"
  );
}

// ---------------------------------------------------------------------------
// Run entity extraction for all pending signals for a company
// ---------------------------------------------------------------------------

export async function runEntityExtraction(
  companyId: number,
  options?: { batchSize?: number; actorRunId?: number; maxBatches?: number }
): Promise<{ processed: number; entityLinks: number }> {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn("OPENAI_API_KEY not set — skipping entity extraction");
    return { processed: 0, entityLinks: 0 };
  }

  const batchSize = options?.batchSize ?? 20;
  const maxBatches = options?.maxBatches ?? 50;
  let processed = 0;
  let batchCount = 0;

  while (batchCount < maxBatches) {
    const pending = await storage.getUnextractedSignals(
      companyId,
      batchSize,
      options?.actorRunId
    );
    if (pending.length === 0) break;

    await extractEntitiesForBatch(companyId, pending);
    processed += pending.length;
    batchCount++;

    if (pending.length < batchSize) break; // no more pending
  }

  logger.info({ companyId, processed, batchCount }, "Entity extraction run complete");
  return { processed, entityLinks: 0 };
}
