// One-off: de-duplicate the split "Ashwagandha" / "ashwagandha" radar entries.
// Data-only fix — the canonicalization code already lowercases; these two
// entity records predate that logic and were never retro-merged.
//
// Safe + reversible: archives the smaller dupe's knowledge item (hides it from
// the radar, keeps the row) and relabels the surviving item to a clean display
// case. Does NOT delete entities or touch scraped signals, so a proper
// signal-level merge (needs a company-wide recompute) can still be done later.
import { db, knowledgeItems } from "@workspace/db";
import { eq } from "drizzle-orm";

const DUPE_KI = 9; // entity 601 "Ashwagandha", 10 mentions — hide this one
const KEEP_KI = 19; // entity 2193 "ashwagandha", 21 mentions — keep, relabel
const DISPLAY = "Ashwagandha";

async function main() {
  const [dupe] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, DUPE_KI));
  const [keep] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, KEEP_KI));
  if (!dupe || !keep) throw new Error(`missing KI: dupe=${!!dupe} keep=${!!keep}`);
  console.log(`before: dupe#${DUPE_KI} "${dupe.title}" archived=${dupe.archived} | keep#${KEEP_KI} "${keep.title}"`);

  await db.update(knowledgeItems)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, DUPE_KI));
  await db.update(knowledgeItems)
    .set({ title: DISPLAY, topicLabel: DISPLAY, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, KEEP_KI));

  const [d2] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, DUPE_KI));
  const [k2] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, KEEP_KI));
  console.log(`after:  dupe#${DUPE_KI} "${d2!.title}" archived=${d2!.archived} | keep#${KEEP_KI} "${k2!.title}"`);
  console.log("done — radar should now show a single 'Ashwagandha'.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
