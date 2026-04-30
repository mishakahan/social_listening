import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
import type { TpRawSignal, InsertTpSignalEntity } from "@workspace/db";

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
// GPT-4o-mini extraction prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a trend-extraction assistant. For each social media post provided, identify:
- TREND: emerging consumer trends, product categories, aesthetics, behaviors, or cultural phenomena
- PRODUCT: specific products, brands, or product types
- PLACE: geographic regions relevant to the trend

Output strict JSON: an array of objects, one per input signal (in same order). Each object:
{
  "signalIndex": <number>,
  "entities": [
    { "label": "<canonical name>", "type": "trend"|"product"|"place", "span": "<mention text>", "sentiment": "positive"|"neutral"|"negative" }
  ]
}

Rules:
- Only extract entities explicitly or strongly implied by the text
- Normalize labels: title case, no hashtag symbols, singular form
- Max 5 entities per signal
- If no entities found, use "entities": []
- Do not add commentary, only valid JSON`;

interface ExtractedEntity {
  label: string;
  type: "trend" | "product" | "place";
  span: string;
  sentiment: "positive" | "neutral" | "negative";
}

interface ExtractionResult {
  signalIndex: number;
  entities: ExtractedEntity[];
}

async function callGpt(signals: TpRawSignal[]): Promise<ExtractionResult[]> {
  const inputLines = signals.map((s, i) => {
    const text = [s.text, ...(s.hashtags ?? [])].filter(Boolean).join(" ").slice(0, 500);
    return `[${i}] platform=${s.platform} text=${JSON.stringify(text)}`;
  });

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
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

  let results: ExtractionResult[] = [];
  let attempts = 0;

  while (attempts < 3) {
    try {
      results = await callGpt(signals);
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

      // Resolve synonym if one exists in the synonym table
      const canonicalLabel = await storage.resolveSynonym(companyId, entity.label, entity.type);

      // Upsert the entity
      const entityRecord = await storage.upsertEntity(
        companyId,
        canonicalLabel,
        entity.type,
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
