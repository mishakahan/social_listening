# The BOX: How the Social-Listening Pipeline Works

A complete, plain-language explanation of the whole system, end to end. This is
written to be readable on its own and to be turned into an audio walkthrough.

---

## The one-paragraph version

The BOX is a trend-detection engine. You give it a company (say, an Italian
confectionery brand), and it figures out what to watch on social media, scrapes
those platforms, pulls out the *things* people are talking about, tracks how much
each thing is mentioned over time, and then decides which of those are genuinely
*trending* versus just background noise. The hard part is that last step: telling
a real emerging trend apart from a fluke. That is what the "confirmation gate"
does, and it is the piece this project focused on.

---

## The big picture: seven stages

The data flows through seven stages, in order:

1. **Scouting** — decide *what* to search for (turn a company into search terms)
2. **Scraping** — pull posts from social platforms (Apify actors)
3. **Ingestion** — normalize every platform's messy data into one clean shape
4. **Entity extraction** — pull the *nouns that matter* out of each post
5. **Timeseries aggregation** — count mentions per thing, per day
6. **Growth state machine** — flag things whose mention count is rising
7. **Confirmation gate** — the honest check: is this actually a trend, or noise?

If it passes the gate, it surfaces on the "radar" as a confirmed trend. If not,
it is held. Everything downstream depends on the quality of everything upstream,
which is a theme worth keeping in mind.

---

## Stage 1: Scouting — deciding what to look for

Before you can detect trends, you have to know *what to search for*. You cannot
just scrape "the internet." Scouting is a three-step chain that turns a plain
company description into concrete search terms. It all runs on a cheap LLM
(OpenAI gpt-4o-mini), in one file: `radar-setup-bot.ts`.

**Step 1a — Brief to Company Context.** You feed in a "brief": a written
description of the company (its products, markets, strategy). An LLM reads it and
extracts a structured profile: target geographies, product categories, strategic
priorities, and so on. There is a guardrail here: if the brief does not mention
at least one geography and one product category, the system refuses to continue.
This is why the brief has to be substantial (500+ characters minimum).

**Step 1b — Context to Seed Items.** Next, an LLM generates a set of "seed
items." A seed is a *specific topic to track* — not "chocolate" but "pistachio
cream in Italy." Each seed comes with metadata: which geography, which product
category, a "strategic centrality" score from 0 to 100 (how core it is to the
company), and a territory tag like "gifting" or "premium" or "functional-health."

How many seeds? There is a formula: roughly the number of strategic priorities
times three, scaled by how many geographies and categories the company has, and
then clamped between 12 and 45. So a simple company gets ~12 seeds; a complex one
gets up to 45.

There is an optional but important feature here called **watch topics.** If you
hand the system a list of topics you specifically care about, it *forces every
seed to ladder up to one of those topics*, and it requires each topic to be
covered by at least two seeds. This is powerful but has a sharp edge: if you give
it narrow watch topics, it will faithfully produce many narrow variations. (In
testing, feeding it gummy-heavy watch topics produced 27 gummy variations — the
system doing exactly what it was told.)

**Step 1c — Seed to Scout Queries.** Finally, each seed is turned into the actual
*search terms*: 5 to 10 keywords and 5 to 10 hashtags, generated *per language*
and native to that language. An Italian seed gets Italian keywords and hashtags;
a German seed gets German ones. These get stored in a table called
`tp_scout_queries`, and they are what the scrapers actually search for.

So the full scouting chain is:

> brief → company context → seed items (topics) → scout queries (keywords + hashtags)

This is where query *quality* is decided, upstream of everything else. If the
keywords are too niche, the scrape comes back nearly empty — which, as we will
see, is the root of the biggest problem the system faces.

---

## Stage 2: Scraping — the Apify actors

Each scout query "fans out" to about five social platforms. Each platform has its
own scraper (called an "actor" on Apify, a scraping platform). A key thing to
understand is that **the platforms are not equal** — they differ enormously in
what they will give you.

- **Instagram** (`apify/instagram-scraper`): searches hashtag pages. It is
  *recent-only* — you cannot ask for "posts from March," only the most recent
  posts a hashtag currently shows. It is also by far the most *expensive*
  scraper, at one point ~85% of total scrape cost.
- **TikTok** (`scrapeforge/tiktok-posts`): keyword search with a preset time
  window (e.g. "last 6 months"). One gotcha found in testing: it defaults to
  scraping *user profiles*, so it had to be explicitly told to do keyword search
  instead, or it returned nothing.
