# Social-Listening Actor Setup

On-record summary of which Apify actor we use per platform, how each handles
the time window and search specificity, and any pre/post-processing we do.

> **Status:** field mappings below are verified against each actor's Apify
> input/output docs. They are **not yet confirmed against a live run** — the
> first real scrape is where we validate the output field names in practice.
> Any mapping that turns out wrong on the first run is a quick fix.

## At a glance

| Platform | Actor | Time window | Search specificity | Notes |
|---|---|---|---|---|
| Reddit | `benthepythondev/reddit-archive-scraper` | **True date range** (`afterDate`/`beforeDate`), 6-month backfill | Single `searchQuery` = primary keyword | PullPush archive, no login. Comments off (cost driver). |
| TikTok | `scrapeforge/tiktok-posts` | **Preset window** `last-6-months` (no exact dates) | Primary keyword + primary hashtag | TikTok can't do precise date boundaries — preset only. |
| X (Twitter) | `xquik/x-tweet-scraper` | **True date range** (`since`/`until`), 6-month | Free-text `searchTerms` (all keyword variants) | Free-text search, so no hashtag-variant problem. |
| Instagram | `apify/instagram-scraper` | **Recent-only** (platform limit, no date query) | Hashtag explore pages, **variant-expanded** | Can't backfill by date; builds history forward. |
| Google Trends | `apify/google-trends-scraper` | Native time series (`today 3-m`) | Top ~5 keyword phrases | Kept as-is; inherently a time series. |
| Xiaohongshu (CN) | `easyapi/...-xiaohongshu-scraper` | n/a | keywords + tags | Only for `zh-CN` queries. |

## Per-platform detail

### Reddit — `benthepythondev/reddit-archive-scraper`
- **Why:** replaced `trudax/reddit-scraper-lite` (recent-only). The archive actor
  queries the public PullPush archive with a real `afterDate`/`beforeDate`
  window, so we get a true 6-month (or multi-year) backfill, no Reddit login.
- **Input:** `searchQuery` (the query's **primary keyword**, since the actor
  takes one term), `afterDate`/`beforeDate` (6-month window, `YYYY-MM-DD`),
  `maxPosts: 200`, `includeComments: false` (comments are the cost driver and
  irrelevant to mention counts).
- **Output normalization:** reads `id`, `title`, `selftext`, `author`, `score`,
  `num_comments`, `permalink`, `created_utc`/`created_iso`. Relative permalinks
  are resolved to full `reddit.com` URLs.

### TikTok — `scrapeforge/tiktok-posts`
- **Why:** replaced `clockworks/tiktok-scraper`. scrapeforge exposes a
  `datePosted` preset so we can scope to `last-6-months`.
- **Input:** `keyword` (primary), `hashtag` (primary), `datePosted:
  "last-6-months"`, `maxResults: 200`, `sortBy: "relevance"`, `region` (geo).
- **Honest limit:** TikTok has no exact `after/before` — only preset buckets
  (week/month/3mo/6mo/all-time). `last-6-months` is the closest to our window.
- **Output normalization:** unchanged — scrapeforge returns the same shape the
  existing `normalizeTikTok` already reads (`authorMeta.name/fans`, `diggCount`,
  `commentCount`, `shareCount`, `playCount`, `createTime`/`createTimeISO`,
  `hashtags[].name`).

### X (Twitter) — `xquik/x-tweet-scraper` (new source)
- **Why:** added at your request. X search is free-text, so it doesn't have
  IG's exact-hashtag problem, and it supports real `since`/`until` date search.
- **Input:** `searchTerms` (**all** keyword variants — free-text), `since`/`until`
  (6-month window, format `YYYY-MM-DD_00:00:00_UTC`), `maxItems: 200`, `lang`.
- **Output normalization (`normalizeX`):** `id`, `text`, `createdAt`, `url`,
  `likeCount`, `retweetCount`→shares, `replyCount`→comments, `viewCount`, and
  author (`author.username/followers/verified`, or flat aliases).
- **Caveat:** treat X as supporting/lower-weight; **absence** of X signal is not
  meaningful (may just be scrape incompleteness), so don't read "no X" as "not
  trending."

### Instagram — `apify/instagram-scraper` (recent-only + variant preprocessing)
- **No swap exists:** IG doesn't expose date-windowed search — you get the most
  recent posts a hashtag currently surfaces (a **result cap**, not a time
  window). Real IG history is built by scraping forward over time.
- **Pre-processing (new):** IG matches **exact** tag strings, so
  `#functionalgummies` ≠ `#functionalgummy`. `expandHashtagVariants()` expands
  each hashtag into common morphological variants (singular/plural; strips
  `#`, spaces, underscores), de-dupes, and builds one `explore/tags/<tag>` URL
  per variant. Bounded (~2–3 per tag); empty tags just return nothing, so extra
  variants are cheap.
- **Input:** `directUrls` (expanded tag pages), `resultsType` posts/reels,
  `resultsLimit: 200`.

### Google Trends — `apify/google-trends-scraper`
- Kept unchanged. Native time series; we pass the top ~5 keyword phrases and a
  `today 3-m` range. Skipped for `CN` geography.

## How a query becomes searches (recap)
Each scout query already expands to ~10 keyword variants + a hashtag set at
generation. Per platform: **IG** = hashtags only (now variant-expanded);
**TikTok** = primary keyword + hashtag; **Reddit** = primary keyword;
**X** = all keyword variants (free-text); **Google Trends** = top keywords.

## Cost shape per scrape
Per scout query the fan-out fires ~5–6 actor runs (IG posts + IG reels, TikTok,
Reddit, X, Google Trends). For the 10-query test batch that's ~50–60 runs.
Pricing (per 1k results): Reddit ~$3, TikTok ~$0.30, X ~$0.15, plus IG/Trends.
