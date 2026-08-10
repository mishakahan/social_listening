# Retrospective holdout — does the confirmation gate predict anything?

**Run 2026-08-08. No scrape, no LLM, no writes — replayed from data already in the DB.**

The gate has applied a significance test and a breadth test to thousands of entities
and called some of them confirmed. Until now nobody had checked whether entities it
passes go on to behave any differently from entities it holds. This is that check.

## Method

1. Pick a cutoff `T` 56 days before the last day of data.
2. Truncate every entity's timeseries to `bucket_date <= T` and run the **real
   production gate** on it — `buildGateInput` + `confirmationVerdict`, imported from
   `services/confirmation-gate.ts`, not reimplemented.
3. Measure what actually happened in the 56 days after `T`.
4. Compare cohorts with a Mann-Whitney rank test on growth ratio
   `(post + 1) / (pre + 1)`.

The rank test is unit-tested against six known-answer cases before being trusted
(`holdout-validate.test.ts`). Cohorts below 20 are reported as UNDERPOWERED, never as
a negative result.

## Results

| check | company | cohorts (pass/fail) | median growth | ratio | p |
|---|---|---|---|---|---|
| **Significance** | Leone | 341 / 419 | 1.44x vs 1.44x | **1.00x** | 0.73 |
| **Significance** | Fast Food | 128 / 205 | 1.14x vs 1.25x | **0.91x** | 0.31 |
| **Breadth** | Leone | 151 / 609 | 2.10x vs 1.27x | **1.65x** | **<0.0001** |
| **Breadth** | Fast Food | 9 / 324 | 2.07x vs 1.21x | — | underpowered |
| **Combined gate** | Leone | 70 / 690 | 2.00x vs 1.40x | **1.43x** | 0.0002 |

### 1. The significance test has no measurable predictive validity

Two independent companies, both properly powered (n=760 and n=333). Leone's ratio is
**exactly 1.00x** — passed and held entities grew identically. This is a real negative,
not a power problem.

The permutation test is the contract's priority-(1) check. On this evidence it is not
selecting entities that go on to behave differently. That matches the standing internal
concern that a permutation test over a median of 5-7 mentions is precision theatre.

### 2. The breadth test works, and it is doing all the gate's work

Leone: entities clearing 1.0 bits grew **1.65x more** than those that did not,
p<0.0001, z=6.95, and 96.7% were still active afterwards versus 91.3%.

**It is not a volume proxy.** Median pre-window volume is near-identical between
cohorts (6.0 vs 5.0), and the effect survives stratification *within* volume bands:

| pre-window volume | n (pass/fail) | growth | ratio | p | |
|---|---|---|---|---|---|
| 3-5 | 63 / 344 | 1.80x vs 1.00x | 1.80x | <0.0001 | HOLDS |
| 6-10 | 44 / 141 | 2.32x vs 1.50x | 1.55x | 0.0005 | HOLDS |
| 11-20 | 25 / 77 | 1.90x vs 1.53x | 1.24x | 0.08 | no effect |
| 21+ | 19 / 47 | 1.88x vs 1.69x | 1.11x | 0.16 | no effect |

The effect is **strongest exactly where the gate earns its keep** — thin signals of
3-10 mentions, where a human cannot eyeball the answer. It fades above 20 mentions,
where something is obviously real anyway.

### 3. Combining the two checks makes the gate worse

Breadth alone: **1.65x**. Breadth AND significance: **1.43x**. Adding the significance
requirement dilutes selection quality while cutting the surfaced set from 151 to 70.

### 4. Fast Food cannot use the check that works

Only **9 of 333** entities cleared breadth, versus 151 of 760 at Leone. That is the
88%-TikTok monoculture: with nearly everything on one platform, almost nothing can
score 1.0 bits. The client whose radar matters most is the one structurally unable to
use the gate's only working check.

## What this does and does not establish

- The outcome measured is **continued mentions in our own scraped social data**, not
  real-world consumer adoption. "Predictive" here means predictive of sustained social
  conversation. An independent source (Google Trends, Exploding Topics) is still
  required for the proxy-to-trend leap.
- This is **retrospective, not prospective**. Pre-`T` data was retrieved by a July
  scrape, so it is what a July scrape reveals about May, not what a May scrape would
  have found. Relevance-sorted actors under-represent older posts.
- That recency skew inflates growth for **both** cohorts, so the *relative* comparison
  survives it. Read the ratio between cohorts, never the absolute growth figure.

## Independent cross-check (Google Trends)

The holdout above measures continued mentions **in our own scraped data**. That could mean
the gate predicts a real trend, or merely that it predicts our own scraper. An independent
source is required to tell those apart.

**Attempt 1 (2026-08-08) returned a clean null and should not be cited.** breadth-PASS n=16
median slope 0.00306 vs breadth-FAIL n=15 median 0.00307, p=0.91. The test was invalid by
construction, for three reasons, all of them design errors on our side:

1. **Wrong cohort.** `confirmationVerdict` is significance + breadth only — well-formedness
   and specificity run afterwards, in the state machine. So the "passes" included `milk`,
   `wine`, `tea`, `alcohol`, `ginger`: precisely the generic staples specificity exists to
   remove. Google Trends on "milk" cannot say anything about a food trend.