- **Reddit** (`trudax/reddit-scraper-lite`): keyword search, recent-only. An
  "archive" actor that promised true 6-month history was tried, but it returned
  zero results even on direct tests, so the system reverted to the reliable
  recent-only one.
- **X / Twitter** (`xquik/x-tweet-scraper`): free-text search with real date
  ranges (since/until). Because it is free-text, it does not have the hashtag
  exact-match problem the others do. Cheap.
- **Google Trends** (`apify/google-trends-scraper`): a native time series of
  search interest. Inherently historical.

**A critical distinction: "recent-only" vs. "date-windowed."** Some platforms
(TikTok, X, Google Trends) can genuinely reach back six months. Others (Instagram,
Reddit) can only give you what is visible *right now* — so the only way to build
history for them is to scrape repeatedly over time and let it accumulate.

**One subtle but important preprocessing step on Instagram:** hashtags are exact.
`#functionalgummies` and `#functionalgummy` are *different* tags — matching one
does not catch the other. So the system expands each hashtag into common variants
(singular/plural, spacing removed) before searching. This is capped, because each
variant is a separate (billed) scrape.

The output of this stage is raw posts — thousands of them, in each platform's own
messy JSON format.

---

## Stage 3: Ingestion — making everything look the same

Every platform returns data in a completely different shape. Reddit calls it
`selftext`; TikTok nests the author under `authorMeta.name`; X puts engagement in
`likeCount`. Ingestion is the translation layer: it takes each platform's raw
post and normalizes it into one common "signal" shape with consistent fields —
author, text, timestamp, engagement, platform, language. This is handled by a set
of `normalize<Platform>` functions in `ingestion.ts`. The cleaned signals land in
a table called `tp_raw_signals`.

This stage is unglamorous but essential: everything downstream assumes a single
consistent format, so if a new platform is added, its normalizer must be written
or its data silently disappears.

---

## Stage 4: Entity Extraction — finding the things that matter

A raw post is just text: "loving these functional gummies lately." What the system
actually needs is the *entity*: "functional gummies." Entity extraction is another
LLM step (gpt-4o-mini) that reads each post and pulls out the meaningful nouns,
each with a type — `Gummy` (format), `Chocolate` (ingredient), `Birthday`
(occasion), `Gut Health` (functional benefit). These become rows in `tp_entities`,
linked back to the posts they came from.

**This is where a known bug lives.** Ideally the system should recognize that
"gummy," "gummies," and "Gummy" are the *same thing* and merge them into one
entity — while keeping genuinely different things like "gummy bears" and "THC
gummies" separate. Right now it does not fully do this: it leaves trivial variants
as separate entities, which *splits* an entity's signal across several rows and
weakens trend detection. There is even a `tp_entity_synonyms` table designed for
exactly this canonicalization; tightening this is a planned fix and a free one
(no scraping cost).

---

## Stage 5: Timeseries Aggregation — counting over time

Trend detection is fundamentally about *change over time*, so the system rolls all
the signals into daily buckets. For each entity, on each platform, in each
geography, on each day, it records: how many mentions, and — crucially — how many
*unique authors*. That `unique_authors` count matters a lot later, because it is
how the system can tell "one person posting ten times" apart from "ten people
posting once each." These buckets live in `tp_entity_timeseries` and operate on a
rolling 90-day window.

---

## Stage 6: The Growth State Machine — flagging what's rising

Now the system looks at each entity's timeseries and assigns it a *state* based on
volume and growth: `candidate`, `emerging`, `confirmed`, `peaking`, `declining`,
`dormant`, or `resurgent`. It uses configurable thresholds — a minimum volume and
a minimum week-over-week growth rate — to decide when something moves from
"candidate" to "emerging" and beyond.

Only entities that reach a *surfacing* state (emerging, confirmed, peaking, or
resurgent) get passed on to the final stage.

**Here is the gap that motivated this whole project.** The state machine decides
purely on *volume and growth*. It never looks at `unique_authors` — even though
that number is sitting right there in the data. So to the state machine, one
account posting ten times and ten accounts posting once look *identical*. Both can
clear the growth threshold. This is exactly how a single noisy coffee shop can
look like a real trend. The data to catch it exists; the state machine just never
used it.

---

## Stage 7: The Confirmation Gate — the honest check

