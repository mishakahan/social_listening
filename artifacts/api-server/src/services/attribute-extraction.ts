import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
import type { TpRawSignal, InsertTpAttributeSignal } from "@workspace/db";

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

interface VocabItem {
  id: number;
  attribute: string;
}

function buildPrompt(categoryLabel: string, vocab: VocabItem[]): string {
  const list = vocab.map((v) => `${v.id}: ${v.attribute}`).join("\n");
  return `You are an attribute-extraction assistant for a consumer-goods trend radar.

Category: ${categoryLabel}

Below is the EXACT controlled vocabulary of attributes for this category. For each input social media post, identify which attribute ids from this list are explicitly mentioned or strongly implied as a descriptor of a product in this category.

Vocabulary (id: term):
${list}

Output strict JSON:
{ "results": [ { "signalIndex": <number>, "attributeIds": [<int>, ...] } ] }

Rules:
- ONLY return ids from the vocabulary above. Do NOT invent new ids or terms.
- Be conservative: only include an attribute if the post text actually evokes it.
- If no attributes match, use "attributeIds": [].
- Include one results object per input signal (in the same order), even if empty.
- Do not add commentary, only valid JSON.`;
}

interface ExtractionResult {
  signalIndex: number;
  attributeIds: number[];
}

async function callGpt(
  signals: TpRawSignal[],
  systemPrompt: string
): Promise<ExtractionResult[]> {
  const inputLines = signals.map((s, i) => {
    const text = [s.text, ...(s.hashtags ?? [])]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);
    return `[${i}] platform=${s.platform} text=${JSON.stringify(text)}`;
  });

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: inputLines.join("\n") },
    ],
  });

  const raw = response.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(raw) as
    | { results?: ExtractionResult[] }
    | ExtractionResult[];
  if (Array.isArray(parsed)) return parsed;
  if (parsed.results && Array.isArray(parsed.results)) return parsed.results;
  // Tolerate any single-array-valued key.
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (Array.isArray(v)) return v as ExtractionResult[];
  }
  return [];
}

/**
 * For each signal, look up the categories whose tagged entities co-occur in
 * the signal. For each (signal, category) pair (not already cached) run a
 * vocab-restricted LLM pass and persist matched (signal, attribute) rows.
 *
 * Best-effort: per-pair LLM failures are logged and skipped without
 * propagating to the caller, so a flaky attribute pass never poisons the
 * entity extraction pipeline.
 */
export async function extractAttributesForBatch(
  companyId: number,
  signals: TpRawSignal[]
): Promise<{ pairsProcessed: number; rowsInserted: number }> {
  if (signals.length === 0) return { pairsProcessed: 0, rowsInserted: 0 };
  if (!process.env.OPENAI_API_KEY) {
    return { pairsProcessed: 0, rowsInserted: 0 };
  }

  const cats = await storage.getCategoriesWithVocab(companyId);
  const vocabBearing = cats.filter((c) => c.attributes.length > 0);
  if (vocabBearing.length === 0) return { pairsProcessed: 0, rowsInserted: 0 };
  const vocabByCat = new Map(vocabBearing.map((c) => [c.id, c]));

  const signalIds = signals.map((s) => s.id);
  const sigCatMap = await storage.getSignalCategoryMap(signalIds);

  // Build (categoryId -> signals) groups, skipping cached pairs.
  const cached = await storage.getCachedAttributeSignalPairs(
    signalIds,
    Array.from(vocabByCat.keys())
  );

  const groups = new Map<number, TpRawSignal[]>();
  for (const sig of signals) {
    const catIds = sigCatMap.get(sig.id);
    if (!catIds || catIds.size === 0) continue;
    for (const cid of catIds) {
      if (!vocabByCat.has(cid)) continue;
      if (cached.has(`${sig.id}:${cid}`)) continue;
      const list = groups.get(cid) ?? [];
      list.push(sig);
      groups.set(cid, list);
    }
  }

  let pairsProcessed = 0;
  let rowsInserted = 0;

  for (const [categoryId, sigs] of groups) {
    const cat = vocabByCat.get(categoryId)!;
    const allowedIds = new Set(cat.attributes.map((a) => a.id));
    const systemPrompt = buildPrompt(
      cat.label,
      cat.attributes.map((a) => ({ id: a.id, attribute: a.attribute }))
    );

    const CHUNK = 20;
    for (let i = 0; i < sigs.length; i += CHUNK) {
      const chunk = sigs.slice(i, i + CHUNK);
      let results: ExtractionResult[] = [];
      let attempts = 0;
      while (attempts < 3) {
        try {
          results = await callGpt(chunk, systemPrompt);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 3) {
            logger.warn(
              { err, companyId, categoryId, chunkSize: chunk.length },
              "Attribute extraction GPT call failed after retries; skipping chunk"
            );
            results = [];
            break;
          }
          await new Promise((r) => setTimeout(r, 1000 * attempts));
        }
      }

      const toInsert: InsertTpAttributeSignal[] = [];
      // Count matches per signal in this chunk so we can stamp the
      // extraction-log sentinel for every processed pair (including
      // zero-match), not just the ones that produced rows.
      const matchCountBySignalId = new Map<number, number>();
      for (const sig of chunk) matchCountBySignalId.set(sig.id, 0);

      for (const r of results) {
        const signal = chunk[r.signalIndex];
        if (!signal) continue;
        const ids = Array.isArray(r.attributeIds) ? r.attributeIds : [];
        const dedup = Array.from(new Set(ids)).filter((id) =>
          allowedIds.has(Number(id))
        );
        for (const attributeId of dedup) {
          toInsert.push({
            companyId,
            rawSignalId: signal.id,
            categoryId,
            attributeId: Number(attributeId),
            postedAt: signal.postedAt ?? signal.capturedAt,
          });
        }
        matchCountBySignalId.set(
          signal.id,
          (matchCountBySignalId.get(signal.id) ?? 0) + dedup.length
        );
        pairsProcessed += 1;
      }

      if (toInsert.length > 0) {
        const inserted = await storage.bulkInsertAttributeSignals(toInsert);
        rowsInserted += inserted;
      }

      // Stamp the sentinel cache for every signal in the chunk so subsequent
      // runs skip them even when nothing matched. We log the entire chunk —
      // not just signals the LLM returned — because if the model omitted a
      // signal it effectively returned zero matches for it.
      await storage.logAttributeExtractionPairs(
        companyId,
        chunk.map((s) => ({
          rawSignalId: s.id,
          categoryId,
          matchCount: matchCountBySignalId.get(s.id) ?? 0,
        }))
      );
    }
  }

  logger.info(
    { companyId, pairsProcessed, rowsInserted },
    "Attribute extraction batch done"
  );
  return { pairsProcessed, rowsInserted };
}
