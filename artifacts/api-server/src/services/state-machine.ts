import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
import { computeDeltasForCompany } from "./deltas.js";
import {
  confirmationVerdict,
  buildGateInput,
  gateConfigFromPipeline,
} from "./confirmation-gate.js";
import { judgeSpecificityBatch, type SpecificityResult } from "./specificity.js";
import { withDbRetry } from "./db-retry.js";
import type { TpEntityState, TpEntityTimeseries, TpPipelineConfig } from "@workspace/db";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

type TrendState =
  | "candidate"   // seen < 3 times
  | "emerging"    // consistent growth, not yet confirmed
  | "confirmed"   // 3+ weeks of upward trend
  | "peaking"     // growth rate decelerating
  | "declining"   // week-over-week volume falling
  | "dormant"     // near-zero activity
  | "resurgent";  // dormant → positive growth again

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function sumMentions(rows: TpEntityTimeseries[], lastNDays: number): number {
  const cutoff = new Date(Date.now() - lastNDays * 86400_000).toISOString().slice(0, 10);
  return rows
    .filter((r) => r.bucketDate >= cutoff)
    .reduce((s, r) => s + r.mentions, 0);
}

function weeklyBuckets(rows: TpEntityTimeseries[]): number[] {
  if (rows.length === 0) return [];
  // Sort ascending
  const sorted = [...rows].sort((a, b) => a.bucketDate.localeCompare(b.bucketDate));
  // Group into 7-day buckets
  const result: number[] = [];
  let weekSum = 0;
  let weekStart = sorted[0]!.bucketDate;
  for (const r of sorted) {
    const daysDiff = Math.floor(
      (new Date(r.bucketDate).getTime() - new Date(weekStart).getTime()) / 86400_000
    );
    if (daysDiff >= 7) {
      result.push(weekSum);
      weekStart = r.bucketDate;
      weekSum = 0;
    }
    weekSum += r.mentions;
  }
  result.push(weekSum);
  return result;
}

