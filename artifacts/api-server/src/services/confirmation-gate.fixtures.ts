import type { GateInput } from "./confirmation-gate.js";

export interface LabelledCase {
  name: string;
  expected: "pass" | "hold";
  input: GateInput;
  note: string;
}

const flat60 = Array.from({ length: 60 }, (_, i) => 4 + (i % 2));
const spike60 = (() => {
  const s = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) s[i] = 40;
  return s;
})();

export const fixtures: LabelledCase[] = [
  {
    name: "single-author-spike",
    expected: "hold",
    input: {
      dailyMentions: spike60,
      sources: [{ platform: "tiktok", uniqueAuthors: 1, mentions: 40 }],
    },
    note: "coffee-shop case: real surge but one account",
  },
  {
    name: "broad-organic-rise",
    expected: "pass",
    input: {
      dailyMentions: spike60,
      sources: [
        { platform: "tiktok", uniqueAuthors: 9, mentions: 30 },
        { platform: "youtube", uniqueAuthors: 7, mentions: 22 },
        { platform: "googletrends", uniqueAuthors: 5, mentions: 10 },
      ],
    },
    note: "real broad trend across sources",
  },
  {
    name: "flat-noise",
    expected: "hold",
    input: {
      dailyMentions: flat60,
      sources: [
        { platform: "tiktok", uniqueAuthors: 6, mentions: 20 },
        { platform: "youtube", uniqueAuthors: 5, mentions: 18 },
      ],
    },
    note: "broad but no real movement",
  },
];
