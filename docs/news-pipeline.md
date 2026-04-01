# News & Information Agent Pipeline

This document describes every agent used to discover, process, and broadcast news on Pulse — how each one works, which sources it draws from, a usefulness assessment, a walkthrough of the full pipeline, and a rough cost estimate for running the station 24 hours a day.

---

## Table of Contents

- [Overview](#overview)
- [Scout Agents (Collection)](#scout-agents-collection)
  - [Firecrawl Scanner](#1-firecrawl-scanner)
  - [RSS Scanner](#2-rss-scanner)
  - [Reddit Scout](#3-reddit-scout)
  - [Trending Scout](#4-trending-scout)
- [Processing Agents](#processing-agents)
  - [News Deduplicator](#5-news-deduplicator)
  - [Editor Agent](#6-editor-agent)
  - [Article Enricher](#7-article-enricher)
  - [Research Agent](#8-research-agent)
- [Orchestration Agents](#orchestration-agents)
  - [Auto-Pilot](#9-auto-pilot)
  - [Schedule Planner](#10-schedule-planner)
- [End-to-End Pipeline](#end-to-end-pipeline)
- [Cost Estimate](#cost-estimate)

---

## Overview

The news pipeline runs on a **60-minute cycle** driven by the Auto-Pilot. Each cycle collects raw story candidates from four independent scouts, deduplicates them semantically, passes the unique set through an editorial AI that produces structured briefs, enriches each brief by fetching and analysing source articles, and finally uses the enriched briefs to generate a programming schedule for the presenter.

```
┌──────────────────────────────────────────────────────┐
│                    AUTO-PILOT (60 min)                │
│                                                      │
│  Scouts ──► Dedup ──► Editor ──► Enricher ──► Planner│
│  (parallel)          (Pro)      (Flash Lite)  (Pro)  │
└──────────────────────────────────────────────────────┘
```

---

## Scout Agents (Collection)

All four scouts run **in parallel** at the start of every scan cycle.

---

### 1. Firecrawl Scanner

**File:** `agent-server/src/lib/agents/firecrawl-scanner.ts`

#### How it works

1. Iterates over every keyword defined in the station's Firecrawl source config (default: `"artificial intelligence"`, `"AI startups"`, `"large language models"`).
2. Calls `Firecrawl.search(keyword, { limit, sources: ['news'] })` for **each keyword independently** via `Promise.allSettled`, so one failing keyword does not block the others.
3. Maps every result to a `NewsCandidate` containing the headline, a ≤500-character snippet, the article URL, the publishing domain, publish date (parsed from Firecrawl's relative date strings such as "14 minutes ago"), and any available thumbnail.
4. Maintains an in-memory `seenUrls` set across calls in the same cycle to avoid returning the same article twice.

#### Sources

- **Firecrawl Search API** — real-time web search returning structured, LLM-ready markdown content and metadata. Covers the entire open web; what gets indexed depends on the search query.

#### Default config (station defaults)

```json
{
  "type": "firecrawl",
  "config": {
    "keywords": ["artificial intelligence", "AI startups", "large language models"],
    "limit": 10
  }
}
```

Up to 10 articles per keyword → up to **30 candidates** per scan cycle.

#### Raw score assigned

Every candidate gets `rawScore: 65` (above the RSS baseline of 50).

#### Usefulness rating: ⭐⭐⭐⭐⭐

**Highest-value scout.** Returns structured, clean content (markdown + snippets + images) from any publicly accessible page in a single API call, without needing to know which publication to monitor. Keyword precision gives editorial control over topic focus, and the structured output means no further HTML parsing is needed. The primary limitation is API credit cost, which scales with the number of keywords and result limit.

---

### 2. RSS Scanner

**File:** `agent-server/src/lib/agents/rss-scanner.ts`

#### How it works

1. Fetches each configured RSS feed URL concurrently using `rss-parser` (10-second timeout, custom `User-Agent`).
2. For each feed item, extracts: title, link/GUID (used as the unique URL), content snippet (HTML stripped), publication date, and images from three sources — `<enclosure>`, `<media:content>`, and inline `<img>` tags in the full article body.
3. Maintains a `seenUrls` set to suppress duplicates within the same scan.
4. Assigns `rawScore: 50` and uses the feed's own title (e.g. "TechCrunch") as the source label.

#### Sources

| Feed | URL |
|------|-----|
| **TechCrunch** | `https://techcrunch.com/feed/` |
| **The Verge** | `https://www.theverge.com/rss/index.xml` |
| Additional feeds | Configurable per station |

RSS feeds typically refresh every 15–30 minutes, so article age at scan time is usually under an hour.

#### Usefulness rating: ⭐⭐⭐⭐

**Reliable, zero-LLM-cost source of authoritative tech journalism.** TechCrunch and The Verge cover funding rounds, product launches, acquisitions, and regulatory news with high editorial standards. Because the source is structured XML, there are no API calls beyond a simple HTTP fetch — it is the cheapest source per article. Its weakness is that it only surfaces stories that those specific outlets have already written; it misses breaking news from smaller publications and community-driven content.

---

### 3. Reddit Scout

**File:** `agent-server/src/lib/agents/reddit-scout.ts`

#### How it works

1. For each configured subreddit, calls the public Reddit JSON API (`/r/{subreddit}/{sortBy}.json?limit=25`) with a 10-second timeout.
2. Filters posts below the `minUpvotes` threshold before they are considered candidates.
3. Maps each remaining post to a `NewsCandidate`. For self-posts the URL points to the Reddit thread; for link posts the URL is the external link.
4. Computes `rawScore` from upvote count using a step function (≥1000 → 90, ≥500 → 75, ≥100 → 60, ≥50 → 45, < 50 → 30).
5. Extracts preview images from Reddit's `preview.images` array and thumbnail fallback.

#### Sources

| Subreddit | Sort | Min upvotes |
|-----------|------|-------------|
| `r/MachineLearning` | `hot` | 100 |
| `r/artificial` | `hot` | 50 |

#### Usefulness rating: ⭐⭐⭐

**Valuable for community signal, noisy in practice.** High-upvote posts on r/MachineLearning often contain links to research papers, model releases, or industry news before they appear in mainstream media. The upvote score is a useful crowd-sourced relevance proxy. However the majority of Reddit posts are opinion threads, discussions, memes, or self-promotion — the Editor Agent is explicitly instructed to discard these and only keep posts that contain or link to real news. This filtering step means many Reddit candidates are discarded, reducing its effective throughput. Reddit also returns at most 25 posts per subreddit regardless of how many are newsworthy.

---

### 4. Trending Scout

**File:** `agent-server/src/lib/agents/trending-scout.ts`

#### How it works

1. Joins the configured keywords into a single comma-separated query string.
2. Makes one `generateContent` call to `gemini-3.1-flash-lite-preview` with the `{ googleSearch: {} }` grounding tool enabled. The system prompt instructs the model to write one headline and a 2–3 sentence summary per trending story (up to 10 stories), focusing only on the past 3 days.
3. Parses the response's **grounding metadata** — `groundingChunks` (source URLs) and `groundingSupports` (text segments linked to those sources) — rather than the model's free-text output. This ensures every story is backed by a real, verifiable search result.
4. Groups adjacent grounding segments that share source URLs into story-level clusters.
5. Resolves Google redirect URLs (`vertexaisearch.cloud.google.com`) to their final destinations via a HEAD request.
6. Returns one `NewsCandidate` per cluster, with `rawScore` descending from 70 by 5 points per story.

#### Sources

- **Google Search** (via Gemini's `googleSearch` grounding tool) — covers the full open web as indexed by Google, with real-time freshness.

#### Default keywords

`"AI news"`, `"startup funding"`, `"large language models"`, `"tech IPO"`

#### Usefulness rating: ⭐⭐⭐⭐

**Best at surfacing emerging trends.** The grounding approach means the model's output is anchored to real articles rather than hallucinated. It can discover stories from any news outlet — not only those in the RSS feed list — and is especially good at catching stories that are trending but have not yet been published on major tech outlets. Its weaknesses: one LLM call per cycle (Flash Lite cost is low but non-zero), source images are not included, and the grounding approach depends on Google Search's own freshness and indexing.

---

## Processing Agents

### 5. News Deduplicator

**File:** `agent-server/src/lib/news-dedup.ts`

#### How it works

Runs **before** the Editor Agent to avoid sending duplicate candidates to the more expensive Pro model.

**Phase 1 — URL deduplication:**
Normalises each candidate's URL (strips UTM parameters, `ref`, `fbclid`, trailing slashes, `www.` prefix) and drops exact URL matches.

**Phase 2 — Semantic embedding deduplication:**
1. Concatenates each candidate's headline and summary into a single text string.
2. Batches all strings into a single `embedContent` call to `text-embedding-004`, receiving a 768-dimensional vector per text.
3. Computes cosine similarity against all previously stored embeddings (loaded from SQLite) and against all new embeddings generated in the same batch.
4. Thresholds:
   - **≥ 0.85** → duplicate, discarded.
   - **0.70–0.85** → related (different angle on the same story), kept but flagged.
   - **< 0.70** → unique.
5. Saves new vectors to SQLite (capped at 1,000 per station, oldest pruned).

#### Sources

- `text-embedding-004` (Google AI)

#### Usefulness rating: ⭐⭐⭐⭐

**Essential for cost control and editorial quality.** Without deduplication, the Editor Agent would receive hundreds of near-identical articles about the same story, wasting Pro model tokens and potentially generating multiple briefs for the same event. The two-phase approach (URL then semantic) is efficient: URL dedup is free and instant; semantic dedup catches the same story reported under different headlines from different outlets. The main limitation is that embedding-based dedup can occasionally be over-aggressive when two stories share vocabulary but are genuinely different events.

---

### 6. Editor Agent

**File:** `agent-server/src/lib/agents/editor-agent.ts`

#### How it works

1. Receives all unique, deduplicated `NewsCandidate` objects since the last processing run.
2. Serialises each candidate into a text block (ID, source, headline, summary, URL, raw score, key points, discussion angles) and passes the full list to `gemini-3.1-pro-preview` with a detailed system prompt.
3. The model is instructed to:
   - **Group** candidates about the same event into one brief, listing all source IDs.
   - **Filter** off-topic candidates (politics unrelated to tech, sports, celebrity gossip) and Reddit opinion threads.
   - **Assign** a confidence level: `confirmed` (stable story), `developing` (key facts expected within 48h), or `rumor` (single low-authority source).
   - **Set** `isBreaking: true` for major, just-breaking events.
   - **Score** priority 0–100 based on relevance, urgency, and source count.
   - **Flag** `needsResearch: true` for stories where available information is thin.
   - **Set** a `recheckIntervalMinutes` for developing stories (60, 180, or 720 min; 1440 for confirmed).
4. Returns up to 15 `EditorialBrief` objects as a JSON array.
5. A post-processing step merges any briefs that the model still duplicated (sharing `relatedCandidateIds` overlap).
6. Also assembles `sources` arrays by cross-referencing candidate IDs, plus a fuzzy headline-word match to catch sources the model missed.

#### Sources

- `gemini-3.1-pro-preview` (Google AI)

#### Usefulness rating: ⭐⭐⭐⭐⭐

**The newsroom brain.** This is the highest-value editorial transformation in the entire pipeline. Without the Editor Agent, the presenter would receive 30–60 raw, overlapping snippets per hour. With it, those collapse into ≤15 well-structured, prioritised, source-attributed briefs. Using the Pro model gives noticeably better editorial judgement than Flash — it correctly groups multi-source stories, applies the `developing` label conservatively, and writes radio-ready summaries. The main cost is Pro model pricing; however, one call per 65-minute cycle keeps the total manageable.

---

### 7. Article Enricher

**File:** `agent-server/src/lib/agents/article-enricher.ts`

#### How it works

For each new brief:

1. **URL collection** — gathers every source URL from `brief.sources` and from related candidates (excluding Reddit threads, which have no article content).
2. **Source fetching** — fetches all URLs concurrently (max 5 at a time) via Firecrawl scrape (primary) with a plain HTTP fallback. Firecrawl returns clean markdown; the fallback strips `<script>`, `<style>`, `<nav>`, `<footer>`, and `<aside>` tags then extracts the `<article>` or `<main>` element. Pages with fewer than 300 usable characters are marked as no-content.
3. **LLM report generation** — passes the brief metadata and all source texts (truncated to 12,000 characters each) to `gemini-3.1-flash-lite-preview`. The model produces a structured JSON report containing:
   - `broadcastSummary` — a 4–8 sentence radio-ready narrative.
   - `keyFindings` — 4–8 specific facts with numbers, names, and dates.
   - `analysisAngles` — 3–5 angles the host can explore on air.
   - `relatedTopics` — 2–4 connected themes.
   - `editorialNotes` — guidance on what to emphasise or treat with caution.
   - `informationQuality` — `"rich"` / `"adequate"` / `"thin"`.
   - `turnPrompts` — **10–15 sequential mini-briefs** (4–8 sentences each), forming a non-overlapping narrative arc from hook to wrap-up. Each prompt contains the specific facts, names, and figures the host needs for ~20–30 seconds of live commentary.
4. **Auto-research fallback** — if `informationQuality === "thin"` or no content was fetched, the Research Agent is called automatically.

#### Sources

- **Firecrawl Scrape API** (primary content extraction)
- Plain HTTP with custom HTML parser (fallback)
- `gemini-3.1-flash-lite-preview` (report generation)

#### Usefulness rating: ⭐⭐⭐⭐⭐

**The engine behind multi-minute deep dives.** The 10–15 turn prompts are what enable the presenter to speak substantively for 8–12 minutes on a single story without repeating itself. Without this layer, the presenter would have only the 1–2 sentence editor summary to work from. The structured `keyFindings` and `analysisAngles` also make the presenter's output far more credible. The main practical limitation is that paywalled articles return no usable content, triggering the Research Agent fallback.

---

### 8. Research Agent

**File:** `agent-server/src/lib/agents/research-agent.ts`

#### How it works

Activated in two ways: automatically by the Article Enricher when source content is thin, or manually from the admin news desk.

**Phase 1 — Google Search grounding:**
1. Constructs a query from the brief's headline, current summary, and a strict date window (last 3 days).
2. Calls `gemini-3.1-flash-lite-preview` with `{ googleSearch: {} }` grounding enabled.
3. Extracts grounded text segments and resolves all source URLs from the grounding metadata.

**Phase 2 — Firecrawl independent search + deep scrape:**
1. Calls `Firecrawl.search(headline, { limit: 5 })` independently to find additional sources not covered by Google grounding.
2. Scrapes the top 3 new results for full markdown content (up to 6,000 chars each).
3. Also deep-scrapes up to 3 top grounding URLs via Firecrawl for richer content than grounding alone provides.

**Phase 3 — Synthesis:**
If both Google and Firecrawl returned useful content, a second LLM call synthesises all material into a 6–10 sentence radio-ready summary, 4–8 key facts, and a confidence classification. If only one channel returned data, the grounded text is used directly.

Updates the brief with the richer summary, upgraded confidence (if warranted), and all newly discovered source URLs and any images from grounding chunks.

**Periodic re-research (`recheckDeveloping`):**
The Auto-Pilot polls every 15 minutes for `developing` or `rumor` briefs whose `recheckIntervalMs` has elapsed. Each such brief is passed through the Research Agent again so the presenter always has the latest facts on evolving stories.

#### Sources

- **Google Search** (Gemini grounding tool)
- **Firecrawl Search API** (independent search for new sources)
- **Firecrawl Scrape API** (full content extraction)
- `gemini-3.1-flash-lite-preview` (Phase 1 + synthesis)

#### Usefulness rating: ⭐⭐⭐⭐

**Excellent safety net; dual-source approach is thorough.** The combination of Google Search grounding (broad coverage) and Firecrawl search/scrape (deep content) gives the Research Agent significantly more material than either tool alone. The synthesis pass produces research-grade summaries from multiple cross-checked sources. Its limitation is latency — it adds 10–30 seconds per brief — and it is only triggered reactively rather than run proactively for every story. It is also only as good as what is publicly available; paywalled premium content is not accessible.

---

## Orchestration Agents

### 9. Auto-Pilot

**File:** `agent-server/src/lib/auto-pilot.ts`

The Auto-Pilot is not itself an AI model but the timer-based coordinator that drives the entire pipeline.

| Timer | Interval | Action |
|-------|----------|--------|
| Scan | 60 min | Runs all four scouts in parallel; deduplicates and stores new candidates |
| Process | 65 min | Passes new candidates to Editor Agent; starts background enrichment |
| Recheck | 15 min | Re-researches developing/rumor briefs whose recheck window has elapsed |

The 5-minute offset between scan and process ensures candidates from the scan are written to the database before the editor run begins. The first scan fires immediately at startup; the first process run is delayed 30 seconds.

---

### 10. Schedule Planner

**File:** `agent-server/src/lib/agents/schedule-planner.ts`

Generates the next 2–3 hours of programming from available enriched briefs and the music library. Uses `gemini-3.1-pro-preview` with a strict JSON schema (structured output) to produce a list of typed blocks: `topic`, `music`, `guest`, and `calls`. It respects show history (from the Daily Memory module) to avoid repeating stories covered in the past two days, and packs blocks tightly with zero dead air.

---

## End-to-End Pipeline

```
T+0   AUTO-PILOT scan fires
      │
      ├─► Firecrawl Scanner (3 keywords × 10 results)  ─┐
      ├─► RSS Scanner (TechCrunch + The Verge)          ─┤
      ├─► Reddit Scout (r/MachineLearning, r/artificial) ─┤
      └─► Trending Scout (Gemini Flash Lite + Google)   ─┘
                                                         │
                                                         ▼
T+~30s  NewsDedup
        Phase 1: URL normalisation & exact-match filter
        Phase 2: text-embedding-004 cosine similarity
           ≥0.85 → discard | 0.70–0.85 → related | <0.70 → unique
        Saves new embeddings to SQLite
                                                         │
                                                         ▼
T+5min  AUTO-PILOT process fires
        Loads unique candidates from last hour
        Filters out candidate IDs already covered by existing briefs
                                                         │
                                                         ▼
        Editor Agent (gemini-3.1-pro-preview)
        Groups, filters, classifies, prioritises
        → Up to 15 EditorialBrief objects
        → Saved to SQLite; onBriefsReady callback fires
                                                         │
                                              ┌──────────┘
                                              │ (background, concurrent)
                                              ▼
        Article Enricher (per brief, up to 5 concurrent)
        1. Collect source URLs from brief + related candidates
        2. Fetch all URLs via Firecrawl scrape (or HTTP fallback)
        3. gemini-3.1-flash-lite: generate report + 10-15 turn prompts
        4. If informationQuality === "thin" → trigger Research Agent
                                              │
                          ┌───────────────────┘
                          │ (only for thin briefs)
                          ▼
        Research Agent (gemini-3.1-flash-lite + googleSearch + Firecrawl)
        Phase 1: Google Search grounding
        Phase 2: Firecrawl search for new sources + deep scrape
        Phase 3: Synthesis LLM pass (if dual-channel data)
        → Updates brief summary, sources, confidence, images
                          │
                          └───────────────────┐
                                              │
                                              ▼
        Updated briefs saved to SQLite
        Schedule Planner triggered (gemini-3.1-pro-preview)
        → Generates 2–3h programming schedule
        → Scheduler begins executing blocks (15-second loop)
                                              │
                                              ▼
        Presenter (ElevenLabs Conversational AI — Daniel)
        Receives turn prompts block by block
        Speaks live; co-host joins after turn prompts exhausted
```

### Recheck loop (parallel, every 15 min)

```
Auto-Pilot recheckDeveloping()
  Load all briefs with confidence != "confirmed"
  Filter: not concluded, not older than 3 days, recheck interval elapsed
  For each due brief → Research Agent (same 3-phase process)
  If confidence upgrades to "confirmed" → log event
```

---

## Cost Estimate

The following estimates assume the station runs **24 hours a day, 7 days a week** with the default configuration (3 Firecrawl keywords, 2 RSS feeds, 2 subreddits, 4 Trending Scout keywords). Costs are approximate — actual spend depends on article length, model output variance, and API tier pricing.

### Assumptions per 60-minute cycle

| Variable | Estimate |
|----------|----------|
| New candidates collected | ~35 |
| Unique candidates after dedup | ~20 |
| New briefs generated by Editor | ~8 |
| Briefs enriched (sources fetched) | ~8 |
| Avg source URLs per brief | 3 |
| Briefs triggering Research Agent | ~2 |
| Schedule Planner calls | 1 |

### Google Gemini

| Agent | Model | Approx. tokens/call | Calls/day | Monthly tokens | Monthly cost |
|-------|-------|---------------------|-----------|----------------|--------------|
| Trending Scout | `gemini-3.1-flash-lite` | 500 in / 1,200 out | 24 | 0.36M in / 0.86M out | ~$0.29 |
| News Dedup | `text-embedding-004` | ~4,000 chars/scan | 24 | ~8.6M chars | ~$0.17 |
| Editor Agent | `gemini-3.1-pro` | 5,000 in / 3,000 out | ~22 | 3.3M in / 2.0M out | ~$14 |
| Article Enricher | `gemini-3.1-flash-lite` | 16,000 in / 3,500 out | 192 (8×24) | 59M in / 13M out | ~$8 |
| Research Agent | `gemini-3.1-flash-lite` | 9,000 in / 1,800 out | 48 (2×24) | 13M in / 2.6M out | ~$2 |
| Schedule Planner | `gemini-3.1-pro` | 8,500 in / 2,500 out | 24 | 6M in / 1.8M out | ~$17 |
| **Total Gemini** | | | | | **~$41/month** |

> Gemini 3.1 pricing used: Flash Lite ~$0.075/1M input tokens, ~$0.30/1M output; Pro ~$1.25/1M input, ~$5.00/1M output; `text-embedding-004` ~$0.000020/1K characters. Prices are approximate and subject to change.

### Firecrawl

| Operation | Credits/call | Calls/cycle | Credits/day | Credits/month |
|-----------|-------------|-------------|-------------|---------------|
| Firecrawl Scanner (3 keywords) | 3 each | 3 | 216 | ~6,500 |
| Article Enricher (scrape source URLs) | 1 each | ~24 (8 briefs × 3 URLs) | 576 | ~17,000 |
| Research Agent (search + scrape, 2 briefs) | ~6 each | 2 | 288 | ~8,600 |
| **Total Firecrawl** | | | **~1,080/day** | **~32,000/month** |

At 32,000 credits/month, the **Firecrawl Standard plan ($99/month, 100,000 credits)** provides comfortable headroom.

> Firecrawl credit rates used: Search API = 3 credits/call; Scrape API = 1 credit/URL. Pricing is approximate and subject to change.

### ElevenLabs

| Session | Active hours/day | Min/month | Rate | Monthly cost |
|---------|-----------------|-----------|------|--------------|
| Presenter (Pulse — Daniel) | 24h | ~43,200 | ~$0.05/min | ~$2,160 |
| Co-Host (Nova — Lily) | ~0.5h | ~900 | ~$0.05/min | ~$45 |
| Guest Expert | ~0.3h | ~540 | ~$0.05/min | ~$27 |
| Screener (Jessica) | ~0.3h | ~540 | ~$0.05/min | ~$27 |
| Music generation (100 tracks/mo) | — | — | ~$0.25/track | ~$25 |
| **Total ElevenLabs** | | | | **~$2,284/month** |

> ElevenLabs Conversational AI pricing used: ~$0.05/minute (enterprise bulk estimate). Actual pricing depends on plan tier negotiated with ElevenLabs. The presenter session is active continuously, making it the single largest cost in the entire system.

### Summary

| Service | Monthly estimate |
|---------|-----------------|
| Google Gemini (LLM + embeddings) | ~$41 |
| Firecrawl (search + scrape) | ~$99 (Standard plan) |
| ElevenLabs voice (Conversational AI) | ~$2,259 |
| ElevenLabs music generation | ~$25 |
| **Total** | **~$2,424/month** |

### Cost breakdown observations

1. **ElevenLabs voice is the dominant cost (~93% of the total)** because the presenter session runs 24/7. The Gemini and Firecrawl spend together amount to less than 6% of the total.
2. **Firecrawl is the largest news-pipeline cost** ($99/month), driven primarily by Article Enricher scraping multiple source URLs per brief.
3. **Gemini Pro (Editor + Schedule Planner) accounts for ~75% of Gemini spend** because editorial reasoning and structured schedule generation require the higher-capability model.
4. Costs scale roughly linearly with the number of keywords and the `limit` per Firecrawl search; reducing these is the most effective lever for controlling the news-pipeline budget without touching voice costs.
5. At lower operating hours (e.g. 8h/day instead of 24h), the ElevenLabs cost drops proportionally to ~$756/month and the total falls to roughly **~$920/month**.