function growthRate(a: number, b: number): number {
  if (a === 0) return b > 0 ? 1 : 0;
  return (b - a) / a;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// State transition logic
// ---------------------------------------------------------------------------

interface Metrics {
  volume7d: number;
  volume30d: number;
  volume90d: number;
  velocity: number;   // avg daily mentions over last 7d
  growthWow: number;  // week-over-week growth rate
  growthMom: number;  // month-over-month growth rate
  volatility: number; // std dev of weekly buckets
}

function computeMetrics(rows: TpEntityTimeseries[]): Metrics {
  const v7 = sumMentions(rows, 7);
  const v30 = sumMentions(rows, 30);
  const v90 = sumMentions(rows, 90);
  const velocity = v7 / 7;

  const weeks = weeklyBuckets(rows);
  const last2 = weeks.slice(-2);
  const last5 = weeks.slice(-5);

  const prevWeek = last2.length >= 2 ? last2[0]! : 0;
  const thisWeek = last2.length >= 1 ? last2[last2.length - 1]! : 0;
  const growthWow = growthRate(prevWeek, thisWeek);

  const prevMonth = v30 > 0 ? (v90 - v30) / 2 : 0; // rough proxy for prior 30d
  const growthMom = growthRate(prevMonth, v30);

  const volatility = stdDev(last5);

  return { volume7d: v7, volume30d: v30, volume90d: v90, velocity, growthWow, growthMom, volatility };
}

function determineNextState(
  current: TrendState,
  metrics: Metrics,
  config: TpPipelineConfig
): { state: TrendState; reason: string } {
  const { volume7d, volume30d, growthWow, growthMom } = metrics;

  // Thresholds from config
  const minWow = config.candidateToEmergingMinWowGrowth;
  const minVol = config.candidateToEmergingMinVolume;
  const decliningThresh = -(minWow * 0.8);  // e.g. -0.24 if minWow=0.3
  const dormantVol7 = 0;
  const dormantVol30 = Math.max(1, Math.floor(minVol / 3));

  // Dormant: almost no recent activity
  if (volume7d <= dormantVol7 && volume30d < dormantVol30) {
    return { state: "dormant", reason: `v7d=${volume7d} v30d=${volume30d}<${dormantVol30}` };
  }

  // Resurgent: was dormant, now seeing activity
  if (current === "dormant" && growthWow > minWow && volume7d >= Math.ceil(minVol / 3)) {
    return { state: "resurgent", reason: `dormant→resurgent growthWow=${growthWow.toFixed(2)}` };
  }

  // Candidate: very low total volume
  if (volume30d < dormantVol30) {
    return { state: "candidate", reason: `volume30d=${volume30d}<${dormantVol30}` };
  }

  // Declining: shrinking on BOTH weekly AND monthly windows.
  //
  // Previously this only checked growthWow, so a normal quiet week inside a
  // strongly rising month read as "declining" — ashwagandha (growthWow=-0.44,
  // growthMom=+1.25) and dark chocolate (-0.57, +1.33) both ended up on the
  // radar as "declining" while the confirmation gate correctly said they were
  // rising, because the gate reads the full 180-day series and this rule was
  // reading one 7-day window in isolation. A trend truly declining does so on
  // both timescales; requiring both prevents the state machine from
  // contradicting the gate on a routine weekly wobble.
  if (
    growthWow < decliningThresh &&
    growthMom < decliningThresh &&
    volume30d >= Math.ceil(minVol / 2)
  ) {
    return { state: "declining", reason: `growthWow=${growthWow.toFixed(2)} growthMom=${growthMom.toFixed(2)} both<${decliningThresh.toFixed(2)}` };
  }

  // Exit from declining. Every other state has an entry rule and this one
  // did not have an exit, so once the weekly-only declining rule marked an
  // entity, it could not get out: the confirmed rule requires growthWow >= 0
  // and the emerging rule requires growthWow > minWow*0.35, but a real trend
  // in a normal quiet week has a negative growthWow. The fallback then kept it
  // declining forever. Explicit exit: a declining entity with a solid positive
  // MoM is no longer declining, regardless of the current week's wobble.
  if (current === "declining" && growthMom > minWow && volume30d >= Math.ceil(minVol / 2)) {
    // Which non-declining state to send it to depends on how loudly it is rising
    // right now, mirroring the fresh-entity rules below.
    if (growthWow >= 0 && volume30d >= minVol) {
      return { state: "confirmed", reason: `declining→confirmed growthMom=${growthMom.toFixed(2)} v30=${volume30d}` };
    }
    return { state: "emerging", reason: `declining→emerging growthMom=${growthMom.toFixed(2)} growthWow=${growthWow.toFixed(2)}` };
  }

  // Peaking: growth decelerating (was high, now slowing)
  if (
    (current === "confirmed" || current === "peaking") &&
    growthWow < minWow * 0.2 &&
    growthMom > minWow * 0.3
  ) {
    return { state: "peaking", reason: `peaking growthWow=${growthWow.toFixed(2)} growthMom=${growthMom.toFixed(2)}` };
  }

  // Confirmed: strong sustained growth
  if (growthMom > minWow && volume30d >= minVol && growthWow >= 0) {
    return { state: "confirmed", reason: `confirmed growthMom=${growthMom.toFixed(2)} v30=${volume30d}` };
  }

  // Emerging: early growth signal
  if (growthWow > minWow * 0.35 && volume30d >= dormantVol30) {
    return { state: "emerging", reason: `emerging growthWow=${growthWow.toFixed(2)} v30=${volume30d}` };
  }

  // Fallback: no change
  return { state: current, reason: "no transition criteria met" };
}

// ---------------------------------------------------------------------------
// Knowledge item creation / update
// ---------------------------------------------------------------------------

async function ensureKnowledgeItem(
  companyId: number,
  entityStateId: number,
  entityState: TpEntityState,
  metrics: Metrics,
  minSignalStrength: number
): Promise<void> {
  const states: TrendState[] = ["emerging", "confirmed", "peaking", "resurgent"];
  if (!states.includes(entityState.state as TrendState)) return;

  const entity = (await withDbRetry("getEntities", () => storage.getEntities(companyId))).find(
    (e) => e.id === entityState.entityId
  );
  if (!entity) return;

  // Compute signal strength: 0-100 score based on volume + growth
  const signalStrength = Math.min(
    100,
    Math.round(
      (metrics.volume7d / 10) * 30 +
      Math.max(0, metrics.growthWow) * 40 +
      Math.max(0, metrics.growthMom) * 30
    )
  );

  const ki = await withDbRetry("upsertKnowledgeItem", () => storage.upsertKnowledgeItem({
    companyId,
    category: entity.entityType,
    topicLabel: entity.canonicalLabel,
    geographicScope: entityState.geography,
    type: entity.entityType,
    title: entity.canonicalLabel,
    summary: `${entity.canonicalLabel} (${entity.entityType}) — ${entityState.state} in ${entityState.geography}. v7d=${metrics.volume7d}, WoW=${(metrics.growthWow * 100).toFixed(1)}%`,
    status: entityState.state,
    archived: entityState.state === "dormant",
    signalStrength,
    evidenceCount: metrics.volume30d,
  } as any));

  if (!entityState.knowledgeItemId) {
    await withDbRetry("updateEntityState:knowledgeItemId", () =>
      storage.updateEntityState(entityStateId, { knowledgeItemId: ki.id } as any)
    );
  }
}

// ---------------------------------------------------------------------------
// Main state machine run
// ---------------------------------------------------------------------------

// A full run walks every entity (thousands) and is long-lived, so it straddles
// Neon dropping a connection. The pool now surfaces that as a thrown error
// rather than hanging (see lib/db), but one blip must not abandon a run that is
// most of the way done: retry the entity, then skip it and carry on.

export async function runStateMachine(
  companyId: number
): Promise<{ processed: number; transitions: number }> {
  // These three run before any per-entity work, and they were unprotected: a
  // single transient Neon blip on the heavy delta query killed a whole run at
  // startup, before a single entity was processed. Retry them like everything
  // else in the loop.
  const [entities, config, deltas] = await Promise.all([
    withDbRetry("getEntities:init", () => storage.getEntities(companyId)),
    withDbRetry("getPipelineConfig", () => storage.getPipelineConfig(companyId)),
    withDbRetry("computeDeltas", () => computeDeltasForCompany(companyId)),
  ]);
  const deltaByEntity = new Map(deltas.map((d) => [d.entityId, d]));
  let processed = 0;
  let transitions = 0;

  let skipped = 0;

  for (const entity of entities) {
    try {
    // Aggregate timeseries across all platforms and geographies for this entity
    const timeseries = await withDbRetry("getEntityTimeseries", () =>
      storage.getEntityTimeseries(entity.id, 90)
    );
    if (timeseries.length === 0) continue;

    // Group by geography
    const geoGroups = new Map<string, TpEntityTimeseries[]>();
    for (const row of timeseries) {
      const geo = row.geography ?? "Global";
      const list = geoGroups.get(geo) ?? [];
      list.push(row);
      geoGroups.set(geo, list);
    }

    for (const [geography, rows] of geoGroups) {
      const metrics = computeMetrics(rows);
      const entityState = await withDbRetry("getOrCreateEntityState", () =>
        storage.getOrCreateEntityState(companyId, entity.id, geography)
      );
      const currentState = entityState.state as TrendState;
      const { state: nextState, reason } = determineNextState(currentState, metrics, config);

      // MoM/YoY deltas are entity-wide (rolled up across platforms/geos for v1).
      // We assign the same delta values to every (entity, geography) state row.
      const delta = deltaByEntity.get(entity.id);

      const updated = await withDbRetry("updateEntityState:metrics", () =>
        storage.updateEntityState(entityState.id, {
        state: nextState,
        stateEnteredAt: nextState !== currentState ? new Date() : entityState.stateEnteredAt,
        lastTransitionReason: reason,
        volume7d: metrics.volume7d,
        volume30d: metrics.volume30d,
        volume90d: metrics.volume90d,
        velocity: metrics.velocity,
        growthWow: metrics.growthWow,
        growthMom: metrics.growthMom,
        volatility: metrics.volatility,
        platformsSeen: [...new Set(rows.map((r) => r.platform))],
        momGrowthPct: delta?.momGrowthPct ?? null,
        yoyGrowthPct: delta?.yoyGrowthPct ?? null,
        momCurrent: delta?.momCurrent ?? null,
        momPrior: delta?.momPrior ?? null,
        yoyCurrent: delta?.yoyCurrent ?? null,
        yoyPrior: delta?.yoyPrior ?? null,
      } as any)
      );

      if (nextState !== currentState) {
        transitions++;
        logger.info(
          { entityId: entity.id, label: entity.canonicalLabel, geography, from: currentState, to: nextState, reason },
          "State transition"
        );
      }

      // --- Confirmation gate (fourth stage) ---
      // Before surfacing a flagged candidate to the radar, require it to beat
      // its own noise (significance) and be broad-based (source diversity).
      // Only surfacing states are gated; the verdict is persisted for audit.
      const gateCfg = gateConfigFromPipeline(config);
      const surfacingStates: TrendState[] = ["emerging", "confirmed", "peaking", "resurgent"];
      let verdict: ReturnType<typeof confirmationVerdict> | null = null;
      let finalDecision: "pass" | "hold" | null = null;
      if (surfacingStates.includes(nextState)) {
        verdict = confirmationVerdict(buildGateInput(rows), gateCfg);
        finalDecision = verdict.decision;

        // Specificity check: only bother judging entities that PASSED significance
        // + breadth (a small set). A generic everyday term ("coffee", "salt")
        // gets held even if it's rising + broad. Cached per entity-state so the
        // LLM only runs once per label.
        let specificity: SpecificityResult | null =
          (entityState.specificityVerdict &&
          (entityState.specificityVerdict as any).label === entity.canonicalLabel
            ? {
                specific: (entityState.specificityVerdict as any).specific,
                reason: (entityState.specificityVerdict as any).reason,
              }
            : null);
        if (verdict.decision === "pass" && !specificity) {
          try {
            const judged = await judgeSpecificityBatch([entity.canonicalLabel]);
            specificity = judged.get(entity.canonicalLabel.toLowerCase()) ?? null;
          } catch (e) {
            logger.warn({ err: e, label: entity.canonicalLabel }, "specificity judge failed — keeping by default");
          }
          if (specificity) {
            // captured so the closure keeps the narrowed non-null type
            const spec = specificity;
            await withDbRetry("updateEntityState:specificity", () =>
              storage.updateEntityState(entityState.id, {
                specificityVerdict: {
                  specific: spec.specific,
                  reason: spec.reason,
                  label: entity.canonicalLabel,
                  judgedAt: new Date().toISOString(),
                },
              } as any)
            );
          }
        }
        if (verdict.decision === "pass" && specificity && !specificity.specific) {
          finalDecision = "hold";
          verdict.reasons.push(`not specific: ${specificity.reason}`);
        }

        const v = verdict;
        const decided = finalDecision;
        await withDbRetry("updateEntityState:verdict", () =>
          storage.updateEntityState(entityState.id, {
            confirmationVerdict: {
              decision: decided,
              reasons: v.reasons,
              significanceP: v.significance.pValue,
              entropyBits: v.breadth.entropyBits,
              evaluatedAt: new Date().toISOString(),
            },
          } as any)
        );
      } else if (entityState.confirmationVerdict) {
        // NOT a surfacing state, but a verdict from a previous run is still on
        // the row. Leaving it there makes the radar claim a pass the entity no
        // longer holds: `juneshine` sat on the radar for two days as "pass" on a
        // 46h-old verdict, evaluated back when it was still emerging. A verdict
        // only ever describes the state it was computed for, so clear it.
        await withDbRetry("updateEntityState:clearVerdict", () =>
          storage.updateEntityState(entityState.id, { confirmationVerdict: null } as any)
        );
      }

      if (finalDecision === "pass") {
        await ensureKnowledgeItem(companyId, entityState.id, updated, metrics, config.radarSurfaceMinSignalStrength);
      } else {
        // Gate HOLD. Holds must be retroactive: if this entity was surfaced to
        // the radar in an earlier run (before the gate/specificity check existed
        // or judged it), that stale knowledge item must be pulled back off the
        // radar so the radar always reflects the current verdict. Archiving
        // (not deleting) keeps the row for audit while removing it from the
        // trends list, which filters on `archived`.
        if (updated.knowledgeItemId) {
          await withDbRetry("updateKnowledgeItem:archive", () =>
            storage.updateKnowledgeItem(updated.knowledgeItemId!, {
              archived: true,
            } as any)
          );
        }
        // `verdict` is null when the entity is not in a surfacing state at all
        // (the gate never ran), so it must not be dereferenced here.
        logger.info(
          {
            entityId: entity.id,
            label: entity.canonicalLabel,
            geography,
            state: nextState,
            reasons: verdict ? verdict.reasons : [`not a surfacing state (${nextState})`],
          },
          "Not surfacing to radar"
        );
      }
      processed++;
    }
    } catch (err) {
      // Retries already exhausted for this entity. Skip it rather than abandon
      // the whole run: a partial pass over thousands of entities is far more
      // useful than none, and the next run picks the entity up again.
      skipped++;
      logger.warn(
        { err, entityId: entity.id, label: entity.canonicalLabel },
        "Entity failed after retries — skipping"
      );
    }
  }

  logger.info({ companyId, processed, transitions, skipped }, "State machine run complete");
  return { processed, transitions };
}
