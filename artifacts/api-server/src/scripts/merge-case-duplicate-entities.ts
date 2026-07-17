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
import { canonicalizeLabel } from "../services/entity-canonical.js";

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

  // Group on the case-folded label ALONE, deliberately ignoring entityType.
  //
  // The type is assigned per batch by the LLM and it is not stable: the same
  // word comes back as ingredient in one batch and flavour, format, brand or
  // other in the next. Measured here: 545 labels are split across types, hiding
  // 2,180 mentions — on top of the 442 pure case splits. "chocolate" exists as
  // eight rows; "tequila" as four.
  //
  // For trend detection the label IS the trend: "tequila" rising is the same
  // event whether a batch happened to call it an ingredient or a brand. The
  // risk of merging on label alone is two genuinely different things sharing a
  // word, so that was checked rather than assumed — of 53 groups where more than
  // one type had real volume, every single one was the same thing classified
  // inconsistently (water other/ingredient, wine ingredient/format, probiotic
  // functional_benefit/ingredient). None were distinct entities.
  // Key on canonicalizeLabel, not a bare lowercase: that is the exact string a
  // future extraction will resolve to, so it also catches singular/plural pairs
  // (Gummies -> gummy) that case-folding alone would miss.
  const groups = new Map<string, any[]>();
  for (const e of ents) {
    const key = canonicalizeLabel(String(e.canonicalLabel));
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(`${ents.length} entities -> ${dupes.length} duplicate groups (case + type)\n`);

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
    // (entityId, platform, geography, bucketDate) is uniquely indexed, so a
    // bucket can only be moved onto the survivor if the survivor has no bucket
    // for that same slot. bucketDate is normalised because it arrives as a Date
    // from one query and a string from another, and a mismatched key here reads
    // as "no collision" and then violates the index.
    const bucketKey = (b: any) =>
      `${new Date(b.bucketDate).toISOString().slice(0, 10)}|${b.platform}|${b.geography}`;
    const survByKey = new Map<string, any>(survBuckets.map((b: any) => [bucketKey(b), b]));
    const loserBuckets = await retry(() => db.select().from(tpEntityTimeseries)
      .where(inArray(tpEntityTimeseries.entityId, loserIds)), "sel-loser-buckets");
    for (const b of loserBuckets as any[]) {
      const k = bucketKey(b);
      const hit: any = survByKey.get(k);
      if (hit) {
        const mentions = (hit.mentions ?? 0) + (b.mentions ?? 0);
        // Unique authors cannot be summed exactly without the author sets, so
        // take the max: an undercount is safer than inventing breadth the
        // entity does not have, since breadth gates confirmation.
        const uniqueAuthors = Math.max(hit.uniqueAuthors ?? 0, b.uniqueAuthors ?? 0);
        await retry(() => db.update(tpEntityTimeseries)
          .set({ mentions, uniqueAuthors } as any)
          .where(eq(tpEntityTimeseries.id, hit.id)), "merge-bucket");
        // Keep the running totals in the map: a later loser hitting the same
        // slot must fold into this same row, not overwrite it.
        survByKey.set(k, { ...hit, mentions, uniqueAuthors });
        await retry(() => db.delete(tpEntityTimeseries)
          .where(eq(tpEntityTimeseries.id, b.id)), "drop-merged-bucket");
      } else {
        await retry(() => db.update(tpEntityTimeseries)
          .set({ entityId: survivor.id } as any)
          .where(eq(tpEntityTimeseries.id, b.id)), "move-bucket");
        // The moved row now occupies that slot, so a second loser with the same
        // slot must merge into it rather than collide. This was the bug: the map
        // was built once from the survivor and never updated, so the second
        // loser's move violated the unique index.
        survByKey.set(k, { ...b, entityId: survivor.id });
      }
      bucketsMoved++;
    }

    // 3. Roll mentions up onto the survivor, and REWRITE its label to the
    //    canonical form. This is what makes the merge stick: keep "Creatine"
    //    and the next extraction resolves to "creatine", matches nothing, and
    //    recreates the duplicate we just removed. The survivor must be the
    //    string future lookups will actually produce.
    const total = rows.reduce((s, e) => s + (e.totalMentions ?? 0), 0);
    await retry(() => db.update(tpEntities).set({
      canonicalLabel: key,
      totalMentions: total,
      aliases: [...new Set([...(survivor.aliases ?? []), ...rows.map((r) => r.canonicalLabel), ...losers.flatMap((l) => l.aliases ?? [])])]
        .filter((a) => a && a !== key),
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
