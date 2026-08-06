import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  boolean,
  doublePrecision,
  date,
  jsonb,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Group 1: Supporting tables (standalone mode equivalents)
// ---------------------------------------------------------------------------

// companies (standalone stub)
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// users (standalone stub)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// knowledge_items (standalone)
export const knowledgeItems = pgTable("knowledge_items", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  type: text("type").notNull().default("trend_signal"),
  title: text("title").notNull(),
  topicLabel: text("topic_label"),
  description: text("description"),
  summary: text("summary"),
  tags: jsonb("tags").$type<string[]>().default([]),
  signalStrength: integer("signal_strength").default(0),
  relevance: integer("relevance"),
  confidence: doublePrecision("confidence"),
  status: text("status").notNull().default("under_review"),
  geographicScope: text("geographic_scope"),
  timeHorizon: text("time_horizon"),
  originType: text("origin_type").default("bot_ingestion"),
  evidenceCount: integer("evidence_count").default(0),
  userValidated: boolean("user_validated").default(false),
  archived: boolean("archived").default(false),
  snoozedUntil: timestamp("snoozed_until"),
  flaggedAsNoise: boolean("flagged_as_noise").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// knowledge_evidence
export const knowledgeEvidence = pgTable("knowledge_evidence", {
  id: serial("id").primaryKey(),
  knowledgeItemId: integer("knowledge_item_id")
    .notNull()
    .references(() => knowledgeItems.id, { onDelete: "cascade" }),
  title: text("title"),
  source: text("source"),
  evidenceType: text("evidence_type"),
  audienceType: text("audience_type"),
  content: text("content"),
  sourceUrl: text("source_url"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Group 2: tp_* pipeline tables
// ---------------------------------------------------------------------------

// tp_seed_candidates
export const tpSeedCandidates = pgTable("tp_seed_candidates", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  payload: jsonb("payload")
    .notNull()
    .$type<
      Array<{
        label: string;
        description: string;
        geography: string;
        productCategoryLink: string;
        territoryTag: string;
        strategicCentrality: number;
        actionableAt: string;
        groundedIn: string[];
        watchTopic?: string;
        seedQueries: {
          language: string;
          keywords: string[];
          hashtags: string[];
        }[];
      }>
    >(),
  edits: jsonb("edits").$type<Record<string, any>>().default({}),
  status: text("status").notNull().default("draft"),
  briefSnapshot: text("brief_snapshot").notNull(),
  companyContextSnapshot: jsonb("company_context_snapshot").$type<
    Record<string, any>
  >(),
  // User-supplied strategic "watch topics" (title + short description) that
  // anchor seed generation. Optional — empty array means brief-only generation.
  watchTopicsSnapshot: jsonb("watch_topics_snapshot")
    .$type<Array<{ title: string; description: string }>>()
    .default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  committedAt: timestamp("committed_at"),
});

// tp_seed_items
export const tpSeedItems = pgTable("tp_seed_items", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  description: text("description"),
  geography: text("geography").notNull(),
  productCategoryLink: text("product_category_link"),
  territoryTag: text("territory_tag"),
  watchTopic: text("watch_topic"),
  strategicCentrality: integer("strategic_centrality").notNull().default(50),
  actionableAt: text("actionable_at"),
  groundedIn: jsonb("grounded_in").$type<string[]>().default([]),
  status: text("status").notNull().default("pending"),
  editedFromPayload: jsonb("edited_from_payload").$type<
    Record<string, any> | null
  >(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// tp_scout_queries
export const tpScoutQueries = pgTable("tp_scout_queries", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  seedItemId: integer("seed_item_id")
    .notNull()
    .references(() => tpSeedItems.id, { onDelete: "cascade" }),
  topicLabel: text("topic_label").notNull(),
  watchTopic: text("watch_topic"),
  geography: text("geography").notNull(),
  language: text("language").notNull(),
  keywords: jsonb("keywords").notNull().$type<string[]>(),
  hashtags: jsonb("hashtags").notNull().$type<string[]>(),
  active: boolean("active").notNull().default(false),
  scrapeCadence: text("scrape_cadence").notNull().default("daily"),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  totalSignalsFetched: integer("total_signals_fetched").notNull().default(0),
  totalSignalsUsable: integer("total_signals_usable").notNull().default(0),
  llmJustification: text("llm_justification"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// tp_actor_runs
export const tpActorRuns = pgTable("tp_actor_runs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  scoutQueryId: integer("scout_query_id").references(
    () => tpScoutQueries.id,
    { onDelete: "set null" }
  ),
  actorSlug: text("actor_slug").notNull(),
  platform: text("platform").notNull(),
  runMode: text("run_mode").notNull(),
  apifyRunId: text("apify_run_id"),
  apifyDatasetId: text("apify_dataset_id"),
  status: text("status").notNull().default("queued"),
  inputPayload: jsonb("input_payload").notNull().$type<Record<string, any>>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  recordsFetched: integer("records_fetched").notNull().default(0),
  recordsUsable: integer("records_usable").notNull().default(0),
  recordsDropped: integer("records_dropped").notNull().default(0),
  oldestPostedAt: timestamp("oldest_posted_at"),
  newestPostedAt: timestamp("newest_posted_at"),
  costUsd: doublePrecision("cost_usd"),
  errorMessage: text("error_message"),
  ingestionStatus: text("ingestion_status").notNull().default("pending"),
  // Stamped by markIngestionDone / markIngestionFailed every time ingestion
  // finishes — including re-ingestions that dedup to zero new rows. This is
  // the authoritative "when did we last process this run" timestamp; do NOT
  // confuse it with completedAt (Apify finish time, never re-set) or with
  // MAX(tp_raw_signals.captured_at) (only advances when NEW rows insert).
  ingestionCompletedAt: timestamp("ingestion_completed_at"),
  rawLog: jsonb("raw_log")
    .$type<Array<{ ts: string; level: string; msg: string }>>()
    .default([]),
  parentActorRunId: integer("parent_actor_run_id"),
  isTestFire: boolean("is_test_fire").notNull().default(false),
  // Groups runs created from a single Launch click (or cron-triggered launch).
  // Null for test fires and legacy/orphaned runs. See tp_launch_batches.
  launchBatchId: text("launch_batch_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Tracks each "launch batch" — a group of actor runs created together from a
// single Launch click (kind='manual') or a scheduled cron tick (kind='cron').
// Used to fire the post-batch chain (timeseries -> state machine) exactly once
// when all runs in the batch reach a terminal status.
export const tpLaunchBatches = pgTable("tp_launch_batches", {
  id: text("id").primaryKey(), // UUID generated app-side
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("manual"), // 'manual' | 'cron'
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at"),
  runsTotal: integer("runs_total").notNull().default(0),
});

// tp_raw_signals
export const tpRawSignals = pgTable(
  "tp_raw_signals",
  {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  actorRunId: integer("actor_run_id").references(() => tpActorRuns.id, {
    onDelete: "set null",
  }),
  scoutQueryId: integer("scout_query_id").references(
    () => tpScoutQueries.id,
    { onDelete: "set null" }
  ),
  platform: text("platform").notNull(),
  sourceActor: text("source_actor").notNull(),
  sourceId: text("source_id").notNull(),
  sourceUrl: text("source_url"),
  postedAt: timestamp("posted_at"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  authorHandle: text("author_handle"),
  authorFollowers: integer("author_followers"),
  authorTier: text("author_tier"),
  authorVerified: boolean("author_verified").default(false),
  text: text("text"),
  mediaUrls: jsonb("media_urls").$type<string[]>().default([]),
  hashtags: jsonb("hashtags").$type<string[]>().default([]),
  mentions: jsonb("mentions").$type<string[]>().default([]),
  language: text("language"),
  languageConfidence: doublePrecision("language_confidence"),
  geography: text("geography"),
  engagementLikes: integer("engagement_likes"),
  engagementComments: integer("engagement_comments"),
  engagementShares: integer("engagement_shares"),
  engagementViews: integer("engagement_views"),
  engagementSaves: integer("engagement_saves"),
  engagementScore: integer("engagement_score"),
  engagementComposite: doublePrecision("engagement_composite"),
  commercialIntent: boolean("commercial_intent").default(false),
  commercialIntentConfidence: doublePrecision("commercial_intent_confidence"),
  entityExtractionStatus: text("entity_extraction_status")
    .notNull()
    .default("pending"),
  entityExtractionAt: timestamp("entity_extraction_at"),
  backfillDerived: boolean("backfill_derived").notNull().default(false),
  retainReason: text("retain_reason"),
  raw: jsonb("raw").notNull().$type<Record<string, any>>(),
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tp_raw_signals_dedup_idx").on(t.companyId, t.platform, t.sourceId)]
);

// tp_categories (Task #4) — user-defined product/topic categories. Each
// category has its own attribute vocabulary (see tp_category_attributes).
// Entities are tagged with at most one category (tp_entities.category_id).
export const tpCategories = pgTable(
  "tp_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tp_categories_company_slug_idx").on(t.companyId, t.slug)]
);

// tp_entities
export const tpEntities = pgTable("tp_entities", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  canonicalLabel: text("canonical_label").notNull(),
  entityType: text("entity_type").notNull(),
  // Optional category tag (Task #4). NULL = uncategorized. Entities can be
  // moved between categories from the Entities Audit UI.
  categoryId: integer("category_id").references(() => tpCategories.id, {
    onDelete: "set null",
  }),
  aliases: jsonb("aliases").notNull().$type<string[]>().default([]),
  firstSeenAt: timestamp("first_seen_at"),
  lastSeenAt: timestamp("last_seen_at"),
  totalMentions: integer("total_mentions").notNull().default(0),
  deletedAt: timestamp("deleted_at"),
  deletedByUserId: integer("deleted_by_user_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  // One entity per label per company. Deliberately NOT keyed on entity_type:
  // the type is assigned per batch by the LLM and is not stable — the same word
  // comes back as ingredient, brand, format or flavour depending on the batch —
  // so including it in the key lets one real trend exist as several rows.
  // Measured before this index: 991 duplicate groups hiding ~3,046 mentions from
  // the gate; "gummy" alone existed six times and read as 55 mentions instead of
  // 140. For trend detection the label IS the trend, so the label is the key.
  (t) => [uniqueIndex("tp_entities_company_label_idx").on(t.companyId, t.canonicalLabel)]
);

// tp_category_attributes (Task #4) — controlled vocabulary of descriptors
// (adjectives, attribute terms) per category. The LLM attribute-extraction
// pass is restricted to this exact list per category.
export const tpCategoryAttributes = pgTable(
  "tp_category_attributes",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => tpCategories.id, { onDelete: "cascade" }),
    attribute: text("attribute").notNull(),
    // Optional grouping class ("flavor", "format", "occasion", etc.) — purely
    // for UI grouping; the extraction pass doesn't read it.
    attributeClass: text("attribute_class"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_category_attributes_unique_idx").on(
      t.companyId,
      t.categoryId,
      t.attribute
    ),
  ]
);

// tp_attribute_signals (Task #4) — per-signal extraction cache. One row per
// (signal, attribute) the LLM said matched. The (raw_signal_id, attribute_id)
// unique index prevents duplicates on re-extraction.
export const tpAttributeSignals = pgTable(
  "tp_attribute_signals",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    rawSignalId: integer("raw_signal_id")
      .notNull()
      .references(() => tpRawSignals.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => tpCategories.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => tpCategoryAttributes.id, { onDelete: "cascade" }),
    // postedAt copied from the source signal at insert so the aggregator can
    // bucket by day without a join (matches the co-occurrence pattern).
    postedAt: timestamp("posted_at").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_attribute_signals_unique_idx").on(
      t.rawSignalId,
      t.attributeId
    ),
    index("tp_attribute_signals_company_posted_idx").on(
      t.companyId,
      t.postedAt
    ),
    // Cache lookup key: "have we already extracted this (signal, category)?"
    index("tp_attribute_signals_signal_category_idx").on(
      t.rawSignalId,
      t.categoryId
    ),
  ]
);

// tp_attribute_extraction_log (Task #4) — sentinel cache of processed
// (raw_signal_id, category_id) pairs INCLUDING zero-match outcomes. Without
// this, signals that yield no attributes for a category would be re-sent to
// the LLM on every rerun (tp_attribute_signals only records matches).
export const tpAttributeExtractionLog = pgTable(
  "tp_attribute_extraction_log",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    rawSignalId: integer("raw_signal_id")
      .notNull()
      .references(() => tpRawSignals.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => tpCategories.id, { onDelete: "cascade" }),
    matchCount: integer("match_count").notNull().default(0),
    processedAt: timestamp("processed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_attribute_extraction_log_unique_idx").on(
      t.rawSignalId,
      t.categoryId
    ),
  ]
);

// tp_attribute_timeseries (Task #4) — daily rollup written by the
// runAttributeTimeseriesAggregation job.
export const tpAttributeTimeseries = pgTable(
  "tp_attribute_timeseries",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => tpCategories.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => tpCategoryAttributes.id, { onDelete: "cascade" }),
    bucketDate: date("bucket_date").notNull(),
    mentions: integer("mentions").notNull().default(0),
    uniqueAuthors: integer("unique_authors").notNull().default(0),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_attribute_timeseries_unique_idx").on(
      t.companyId,
      t.categoryId,
      t.attributeId,
      t.bucketDate
    ),
  ]
);

// tp_signal_entities
export const tpSignalEntities = pgTable("tp_signal_entities", {
  id: serial("id").primaryKey(),
  rawSignalId: integer("raw_signal_id")
    .notNull()
    .references(() => tpRawSignals.id, { onDelete: "cascade" }),
  entityId: integer("entity_id")
    .notNull()
    .references(() => tpEntities.id, { onDelete: "cascade" }),
  mentionTextSpan: text("mention_text_span"),
  sentiment: text("sentiment"),
  sentimentConfidence: doublePrecision("sentiment_confidence"),
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
});

// tp_entity_timeseries
export const tpEntityTimeseries = pgTable(
  "tp_entity_timeseries",
  {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  entityId: integer("entity_id")
    .notNull()
    .references(() => tpEntities.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  geography: text("geography").notNull(),
  territoryTag: text("territory_tag"),
  bucketDate: date("bucket_date").notNull(),
  mentions: integer("mentions").notNull().default(0),
  uniqueAuthors: integer("unique_authors").notNull().default(0),
  engagementSum: doublePrecision("engagement_sum").notNull().default(0),
  engagementMedian: doublePrecision("engagement_median").notNull().default(0),
  backfillDerived: boolean("backfill_derived").notNull().default(false),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tp_entity_timeseries_bucket_idx").on(t.entityId, t.platform, t.geography, t.bucketDate)]
);

// tp_keyword_interest — Google Trends search-interest time series.
// Stored separately from tp_raw_signals so aggregated 0-100 values don't
// pollute social-mentions counts.
export const tpKeywordInterest = pgTable(
  "tp_keyword_interest",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actorRunId: integer("actor_run_id").references(() => tpActorRuns.id, {
      onDelete: "set null",
    }),
    keyword: text("keyword").notNull(),
    geo: text("geo").notNull().default(""),
    bucketDate: date("bucket_date").notNull(),
    interestValue: integer("interest_value").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_keyword_interest_dedup_idx").on(
      t.companyId,
      t.keyword,
      t.geo,
      t.bucketDate
    ),
  ]
);

// tp_entity_state
export const tpEntityState = pgTable(
  "tp_entity_state",
  {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  entityId: integer("entity_id")
    .notNull()
    .references(() => tpEntities.id, { onDelete: "cascade" }),
  geography: text("geography").notNull(),
  territoryTag: text("territory_tag"),
  state: text("state").notNull().default("candidate"),
  stateEnteredAt: timestamp("state_entered_at").defaultNow().notNull(),
  lastTransitionReason: text("last_transition_reason"),
  volume7d: integer("volume_7d").notNull().default(0),
  volume30d: integer("volume_30d").notNull().default(0),
  volume90d: integer("volume_90d").notNull().default(0),
  velocity: doublePrecision("velocity").notNull().default(0),
  growthWow: doublePrecision("growth_wow").notNull().default(0),
  growthMom: doublePrecision("growth_mom").notNull().default(0),
  // Fixed-window deltas computed off tp_entity_timeseries on every state-machine
  // run. Stored as a fraction (0.31 = +31%); UI multiplies by 100 for display.
  // Null when there is insufficient prior-window history (see services/deltas.ts).
  // - momGrowthPct: sum(mentions, last 30d) / sum(prior 30d) - 1
  // - yoyGrowthPct: sum(mentions, last 90d) / sum(365–455d ago) - 1
  momGrowthPct: doublePrecision("mom_growth_pct"),
  yoyGrowthPct: doublePrecision("yoy_growth_pct"),
  // Numerator/denominator snapshots so the UI tooltip can show the underlying
  // counts ("412 mentions in last 90d vs 165 in May 2025") without re-querying.
  momCurrent: integer("mom_current"),
  momPrior: integer("mom_prior"),
  yoyCurrent: integer("yoy_current"),
  yoyPrior: integer("yoy_prior"),
  // Long-tail manual promotion (Task #2). When true, the entity surfaces on
  // the main radar even if its volume sits below the noise floor — used after
  // a user clicks "Promote to radar" on a long-tail Bayesian-uplift candidate.
  // The promote endpoint also creates/links a knowledge item so the entity
  // shows up in getTrendsEnriched immediately.
  manuallyPromoted: boolean("manually_promoted").notNull().default(false),
  volatility: doublePrecision("volatility").notNull().default(0),
  platformsSeen: jsonb("platforms_seen").notNull().$type<string[]>().default([]),
  knowledgeItemId: integer("knowledge_item_id").references(
    () => knowledgeItems.id,
    { onDelete: "set null" }
  ),
  sourceSeedItemIds: jsonb("source_seed_item_ids")
    .notNull()
    .$type<number[]>()
    .default([]),
  sourceSeedItemFirstSeenAt: jsonb("source_seed_item_first_seen_at")
    .notNull()
    .$type<Record<string, string>>()
    .default({}),
  // Confirmation gate verdict (fourth-stage check). Nullable + additive:
  // null means the gate has not evaluated this state yet, or is disabled.
  // decision "hold" means the candidate did not surface to the radar.
  confirmationVerdict: jsonb("confirmation_verdict").$type<{
    decision: "pass" | "hold";
    reasons: string[];
    significanceP: number;
    entropyBits: number;
    evaluatedAt: string;
  }>(),
  // Cached specificity judgment (LLM) so it's not re-judged every run. Keyed
  // implicitly by this entity-state row; cleared if the entity's label changes.
  specificityVerdict: jsonb("specificity_verdict").$type<{
    specific: boolean;
    reason: string;
    label: string;
    judgedAt: string;
  }>(),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tp_entity_state_geo_idx").on(t.entityId, t.geography)]
);

// tp_entity_synonyms
export const tpEntitySynonyms = pgTable("tp_entity_synonyms", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  canonicalLabel: text("canonical_label").notNull(),
  language: text("language"),
  entityType: text("entity_type").notNull(),
  source: text("source").notNull().default("auto"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Entity-type taxonomy used by the Control Panel + LLM extraction prompt.
// Stored as a JSONB array on tp_pipeline_config.entityTypes so each company can
// customise the types it tracks.
export interface EntityTypeConfig {
  id: string;            // machine name written to tp_entities.entity_type (e.g. "ingredient")
  label: string;         // display name (e.g. "Ingredient")
  description: string;   // short rationale shown in UI and LLM prompt
  examples: string;      // comma-separated examples shown in UI and LLM prompt
  color: string;         // tailwind utility classes for the type chip
}

export const DEFAULT_ENTITY_TYPES: EntityTypeConfig[] = [
  {
    id: "ingredient",
    label: "Ingredient",
    description: "Raw inputs — anchor for ingredient-led innovation.",
    examples: "maca, hazelnut, oat milk, sea salt",
    color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  },
  {
    id: "flavour",
    label: "Flavour",
    description: "Taste profiles — confectionery moves on flavour.",
    examples: "salted caramel, yuzu, smoky, floral",
    color: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
  },
  {
    id: "format",
    label: "Format",
    description: "Physical product format. Format-shifts are key signals.",
    examples: "bar, pastille, gummy, hot chocolate, lozenge",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  },
  {
    id: "packaging",
    label: "Packaging",
    description: "Container or presentation.",
    examples: "tin, gift box, advent calendar, plastic-free",
    color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  },
  {
    id: "functional_benefit",
    label: "Functional benefit",
    description: "Physiological claims — functional health focal territory.",
    examples: "gut health, focus, sleep, energy, immunity",
    color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  },
  {
    id: "emotional_benefit",
    label: "Emotional benefit",
    description: "Emotional payoffs — clusters here drive concept work.",
    examples: "nostalgia, comfort, ritual, treat, self-care",
    color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  },
  {
    id: "occasion",
    label: "Occasion",
    description: "Usage moments and events — gifting culture focal territory.",
    examples: "Christmas, Easter, hostess, post-workout, midnight",
    color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  },
  {
    id: "provenance",
    label: "Provenance",
    description: "Origin or heritage — premium positioning lever.",
    examples: "Piedmontese, Sicilian, Modica, single-origin Madagascar",
    color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  },
  {
    id: "dietary_claim",
    label: "Dietary claim",
    description: "Dietary positioning — increasingly entire trend spaces.",
    examples: "vegan, gluten-free, no added sugar, keto, organic",
    color: "bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300",
  },
  {
    id: "brand",
    label: "Brand",
    description: "Brand or maker names — competitive intel and co-mention graphs.",
    examples: "Lindt, Venchi, Caffarel, Pastiglie Leone",
    color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  },
  {
    id: "segment",
    label: "Segment",
    description: "Audience, persona, or tribe.",
    examples: "Gen Z, kidult, parents, fitness, expats",
    color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  },
  {
    id: "aesthetic_tag",
    label: "Aesthetic tag",
    description: "TikTok-native aesthetics and meme labels — where TikTok-native trends live.",
    examples: "dopamine snack, girl dinner, *-core suffixes, kawaii",
    color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  },
  {
    id: "other",
    label: "Other",
    description: "Escape hatch — use only if no other type fits. Do not force-fit.",
    examples: "",
    color: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300",
  },
];

// tp_pipeline_config
export const tpPipelineConfig = pgTable("tp_pipeline_config", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  // Tier 1
  noiseFloor: integer("noise_floor").notNull().default(3),
  commercialIntentThreshold: doublePrecision("commercial_intent_threshold")
    .notNull()
    .default(0.75),
  languageConfidenceThreshold: doublePrecision("language_confidence_threshold")
    .notNull()
    .default(0.7),
  engagementWeights: jsonb("engagement_weights")
    .notNull()
    .$type<Record<string, Record<string, number>>>()
    .default({
      instagram: { likes: 1, comments: 3, shares: 5, views: 0.1 },
      tiktok: { likes: 1, comments: 5, shares: 3, views: 0.05 },
      reddit: { score: 1, comments: 2, shares: 0, views: 0 },
      xiaohongshu: { likes: 1, comments: 3, shares: 2, views: 0.1, saves: 4 },
      google_trends: { views: 1, likes: 0, comments: 0, shares: 0 },
    }),
  authorTierWeights: jsonb("author_tier_weights")
    .notNull()
    .$type<Record<string, number>>()
    .default({ nano: 0.5, micro: 1.0, mid: 1.5, macro: 2.0 }),
  scrapeDepthLimits: jsonb("scrape_depth_limits")
    .notNull()
    .$type<Record<string, number>>()
    .default({
      instagram_hashtag: 500,
      tiktok: 1000,
      reddit: 500,
      xiaohongshu: 300,
      google_trends: 1,
    }),
  // Tier 2
  dedupCosineThreshold: doublePrecision("dedup_cosine_threshold")
    .notNull()
    .default(0.8),
  candidateToEmergingMinWeeks: integer("candidate_to_emerging_min_weeks")
    .notNull()
    .default(2),
  candidateToEmergingMinWowGrowth: doublePrecision(
    "candidate_to_emerging_min_wow_growth"
  )
    .notNull()
    .default(0.3),
  candidateToEmergingMinVolume: integer("candidate_to_emerging_min_volume")
    .notNull()
    .default(9),
  crossSourceCoOccurrenceMultiplier: doublePrecision(
    "cross_source_co_occurrence_multiplier"
  )
    .notNull()
    .default(0.3),
  scrapeCadence: jsonb("scrape_cadence")
    .notNull()
    .$type<Record<string, string>>()
    .default({
      instagram_hashtag: "daily",
      tiktok: "daily",
      reddit: "3x_week",
      xiaohongshu: "daily",
      google_trends: "weekly",
    }),
  volatilityTolerance: doublePrecision("volatility_tolerance")
    .notNull()
    .default(1.5),
  minEvidenceForKnowledgeItem: integer("min_evidence_for_knowledge_item")
    .notNull()
    .default(5),
  // Tier 3
  peakingWeeksNegVelocity: integer("peaking_weeks_neg_velocity")
    .notNull()
    .default(2),
  decliningWeeksNegVelocity: integer("declining_weeks_neg_velocity")
    .notNull()
    .default(3),
  dormantThresholdWeeks: integer("dormant_threshold_weeks").notNull().default(4),
  baselineWindowDays: integer("baseline_window_days").notNull().default(30),
  baselineExclusionDays: integer("baseline_exclusion_days").notNull().default(7),
  radarSurfaceMinSignalStrength: integer("radar_surface_min_signal_strength")
    .notNull()
    .default(40),
  platformWeights: jsonb("platform_weights")
    .notNull()
    .$type<Record<string, number>>()
    .default({
      instagram: 1,
      tiktok: 1,
      reddit: 1,
      xiaohongshu: 1,
      google_trends: 1,
    }),
  // Budget
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd").notNull().default(500),
  monthlyBudgetSoftPctWarning: integer("monthly_budget_soft_pct_warning")
    .notNull()
    .default(80),
  monthlyBudgetHardPctBlock: integer("monthly_budget_hard_pct_block")
    .notNull()
    .default(100),
  budgetOverrideUntil: timestamp("budget_override_until"),
  // Author allowlist
  authorAllowlist: jsonb("author_allowlist")
    .notNull()
    .$type<string[]>()
    .default([]),
  // Core vocabulary — generic category words for this company that should
  // NEVER be surfaced as a trend (e.g. "chocolate", "pizza", "gelato" for a
  // confectionery client). Filtered at extraction time AND hidden from the
  // radar list. Case-insensitive exact-match on the entity's canonical label.
  coreVocabulary: jsonb("core_vocabulary")
    .notNull()
    .$type<string[]>()
    .default([]),
  // Platform enables
  platforms: jsonb("platforms")
    .notNull()
    .$type<Record<string, { enabled: boolean }>>()
    .default({
      instagram: { enabled: true },
      tiktok: { enabled: true },
      reddit: { enabled: true },
      xiaohongshu: { enabled: true },
      google_trends: { enabled: true },
    }),
  // Entity-extraction taxonomy (used to build the LLM prompt and to render
  // entity-type chips/filters in the UI). Editable from the Control Panel.
  entityTypes: jsonb("entity_types")
    .notNull()
    .$type<EntityTypeConfig[]>()
    .default(DEFAULT_ENTITY_TYPES),
  // Scout-pull cron schedule (per company)
  // cadence: 'manual' | 'weekly' | 'biweekly' | 'monthly'
  scoutPullCadence: text("scout_pull_cadence").notNull().default("weekly"),
  // 0 = Sunday, 1 = Monday, ..., 6 = Saturday (UTC)
  scoutPullDow: integer("scout_pull_dow").notNull().default(1),
  scoutPullHourUtc: integer("scout_pull_hour_utc").notNull().default(6),
  // Last time the scout-launch fired for this company (manual or cron)
  lastScoutPullAt: timestamp("last_scout_pull_at"),
  // Last time runTimeseriesAggregation / runStateMachine completed for this company
  lastTimeseriesRunAt: timestamp("last_timeseries_run_at"),
  lastStateMachineRunAt: timestamp("last_state_machine_run_at"),
  // Long-tail Bayesian-uplift lane (Task #2). Knobs + last-run stamp.
  // longTailMinMentions: absolute floor on current 30d mentions for an entity
  //   to even be considered as a long-tail candidate (default 5; range 1-100).
  // longTailMinPosterior: Bayesian posterior P(true rate >= 2x baseline)
  //   required to surface (default 0.9; range 0.5-0.99).
  longTailMinMentions: integer("long_tail_min_mentions").notNull().default(5),
  longTailMinPosterior: doublePrecision("long_tail_min_posterior")
    .notNull()
    .default(0.9),
  lastLongTailRunAt: timestamp("last_long_tail_run_at"),
  // Composite co-occurrence lane (Task #3). Knobs + last-run stamp.
  // compositeMinJointMentions: minimum number of distinct signals that must
  //   co-mention both entities in the window to be considered a candidate
  //   pair (default 5; range 2-100).
  // compositeMinLift: minimum lift = joint / expected required to surface
  //   the pair (default 2.0; range 1.0-50.0).
  // compositeWindowDays: rolling window length for joint/expected/lift
  //   computation (default 14; range 7-90).
  compositeMinJointMentions: integer("composite_min_joint_mentions")
    .notNull()
    .default(5),
  compositeMinLift: doublePrecision("composite_min_lift")
    .notNull()
    .default(2.0),
  compositeWindowDays: integer("composite_window_days").notNull().default(14),
  lastCoOccurrenceRunAt: timestamp("last_co_occurrence_run_at"),
  // Category-scoped attribute extraction lane (Task #4).
  lastAttributeAggregationAt: timestamp("last_attribute_aggregation_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// tp_entity_co_occurrences — one row per (signal, entityA, entityB) where
// entityA.id < entityB.id (unordered pair convention enforced at insert).
// Written from entity-extraction.ts in the same transaction as
// tp_signal_entities so a failure rolls both back. Cascades on signal /
// entity delete so cleanup is automatic.
// ---------------------------------------------------------------------------
export const tpEntityCoOccurrences = pgTable(
  "tp_entity_co_occurrences",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    rawSignalId: integer("raw_signal_id")
      .notNull()
      .references(() => tpRawSignals.id, { onDelete: "cascade" }),
    entityAId: integer("entity_a_id")
      .notNull()
      .references(() => tpEntities.id, { onDelete: "cascade" }),
    entityBId: integer("entity_b_id")
      .notNull()
      .references(() => tpEntities.id, { onDelete: "cascade" }),
    // postedAt = signal.postedAt ?? signal.capturedAt at insert time so the
    // window filter is robust even for platforms with null posted_at.
    postedAt: timestamp("posted_at").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_entity_co_occurrences_unique_idx").on(
      t.rawSignalId,
      t.entityAId,
      t.entityBId
    ),
    // Defense-in-depth: pair ordering is also enforced at insert time by the
    // sort in bulkInsertSignalEntitiesAndCoOccurrences, but the DB check
    // guarantees no alternate writer (manual SQL, future job) can split
    // counts across (a,b) and (b,a) rows and corrupt the lift math.
    check(
      "tp_entity_co_occurrences_order_chk",
      sql`${t.entityAId} < ${t.entityBId}`
    ),
    // Hot path for the weekly aggregator: scan by company + window of
    // posted_at, then group by pair. Without this Postgres falls back to a
    // full-table scan as the table grows.
    index("tp_entity_co_occurrences_company_posted_idx").on(
      t.companyId,
      t.postedAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// tp_composite_trend_candidates — output of the co-occurrence aggregator.
// Snapshot-replace pattern (same as tp_long_tail_candidates): the most recent
// run for a company replaces prior rows in a single transaction.
// ---------------------------------------------------------------------------
export const tpCompositeTrendCandidates = pgTable(
  "tp_composite_trend_candidates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    entityAId: integer("entity_a_id")
      .notNull()
      .references(() => tpEntities.id, { onDelete: "cascade" }),
    entityBId: integer("entity_b_id")
      .notNull()
      .references(() => tpEntities.id, { onDelete: "cascade" }),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    jointCount: integer("joint_count").notNull(),
    // Prior-window joint count for the same pair (window immediately
    // preceding `windowStart`, same length). Used by the UI to show a
    // current-vs-prior delta. Zero when the pair didn't co-occur in the
    // prior window.
    priorJointCount: integer("prior_joint_count").notNull().default(0),
    countA: integer("count_a").notNull(),
    countB: integer("count_b").notNull(),
    totalSignals: integer("total_signals").notNull(),
    expectedCount: doublePrecision("expected_count").notNull(),
    lift: doublePrecision("lift").notNull(),
    // Daily joint-count series across the current window (oldest → newest,
    // length = compositeWindowDays). Stored as JSON to keep the read path a
    // single query — re-deriving on every GET would be wasteful.
    sparkline: jsonb("sparkline")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_composite_trend_candidates_unique_idx").on(
      t.companyId,
      t.entityAId,
      t.entityBId,
      t.computedAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// tp_long_tail_candidates — output of the Beta-Binomial uplift evaluator.
// One row per (company, entity) per run; each run shares a single
// computedAt timestamp. The unique index allows a history of snapshots.
// GET endpoint returns rows from the most recent computedAt for the company.
// ---------------------------------------------------------------------------
export const tpLongTailCandidates = pgTable(
  "tp_long_tail_candidates",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    entityId: integer("entity_id")
      .notNull()
      .references(() => tpEntities.id, { onDelete: "cascade" }),
    // YYYY-MM-DD window bounds for the current measurement period.
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    currentMentions: integer("current_mentions").notNull(),
    baselineMentions: integer("baseline_mentions").notNull(),
    // "yoy" when prior-year same-30d-window had data; "prior_window" when
    // we fell back to the immediately preceding 30d (most common for
    // companies without a year of history yet).
    baselineKind: text("baseline_kind").notNull(),
    // currentMentions / max(baselineMentions, 1). Pure ratio, no smoothing.
    upliftScore: doublePrecision("uplift_score").notNull(),
    // P(true rate >= 2x baseline) under Beta(1,1) prior on the proportion
    // p = current / (current + baseline). Computed via the regularized
    // incomplete beta function in services/long-tail.ts (no sampling).
    posteriorProb: doublePrecision("posterior_prob").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tp_long_tail_candidates_unique_idx").on(
      t.companyId,
      t.entityId,
      t.computedAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const companiesRelations = relations(companies, ({ many }) => ({
  tpSeedCandidates: many(tpSeedCandidates),
  tpSeedItems: many(tpSeedItems),
  tpScoutQueries: many(tpScoutQueries),
  tpActorRuns: many(tpActorRuns),
  tpRawSignals: many(tpRawSignals),
  tpEntities: many(tpEntities),
  tpEntityTimeseries: many(tpEntityTimeseries),
  tpEntityState: many(tpEntityState),
  tpEntitySynonyms: many(tpEntitySynonyms),
  knowledgeItems: many(knowledgeItems),
}));

export const tpSeedItemsRelations = relations(tpSeedItems, ({ one, many }) => ({
  company: one(companies, {
    fields: [tpSeedItems.companyId],
    references: [companies.id],
  }),
  tpScoutQueries: many(tpScoutQueries),
}));

export const tpScoutQueriesRelations = relations(
  tpScoutQueries,
  ({ one, many }) => ({
    company: one(companies, {
      fields: [tpScoutQueries.companyId],
      references: [companies.id],
    }),
    seedItem: one(tpSeedItems, {
      fields: [tpScoutQueries.seedItemId],
      references: [tpSeedItems.id],
    }),
    tpActorRuns: many(tpActorRuns),
    tpRawSignals: many(tpRawSignals),
  })
);

export const tpActorRunsRelations = relations(tpActorRuns, ({ one, many }) => ({
  company: one(companies, {
    fields: [tpActorRuns.companyId],
    references: [companies.id],
  }),
  scoutQuery: one(tpScoutQueries, {
    fields: [tpActorRuns.scoutQueryId],
    references: [tpScoutQueries.id],
  }),
  tpRawSignals: many(tpRawSignals),
}));

export const tpRawSignalsRelations = relations(
  tpRawSignals,
  ({ one, many }) => ({
    company: one(companies, {
      fields: [tpRawSignals.companyId],
      references: [companies.id],
    }),
    actorRun: one(tpActorRuns, {
      fields: [tpRawSignals.actorRunId],
      references: [tpActorRuns.id],
    }),
    scoutQuery: one(tpScoutQueries, {
      fields: [tpRawSignals.scoutQueryId],
      references: [tpScoutQueries.id],
    }),
    tpSignalEntities: many(tpSignalEntities),
  })
);

export const tpEntitiesRelations = relations(tpEntities, ({ one, many }) => ({
  company: one(companies, {
    fields: [tpEntities.companyId],
    references: [companies.id],
  }),
  tpSignalEntities: many(tpSignalEntities),
  tpEntityTimeseries: many(tpEntityTimeseries),
  tpEntityState: many(tpEntityState),
}));

export const tpEntityStateRelations = relations(
  tpEntityState,
  ({ one }) => ({
    company: one(companies, {
      fields: [tpEntityState.companyId],
      references: [companies.id],
    }),
    entity: one(tpEntities, {
      fields: [tpEntityState.entityId],
      references: [tpEntities.id],
    }),
    knowledgeItem: one(knowledgeItems, {
      fields: [tpEntityState.knowledgeItemId],
      references: [knowledgeItems.id],
    }),
  })
);

// ---------------------------------------------------------------------------
// Insert schemas and types
// ---------------------------------------------------------------------------

// companies
export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
});
export type Company = typeof companies.$inferSelect;
export type InsertCompany = z.infer<typeof insertCompanySchema>;

// users
export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

// knowledgeItems
export const insertKnowledgeItemSchema = createInsertSchema(
  knowledgeItems
).omit({ id: true });
export type KnowledgeItem = typeof knowledgeItems.$inferSelect;
export type InsertKnowledgeItem = z.infer<typeof insertKnowledgeItemSchema>;

// knowledgeEvidence
export const insertKnowledgeEvidenceSchema = createInsertSchema(
  knowledgeEvidence
).omit({ id: true });
export type KnowledgeEvidence = typeof knowledgeEvidence.$inferSelect;
export type InsertKnowledgeEvidence = z.infer<
  typeof insertKnowledgeEvidenceSchema
>;

// tpSeedCandidates
export const insertTpSeedCandidateSchema = createInsertSchema(
  tpSeedCandidates
).omit({ id: true });
export type TpSeedCandidate = typeof tpSeedCandidates.$inferSelect;
export type InsertTpSeedCandidate = z.infer<typeof insertTpSeedCandidateSchema>;

// tpSeedItems
export const insertTpSeedItemSchema = createInsertSchema(tpSeedItems).omit({
  id: true,
});
export type TpSeedItem = typeof tpSeedItems.$inferSelect;
export type InsertTpSeedItem = z.infer<typeof insertTpSeedItemSchema>;

// tpScoutQueries
export const insertTpScoutQuerySchema = createInsertSchema(
  tpScoutQueries
).omit({ id: true });
export type TpScoutQuery = typeof tpScoutQueries.$inferSelect;
export type InsertTpScoutQuery = z.infer<typeof insertTpScoutQuerySchema>;

// tpActorRuns
export const insertTpActorRunSchema = createInsertSchema(tpActorRuns).omit({
  id: true,
});
export type TpActorRun = typeof tpActorRuns.$inferSelect;
export type InsertTpActorRun = z.infer<typeof insertTpActorRunSchema>;

// tpLaunchBatches
export const insertTpLaunchBatchSchema = createInsertSchema(tpLaunchBatches);
export type TpLaunchBatch = typeof tpLaunchBatches.$inferSelect;
export type InsertTpLaunchBatch = z.infer<typeof insertTpLaunchBatchSchema>;

// tpRawSignals
export const insertTpRawSignalSchema = createInsertSchema(tpRawSignals).omit({
  id: true,
});
export type TpRawSignal = typeof tpRawSignals.$inferSelect;
export type InsertTpRawSignal = z.infer<typeof insertTpRawSignalSchema>;

// tpEntities
export const insertTpEntitySchema = createInsertSchema(tpEntities).omit({
  id: true,
});
export type TpEntity = typeof tpEntities.$inferSelect;
export type InsertTpEntity = z.infer<typeof insertTpEntitySchema>;

// tpSignalEntities
export const insertTpSignalEntitySchema = createInsertSchema(
  tpSignalEntities
).omit({ id: true });
export type TpSignalEntity = typeof tpSignalEntities.$inferSelect;
export type InsertTpSignalEntity = z.infer<typeof insertTpSignalEntitySchema>;

// tpEntityTimeseries
export const insertTpEntityTimeseriesSchema = createInsertSchema(
  tpEntityTimeseries
).omit({ id: true });
export type TpEntityTimeseries = typeof tpEntityTimeseries.$inferSelect;
export type InsertTpEntityTimeseries = z.infer<
  typeof insertTpEntityTimeseriesSchema
>;

// tpEntityState
export const insertTpEntityStateSchema = createInsertSchema(
  tpEntityState
).omit({ id: true });
export type TpEntityState = typeof tpEntityState.$inferSelect;
export type InsertTpEntityState = z.infer<typeof insertTpEntityStateSchema>;

// tpKeywordInterest
export const insertTpKeywordInterestSchema = createInsertSchema(
  tpKeywordInterest
).omit({ id: true });
export type TpKeywordInterest = typeof tpKeywordInterest.$inferSelect;
export type InsertTpKeywordInterest = z.infer<
  typeof insertTpKeywordInterestSchema
>;

// tpEntitySynonyms
export const insertTpEntitySynonymSchema = createInsertSchema(
  tpEntitySynonyms
).omit({ id: true });
export type TpEntitySynonym = typeof tpEntitySynonyms.$inferSelect;
export type InsertTpEntitySynonym = z.infer<typeof insertTpEntitySynonymSchema>;

// tpPipelineConfig — no serial id; primaryKey is companyId
export const insertTpPipelineConfigSchema =
  createInsertSchema(tpPipelineConfig);
export type TpPipelineConfig = typeof tpPipelineConfig.$inferSelect;
export type InsertTpPipelineConfig = z.infer<
  typeof insertTpPipelineConfigSchema
>;

// tpLongTailCandidates
export const insertTpLongTailCandidateSchema = createInsertSchema(
  tpLongTailCandidates
).omit({ id: true });

// tpEntityCoOccurrences (Task #3)
export const insertTpEntityCoOccurrenceSchema = createInsertSchema(
  tpEntityCoOccurrences
).omit({ id: true });
export type TpEntityCoOccurrence = typeof tpEntityCoOccurrences.$inferSelect;
export type InsertTpEntityCoOccurrence = z.infer<
  typeof insertTpEntityCoOccurrenceSchema
>;

// tpCompositeTrendCandidates (Task #3)
export const insertTpCompositeTrendCandidateSchema = createInsertSchema(
  tpCompositeTrendCandidates
).omit({ id: true });
export type TpCompositeTrendCandidate =
  typeof tpCompositeTrendCandidates.$inferSelect;
export type InsertTpCompositeTrendCandidate = z.infer<
  typeof insertTpCompositeTrendCandidateSchema
>;
export type TpLongTailCandidate = typeof tpLongTailCandidates.$inferSelect;
export type InsertTpLongTailCandidate = z.infer<
  typeof insertTpLongTailCandidateSchema
>;

// tpCategories (Task #4)
export const insertTpCategorySchema = createInsertSchema(tpCategories).omit({
  id: true,
});
export type TpCategory = typeof tpCategories.$inferSelect;
export type InsertTpCategory = z.infer<typeof insertTpCategorySchema>;

// tpCategoryAttributes (Task #4)
export const insertTpCategoryAttributeSchema = createInsertSchema(
  tpCategoryAttributes
).omit({ id: true });
export type TpCategoryAttribute = typeof tpCategoryAttributes.$inferSelect;
export type InsertTpCategoryAttribute = z.infer<
  typeof insertTpCategoryAttributeSchema
>;

// tpAttributeSignals (Task #4)
export const insertTpAttributeSignalSchema = createInsertSchema(
  tpAttributeSignals
).omit({ id: true });
export type TpAttributeSignal = typeof tpAttributeSignals.$inferSelect;
export type InsertTpAttributeSignal = z.infer<
  typeof insertTpAttributeSignalSchema
>;

// tpAttributeExtractionLog (Task #4)
export const insertTpAttributeExtractionLogSchema = createInsertSchema(
  tpAttributeExtractionLog
).omit({ id: true });
export type TpAttributeExtractionLog = typeof tpAttributeExtractionLog.$inferSelect;
export type InsertTpAttributeExtractionLog = z.infer<
  typeof insertTpAttributeExtractionLogSchema
>;

// tpAttributeTimeseries (Task #4)
export const insertTpAttributeTimeseriesSchema = createInsertSchema(
  tpAttributeTimeseries
).omit({ id: true });
export type TpAttributeTimeseries = typeof tpAttributeTimeseries.$inferSelect;
export type InsertTpAttributeTimeseries = z.infer<
  typeof insertTpAttributeTimeseriesSchema
>;
