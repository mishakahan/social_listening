import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
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

  // Declining: week-over-week shrinking beyond threshold
  if (growthWow < decliningThresh && volume30d >= Math.ceil(minVol / 2)) {
    return { state: "declining", reason: `growthWow=${growthWow.toFixed(2)}<${decliningThresh.toFixed(2)}` };
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

  const entity = (await storage.getEntities(companyId)).find(
    (e) => e.id === entityState.entityId && e.entityType === "trend"
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

  const ki = await storage.upsertKnowledgeItem({
    companyId,
    category: "trend",
    topicLabel: entity.canonicalLabel,
    geographicScope: entityState.geography,
    type: "trend",
    title: entity.canonicalLabel,
    summary: `${entity.canonicalLabel} — ${entityState.state} trend in ${entityState.geography}. v7d=${metrics.volume7d}, WoW=${(metrics.growthWow * 100).toFixed(1)}%`,
    status: entityState.state,
    archived: entityState.state === "dormant",
    signalStrength,
    evidenceCount: metrics.volume30d,
  } as any);

  if (!entityState.knowledgeItemId) {
    await storage.updateEntityState(entityStateId, { knowledgeItemId: ki.id } as any);
  }
}

// ---------------------------------------------------------------------------
// Main state machine run
// ---------------------------------------------------------------------------

export async function runStateMachine(
  companyId: number
): Promise<{ processed: number; transitions: number }> {
  const [entities, config] = await Promise.all([
    storage.getEntities(companyId),
    storage.getPipelineConfig(companyId),
  ]);
  let processed = 0;
  let transitions = 0;

  for (const entity of entities) {
    // Aggregate timeseries across all platforms and geographies for this entity
    const timeseries = await storage.getEntityTimeseries(entity.id, 90);
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
      const entityState = await storage.getOrCreateEntityState(companyId, entity.id, geography);
      const currentState = entityState.state as TrendState;
      const { state: nextState, reason } = determineNextState(currentState, metrics, config);

      const updated = await storage.updateEntityState(entityState.id, {
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
      } as any);

      if (nextState !== currentState) {
        transitions++;
        logger.info(
          { entityId: entity.id, label: entity.canonicalLabel, geography, from: currentState, to: nextState, reason },
          "State transition"
        );
      }

      await ensureKnowledgeItem(companyId, entityState.id, updated, metrics, config.radarSurfaceMinSignalStrength);
      processed++;
    }
  }

  logger.info({ companyId, processed, transitions }, "State machine run complete");
  return { processed, transitions };
}
