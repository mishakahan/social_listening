// Add ONLY the new noise terms (spoon, napkin, plate, flour) without wiping the
// existing benchmark queries/data. Idempotent: skips ones already present.
import * as storage from "../storage/index.js";
import { db, tpSeedItems } from "@workspace/db";
import { eq, and, like } from "drizzle-orm";
const COMPANY_ID = 1;
const NEW = ["Spoon", "Napkin", "Plate", "Flour"];
const existing = await db.select().from(tpSeedItems).where(and(eq(tpSeedItems.companyId, COMPANY_ID), like(tpSeedItems.label, "BENCH:%")));
const existingNames = new Set(existing.map((s: any) => s.label.split(":").slice(2).join(":")));
for (const name of NEW) {
  if (existingNames.has(name)) { console.log(`skip (exists): ${name}`); continue; }
  const seed = await storage.createSeedItem({ companyId: COMPANY_ID, label: `BENCH:hold:${name}`, geography: "Global", status: "committed" } as any);
  await storage.createScoutQuery({ companyId: COMPANY_ID, seedItemId: seed.id, topicLabel: `BENCH:hold:${name}`, geography: "Global", language: "en", keywords: [name, name.toLowerCase()], hashtags: [name.toLowerCase()], active: false } as any);
  console.log(`created HOLD: ${name}`);
}
process.exit(0);
