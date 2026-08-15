// watchTopic was only ever stored inside tp_seed_candidates.payload. Recover it
// onto tp_seed_items (matched by label) and cascade to tp_scout_queries.
//
// Two recovery sources, tried in order:
//   1. payload: committed candidates' payload[].watchTopic, matched by exact
//      seed label (the original, most-direct source — a seed's own
//      generated watchTopic value).
//   2. watch_topics_snapshot: fallback for seed items the payload source
//      can't reach (e.g. the current live seed items came from a LATER,
//      uncommitted/different candidate round than the one holding the
//      committed payload — this is exactly company 1/Leone's situation).
//      watch_topics_snapshot is the list of watch-topic {title, description}
//      the user configured to anchor seed generation, stored on every
//      tp_seed_candidates row regardless of commit status — it's input
//      configuration, not draft output, so an uncommitted row's snapshot is
//      just as valid a source as a committed one's. We match each real seed
//      item's label against every distinct watch-topic title ever seen for
//      the company, EXACT OR NORMALISED ONLY (see normalizeForTopicMatch) —
//      deliberately no fuzzy/word-level matching here, unlike
//      discovery-origin.ts's matcher. A label with no match (e.g. any
//      BENCH:* fixture row) is simply left unmapped, not guessed at.
//
// Dry-run by default. Pass --apply to write. Prints every label->watchTopic
// pair (tagged with its source) it intends to write, plus row counts before
// and after, so a bad recovery is visible before/after it touches the shared
// DB.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--apply");
const companyId = Number(process.env.COMPANY_ID ?? 2);

// "Chocolate gifting (Italy)" -> "chocolate gifting italy", matching
// "Chocolate gifting Italy" (no parens) from a watch_topics_snapshot title.
// Also lowercases/collapses whitespace, so it doubles as the exact-match
// comparator (an already-identical pair normalises to the same string).
// Intentionally does nothing more than this one transform — no stemming, no
// word reordering, no partial matches.
function normalizeForTopicMatch(s: string): string {
  return s
    .trim()
    .replace(/\s*\(([^)]+)\)\s*$/, " $1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface Pair {
  label: string;
  topic: string;
  source: "payload" | "snapshot";
}

async function main() {
  const pairs = new Map<string, Pair>();

  // --- Source 1: committed candidate payloads (exact label match) --------
  const cands = await db.execute(
    sql`select payload from tp_seed_candidates
         where company_id = ${companyId} and committed_at is not null
         order by committed_at desc`
  );
  for (const row of cands.rows as Array<{ payload: unknown }>) {
    const payload = (row.payload ?? []) as Array<{ label?: string; watchTopic?: string }>;
    for (const s of payload) {
      if (s.label && s.watchTopic && !pairs.has(s.label)) {
        pairs.set(s.label, { label: s.label, topic: s.watchTopic, source: "payload" });
      }
    }
  }

  // --- Source 2: watch_topics_snapshot fallback (exact-or-normalised) ----
  // Pull every distinct watch-topic title ever configured for this company,
  // from every tp_seed_candidates row regardless of commit status.
  const snapshotRows = await db.execute(
    sql`select watch_topics_snapshot from tp_seed_candidates where company_id = ${companyId}`
  );
  const topicTitles = new Map<string, string>(); // normalized -> original title
  for (const row of snapshotRows.rows as Array<{ watch_topics_snapshot: unknown }>) {
    const snap = (row.watch_topics_snapshot ?? []) as Array<{ title?: string }>;
    for (const t of snap) {
      if (t.title) topicTitles.set(normalizeForTopicMatch(t.title), t.title);
    }
  }

  if (topicTitles.size > 0) {
    const items = await db.execute(
      sql`select distinct label from tp_seed_items where company_id = ${companyId}`
    );
    for (const row of items.rows as Array<{ label: string }>) {
      if (pairs.has(row.label)) continue; // payload source already covers this label
      const norm = normalizeForTopicMatch(row.label);
      const matchedTitle = topicTitles.get(norm);
      if (matchedTitle) {
        pairs.set(row.label, { label: row.label, topic: matchedTitle, source: "snapshot" });
      }
    }
  }

  console.log(`company ${companyId}: recovered ${pairs.size} label->watchTopic pairs`);
  const fromPayload = [...pairs.values()].filter((p) => p.source === "payload");
  const fromSnapshot = [...pairs.values()].filter((p) => p.source === "snapshot");
  console.log(`  ${fromPayload.length} from committed payloads, ${fromSnapshot.length} from watch_topics_snapshot fallback`);
  for (const p of pairs.values()) {
    console.log(`  [${p.source}] ${p.label}  ->  ${p.topic}`);
  }

  const beforeItems = await db.execute(
    sql`select count(*)::int as total,
               count(*) filter (where watch_topic is not null)::int as with_topic
          from tp_seed_items where company_id = ${companyId}`
  );
  const beforeQueries = await db.execute(
    sql`select count(*)::int as total,
               count(*) filter (where watch_topic is not null)::int as with_topic
          from tp_scout_queries where company_id = ${companyId}`
  );
  const bi = beforeItems.rows[0] as { total: number; with_topic: number };
  const bq = beforeQueries.rows[0] as { total: number; with_topic: number };
  console.log(
    `before: tp_seed_items ${bi.with_topic}/${bi.total} with watch_topic, ` +
      `tp_scout_queries ${bq.with_topic}/${bq.total} with watch_topic`
  );

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  if (pairs.size === 0) {
    console.log("no pairs recovered for this company — nothing to write");
  }

  for (const { label, topic } of pairs.values()) {
    await db.execute(
      sql`update tp_seed_items set watch_topic = ${topic}
           where company_id = ${companyId} and label = ${label}`
    );
  }

  await db.execute(
    sql`update tp_scout_queries q
           set watch_topic = i.watch_topic
          from tp_seed_items i
         where q.seed_item_id = i.id
           and q.company_id = ${companyId}
           and i.watch_topic is not null`
  );

  const afterItems = await db.execute(
    sql`select count(*)::int as total,
               count(*) filter (where watch_topic is not null)::int as with_topic
          from tp_seed_items where company_id = ${companyId}`
  );
  const afterQueries = await db.execute(
    sql`select count(*)::int as total,
               count(*) filter (where watch_topic is not null)::int as with_topic
          from tp_scout_queries where company_id = ${companyId}`
  );
  const ai = afterItems.rows[0] as { total: number; with_topic: number };
  const aq = afterQueries.rows[0] as { total: number; with_topic: number };
  console.log(
    `after: tp_seed_items ${ai.with_topic}/${ai.total} with watch_topic, ` +
      `tp_scout_queries ${aq.with_topic}/${aq.total} with watch_topic`
  );

  const unmapped = await db.execute(
    sql`select count(*)::int as n from tp_scout_queries
         where company_id = ${companyId} and watch_topic is null`
  );
  console.log(`scout queries still without a watch topic: ${(unmapped.rows[0] as { n: number }).n}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
