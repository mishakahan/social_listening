// watchTopic was only ever stored inside tp_seed_candidates.payload. Recover it
// onto tp_seed_items (matched by label) and cascade to tp_scout_queries.
//
// Dry-run by default. Pass --apply to write. Prints every label->watchTopic
// pair it intends to write (even in --apply mode) plus row counts before and
// after, so a bad recovery is visible before/after it touches the shared DB.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--apply");
const companyId = Number(process.env.COMPANY_ID ?? 2);

async function main() {
  const cands = await db.execute(
    sql`select payload from tp_seed_candidates
         where company_id = ${companyId} and committed_at is not null
         order by committed_at desc`
  );

  const labelToTopic = new Map<string, string>();
  for (const row of cands.rows as Array<{ payload: unknown }>) {
    const payload = (row.payload ?? []) as Array<{ label?: string; watchTopic?: string }>;
    for (const s of payload) {
      if (s.label && s.watchTopic && !labelToTopic.has(s.label)) {
        labelToTopic.set(s.label, s.watchTopic);
      }
    }
  }
  console.log(`company ${companyId}: recovered ${labelToTopic.size} label->watchTopic pairs`);
  for (const [l, t] of labelToTopic) console.log(`  ${l}  ->  ${t}`);

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

  if (labelToTopic.size === 0) {
    console.log("no pairs recovered for this company — nothing to write");
  }

  for (const [label, topic] of labelToTopic) {
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
