// Merge entities that differ only by letter case.
//
// canonicalizeLabel lowercases, so current extractions cannot produce these. But
// entities created BEFORE that fix landed kept their original casing, and
// nothing ever merged them retroactively. The result is one real trend split
// across two rows — "Chocolate" (35 mentions) and "chocolate" (53) are the same
// thing, and the gate sees neither at its true size of 88.
//
// Measured on company 1: 653 groups, 1,548 mentions invisible to the gate. That
// is signal we already paid to scrape and then hid from the significance test by
// halving it.
//
// Survivor = the row with the most mentions (usually the post-fix lowercase
// one). Losers have their signal links repointed, then are deleted. Timeseries
// rows are repointed too, summing where the survivor already has a bucket for
// the same day/platform/geography.
//
// SAFETY: never run while entity extraction is in flight — it creates entities
// concurrently and would race this. Check first.
import { db, tpEntities, tpSignalEntities, tpEntityTimeseries, tpEntityState } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

const COMPANY_ID = Number(process.env.MERGE_COMPANY_ID ?? "1");
const DRY_RUN = process.env.MERGE_DRY_RUN === "true";

async function retry<T>(fn: () => Promise<T>, label: string, n = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  throw last;
}

async function main() {
  const ents = (await db
    .select()
    .from(tpEntities)
    .where(eq(tpEntities.companyId, COMPANY_ID))) as any[];

  // Group on the case-folded label + type: that is the identity the
  // canonicalizer would produce today.
  const groups = new Map<string, any[]>();
  for (const e of ents) {
    const key = `${String(e.canonicalLabel).trim().toLowerCase()}|${e.entityType}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(`${ents.length} entities -> ${dupes.length} case-duplicate groups\n`);

  let merged = 0, linksMoved = 0, bucketsMoved = 0, deleted = 0;

  for (const [key, rows] of dupes) {
    // Keep the biggest: it carries the most history, so the least is rewritten.
    rows.sort((a, b) => (b.totalMentions ?? 0) - (a.totalMentions ?? 0));
    const survivor = rows[0];
    const losers = rows.slice(1);
    const loserIds = losers.map((l) => l.id);

    if (DRY_RUN) {
      const total = rows.reduce((s, e) => s + (e.totalMentions ?? 0), 0);
      console.log(`  ${key} : keep #${survivor.id} "${survivor.canonicalLabel}" (${survivor.totalMentions}m) <- ${losers.map((l) => `#${l.id} "${l.canonicalLabel}"(${l.totalMentions}m)`).join(", ")}  => ${total}m`);
      merged++;
      continue;
    }

    // 1. Repoint signal links. A signal already linked to the survivor would
    //    violate the (rawSignalId, entityId) uniqueness, so move only the ones
    //    that would not collide and drop the rest as true duplicates.
    const surviving = await retry(() => db.select().from(tpSignalEntities)
      .where(eq(tpSignalEntities.entityId, survivor.id)), "sel-survivor-links");
    const already = new Set(surviving.map((r: any) => r.rawSignalId));
    const loserLinks = await retry(() => db.select().from(tpSignalEntities)
      .where(inArray(tpSignalEntities.entityId, loserIds)), "sel-loser-links");
    const movable = loserLinks.filter((l: any) => !already.has(l.rawSignalId));
    const collide = loserLinks.filter((l: any) => already.has(l.rawSignalId));
    for (const l of movable) {
      await retry(() => db.update(tpSignalEntities)
        .set({ entityId: survivor.id } as any)
        .where(eq(tpSignalEntities.id, (l as any).id)), "move-link");
      linksMoved++;
    }
    for (const l of collide) {
      await retry(() => db.delete(tpSignalEntities)
        .where(eq(tpSignalEntities.id, (l as any).id)), "drop-dup-link");
    }

    // 2. Merge daily buckets, summing where both rows covered the same day.
    const survBuckets = await retry(() => db.select().from(tpEntityTimeseries)
      .where(eq(tpEntityTimeseries.entityId, survivor.id)), "sel-surv-buckets");
    const bucketKey = (b: any) => `${b.bucketDate}|${b.platform}|${b.geography}`;
    const survByKey = new Map(survBuckets.map((b: any) => [bucketKey(b), b]));
    const loserBuckets = await retry(() => db.select().from(tpEntityTimeseries)
      .where(inArray(tpEntityTimeseries.entityId, loserIds)), "sel-loser-buckets");
    for (const b of loserBuckets as any[]) {
      const hit: any = survByKey.get(bucketKey(b));
      if (hit) {
        await retry(() => db.update(tpEntityTimeseries).set({
          mentions: (hit.mentions ?? 0) + (b.mentions ?? 0),
          // Unique authors cannot be summed exactly without the author sets, so
          // take the max: an undercount is safer than inventing breadth the
          // entity does not have, since breadth gates confirmation.
          uniqueAuthors: Math.max(hit.uniqueAuthors ?? 0, b.uniqueAuthors ?? 0),
        } as any).where(eq(tpEntityTimeseries.id, hit.id)), "merge-bucket");
      } else {
        await retry(() => db.update(tpEntityTimeseries)
          .set({ entityId: survivor.id } as any)
          .where(eq(tpEntityTimeseries.id, b.id)), "move-bucket");
      }
      bucketsMoved++;
    }

    // 3. Roll mentions up onto the survivor.
    const total = rows.reduce((s, e) => s + (e.totalMentions ?? 0), 0);
    await retry(() => db.update(tpEntities).set({
      totalMentions: total,
      aliases: [...new Set([...(survivor.aliases ?? []), ...losers.flatMap((l) => [l.canonicalLabel, ...(l.aliases ?? [])])])]
        .filter((a) => a !== survivor.canonicalLabel),
      updatedAt: new Date(),
    } as any).where(eq(tpEntities.id, survivor.id)), "roll-up");

    // 4. Drop the losers' state rows, then the losers. Deleting the entity
    //    cascades anything left over.
    await retry(() => db.delete(tpEntityState)
      .where(and(eq(tpEntityState.companyId, COMPANY_ID), inArray(tpEntityState.entityId, loserIds))), "del-state");
    await retry(() => db.delete(tpEntities).where(inArray(tpEntities.id, loserIds)), "del-losers");
    deleted += loserIds.length;
    merged++;
    if (merged % 50 === 0) console.log(`  ${merged}/${dupes.length} groups merged...`);
  }

  console.log(`\ngroups merged:   ${merged}`);
  console.log(`links repointed: ${linksMoved}`);
  console.log(`buckets merged:  ${bucketsMoved}`);
  console.log(`entities removed:${deleted}`);
  console.log(DRY_RUN ? "\nDRY RUN — nothing written." : "\nDONE — re-run timeseries + state machine so the gate sees the merged totals.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