2. **Language asymmetry.** Three Italian terms (`inulina`, `vitamina b12`,
   `sistema immunitario`) sat in the control arm and none in the pass arm, queried worldwide.
3. **Window too short.** `today 3-m` began two weeks before the holdout cutoff, leaving no
   usable pre-period to measure a change against.

This is recorded rather than deleted: a null from an instrument that could not have detected
the effect is not evidence of absence, and citing it as such would repeat the mistake this
whole document exists to correct.

**Attempt 2 (2026-08-09) is a valid test, and it returned a null.**

| metric | breadth-PASS | breadth-FAIL | p |
|---|---|---|---|
| search interest after vs before cutoff | 0.847x (n=15) | 0.856x (n=16) | 0.61 |
| same, calendar term excluded | 0.871x (n=14) | 0.856x (n=16) | 0.84 |
| 5-year normalised slope | 0.00313 | 0.00228 | 0.36 |

Missing terms split 7 pass / 6 fail — balanced, so the result is not biased by dropout.
The medians are near-identical, so this is not a near-miss that a larger sample would
rescue. **The gate's judgement does not predict Google search movement.**

Both cohorts declined to ~0.85x, i.e. search interest fell for everything after the cutoff
(almost certainly seasonal). The comparison is relative, so that is handled.

The plausible reading is that social conversation and search are decoupled over an 11-week
horizon — consistent with this project's earlier finding that social *leads* search for food.
**That hypothesis is not testable on current data**: social history only reaches January and
only 11 weeks have elapsed since the cutoff, so there is no room to test a longer lag. Using
"social leads search" to explain the null away would be an unfalsifiable defence and should
be resisted.

**Standing position: the engine's demonstrated validity rests entirely on the social holdout.
There is no independent corroboration.** That is a known gap, not an unexamined one, and it
should be stated plainly rather than implied away. Total cost of both attempts: ~$5.24.

**Attempt 2 design.** Both arms drawn through the FULL pipeline — well-formed AND specific,
on passes and controls alike, so "is this a sensible specific food term" is held constant and
the remaining difference is attributable to the gate. Both arms restricted to entities whose
dominant scraped-signal language is English (a data-driven rule from `tp_raw_signals.language`,
applied symmetrically). Window widened to `today 12-m` so the cutoff sits mid-window and
search interest before and after it can be compared the same way the social outcome is.
Calendar-driven terms (Easter, Mother's Day) are declared in `CALENDAR_TERMS` **before** the
run: the primary analysis keeps them, a sensitivity analysis excludes them, and both are
reported.

## What was done about it

A variant sweep (`scripts/gate-variants.ts`) evaluated candidate gate configurations against
the same holdout, at three independent cutoffs:

| cutoff | shipped (sig AND breadth) | breadth only |
|---|---|---|
| Apr 22 | 1.43x, 93 surfaced | 1.55x, 162 surfaced |
| May 07 | 1.44x, 82 surfaced | 1.50x, 162 surfaced |
| May 22 | 1.43x, 70 surfaced | 1.65x, 151 surfaced |

Shipped is stable at 1.43-1.44x; removing the significance requirement beats it on **both**
edge and coverage at every cutoff. A `requireSignificance` flag now exists in `GateConfig`
(`GATE_REQUIRE_SIGNIFICANCE=false` switches to breadth-only). **It defaults to the current
shipped behaviour and is not enabled** — the significance test is a contracted deliverable,
so the decision to retire it belongs to the client, not to a commit. The significance result
is still computed and reported either way, tagged `(not required)`, so verdicts stay
auditable and the backtest runs both ways.

Two candidate replacements were tested and rejected: a 28d-vs-prior-28d growth statistic
(1.44x, below breadth alone) and a >=5-unique-author floor (1.56x / 1.50x / 1.71x across the
three cutoffs — indistinguishable from breadth alone, and its apparent win at one cutoff was
noise). Growth statistics of any shape add nothing at this data density.

## Consequences

1. **`gateMinSourceEntropyBits` should be tuned per company, and loosening it is safe.**
   An earlier draft of this document said the opposite. That was an inference, and
   measurement contradicts it: Fast Food surfaces **9** entities at 1.0 bits and **76 at a
   1.55x edge (p<0.0001) at 0.5 bits**. Loosening is not degradation, and for that company it
   is the only setting at which the radar functions at all. Per-company gate config is
   therefore required.
2. **The platform-mix rebalance is load-bearing**, not a nice-to-have. Breadth is the only
   check with demonstrated predictive validity, so improving its input is the highest-value
   scraping change available.
3. **The significance test should not be presented as the engine's centrepiece** on current
   evidence. It passes 44.9% of entities at alpha=0.05 (9x the nominal rate) and provides no
   discrimination among entities that already clear breadth (2.00x vs 2.17x, p=0.52).
4. **Re-run this after the next sweep.** Every figure here comes from sparse data (median 5
   mentions per entity). The significance test may behave differently on denser data;
   `holdout-validate.ts` re-checks the entire question for $0.