This is the heart of the project: a fourth-stage gate that sits *between* the
state machine and the radar. Before anything is declared a confirmed trend, it has
to pass two independent checks. Both must pass.

**Check 1 — Significance (does it beat its own noise?).** Instead of asking "did
this grow more than X%?" (an arbitrary fixed threshold), the gate asks a smarter
question: "is this move bigger than what *this specific entity* normally does by
chance?" It does this with a *permutation test*: it takes the entity's own daily
history, shuffles it randomly many times to build a picture of what "normal random
fluctuation" looks like for that entity, and checks whether the recent real spike
stands out against that. A flat, steady entity produces a high p-value (not
significant, held); a genuine surge produces a low one (significant, passes). It
requires at least 14 days of history — with less than that, there is simply not
enough to test, so it holds.

**Check 2 — Source Breadth (is it broad or concentrated?).** This is the
coffee-shop fix. The gate measures how *spread out* the mentions are across
authors and platforms, using Shannon entropy — a measure of diversity. If one
account or one platform dominates, entropy is low, and it is held. If many
different authors across several platforms are talking about it, entropy is high,
and it passes. This directly uses the `unique_authors` data the state machine
ignored.

An entity only surfaces to the radar if it is *both* statistically significant
*and* broadly sourced. The verdict — pass or hold, with the reasons and the
numbers — is written to `tp_entity_state.confirmation_verdict`. The whole gate can
be switched off via config, so it is fully reversible.

The design philosophy is honesty over optimism: the gate would rather hold a real
trend it cannot yet confirm than cry "trend" on noise. An honest "hold" is a valid
answer.

---

## What actually happened on real data

The pipeline was run end to end on a real scrape: 10 test queries, about 2,200
posts, extracted into roughly 2,800 entities. The gate worked — and the result was
illuminating.

**One entity passed: "Gummy."** It had 46 days of history, real upward movement,
and appeared broadly across platforms. Exactly what a real trend looks like. The
gate confirmed it.

**Almost everything else was held — correctly.** Two reasons:
- Many entities were *flat*: steady low chatter, about one mention a day, no real
  movement. "Chocolate," for instance, had good source spread but was not actually
  trending, so it held (p-value of 1).
- Most entities were *too sparse*: of ~2,800 entities, only about 10 had two or
  more weeks of history. Over 2,200 of them appeared on essentially a single day.
  With that little data, there is nothing to test.

**The real finding is not about the gate — it is about data density.** A single
six-month scrape of niche queries, capped low for cost, yields roughly one mention
per entity per day. That is too thin for most things to register as a trend. The
gate is doing its job (refusing to call noise a trend); the limiting factor is the
amount of data feeding it.

---

## The three ways to fix density

1. **Deepen the pull.** The test ran at a small cap of 40 posts per platform per
   query, to keep it cheap. The platforms that *can* reach back six months (TikTok,
   X, Google Trends) were run shallow. Raising their caps directly gives the
   significance test more history to work with.

2. **Accumulate over time.** Instagram and Reddit are recent-only, so their history
   cannot be pulled retroactively — it can only be *built* by scraping on a
   schedule and letting the buckets fill in day after day. This is the real
   long-term fix, and it is slow by nature.

3. **Canonicalize entities.** The gummy/gummies bug splits one real signal across
   several entities. Merging trivial variants (while keeping genuinely different
   concepts apart) concentrates each entity's mentions, which is a free density
   win with no scraping cost.

---

## The key tables (for reference)

- `tp_scout_queries` — the keywords/hashtags to search for
- `tp_actor_runs` / `tp_launch_batches` — bookkeeping for scrape jobs
- `tp_raw_signals` — normalized posts (ingestion output)
- `tp_entities` / `tp_signal_entities` — extracted entities and their post links
- `tp_entity_synonyms` — canonicalization (merging variants)
- `tp_entity_timeseries` — daily mention/author buckets
- `tp_entity_state` — each entity's growth state + confirmation verdict
- `knowledge_items` — the radar (confirmed trends)
- `tp_pipeline_config` — the tunable thresholds

---

## The one thing to remember

Every stage is only as good as the data flowing into it. The confirmation gate is
mathematically sound and behaves honestly — but it can only confirm trends when
the entities feeding it have enough history, enough mentions, and enough source
diversity. The engineering that matters now is not the gate itself; it is
*feeding the gate denser, cleaner data*. That is the whole game from here.
