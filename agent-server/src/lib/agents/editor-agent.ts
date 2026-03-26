import { GoogleGenAI } from '@google/genai'
import type { NewsCandidate, EditorialBrief, SourceType } from '../../types/news.js'

const SYSTEM_PROMPT = `You are the Editor-in-Chief AI for "Pulse", a live AI radio station focused on AI, startups, and tech.

Your job is to COMPACT and GROUP all news candidates into editorial briefs. You must be INCLUSIVE — every real news story from RSS feeds, news APIs, and search results MUST appear in your output. Do NOT discard news just because it seems less relevant.

## Core Rules

1. INCLUDE EVERYTHING THAT IS REAL NEWS about AI, startups, or technology — every candidate from RSS feeds (rss), web search (firecrawl), and search results (gemini-search) MUST be represented in at least one brief. You can compact multiple stories into a grouped brief (e.g. "Tech Industry Roundup") but never silently drop them.
2. TOPIC FILTER — This radio station covers AI, startups, and technology ONLY. If a candidate is clearly off-topic (politics unrelated to tech, sports, celebrity gossip, etc.), you MAY exclude it. When in doubt, include it.
3. GROUP BY STORY — if multiple candidates describe the SAME event/announcement from different sources, merge them into ONE brief with ALL their candidate IDs in "relatedCandidateIds". The more sources, the better.
4. Reddit (reddit) is the ONLY source you may freely exclude from — filter out Reddit posts that are just discussions, opinion threads, memes, or self-promotion. Keep Reddit posts only if they report actual news or link to real news articles.
5. Confidence — this is about whether the story will have IMMINENT updates (next 24-48h):
   - "confirmed" = The story is COMPLETE or STABLE. Use when: (a) 2+ sources agree, OR (b) a single authoritative source reports a finished event (product launched, funding closed, acquisition completed, research published, earnings reported), OR (c) the story describes a situation that won't meaningfully change in the next 48 hours — even if it's technically "ongoing" (e.g. "Company in acquisition talks" → talks could last months, no imminent update expected → confirmed). The test: "Will there be a concrete, newsworthy update within 48 hours?" If unlikely → confirmed.
   - "developing" = Key facts will likely change or be revealed WITHIN 24-48 HOURS. Use ONLY for: events actively unfolding right now (ongoing outage, live event, vote happening today, launch expected this week, regulatory decision imminent, breaking incident with details still emerging). The story must have a SHORT-TERM resolution timeline. If the outcome could take weeks or months → it's NOT developing, it's confirmed.
   - "rumor" = Unverified claim from a single low-authority source (anonymous tweet, Reddit speculation, unnamed sources). No credible outlet has reported it.
   
   IMPORTANT: Most news is "confirmed". The "developing" tag is RARE — reserved for stories where you genuinely expect a meaningful update within 1-2 days. Examples: "Company X raises $50M" → confirmed. "Major AWS outage ongoing" → developing. "Company reportedly in acquisition talks" → confirmed (talks take months). "SpaceX launch scheduled for tomorrow" → developing. "New AI model released" → confirmed.
6. Priority: 0-100. Relevance to AI/startups + urgency + novelty + source count. Stories with multiple sources get a priority boost.
7. isBreaking: true ONLY for stories that just happened with major impact.
8. Summary: Write a substantive, radio-ready summary the host can use as a full segment. Include the key facts, context, and implications. If Key Points and Discussion Angles are available for a candidate, weave them naturally into the summary. The host should be able to talk 30-60 seconds just from this summary. Conversational and engaging. Naturally mention which sources reported it.
9. Headline: Punchy, radio-ready. No clickbait.
10. If you have many stories, group minor ones into a roundup brief (e.g. "AI & Tech Quick Hits") — but still list ALL their candidate IDs so we can trace every story.
11. When candidates have Discussion Angles, include the most interesting 1-2 in the summary as talking points the host can explore.

## Output Format

Return a JSON array. Each brief:
- "headline": string
- "summary": string (presenter-ready, conversational)
- "confidence": "confirmed" | "developing" | "rumor"
- "priority": number 0-100
- "isBreaking": boolean
- "relatedCandidateIds": string[] (ALL candidate IDs that cover this story — this is critical for source tracking)
- "needsResearch": boolean (true if the story sounds interesting/important but the available information is thin, vague, or lacks concrete details — our research team will dig deeper on these)
- "recheckIntervalMinutes": number (how often this story should be re-checked for updates. Only meaningful for "developing" stories. Use 60 for fast-moving/breaking situations, 180 for standard developing stories, 720 for slow-burn developments. For "confirmed" stories use 1440. For "rumor" use 120.)

Return ONLY valid JSON, no markdown fences, no extra text. Up to 15 briefs, ordered by priority descending. NEVER repeat the same story twice.`

interface BriefJson {
  headline: string
  summary: string
  confidence: string
  priority: number
  isBreaking: boolean
  relatedCandidateIds: string[]
  needsResearch?: boolean
  recheckIntervalMinutes?: number
}

export class EditorAgent {
  private ai: GoogleGenAI

  constructor(apiKey: string) {
    // 3.1 models require global location
    const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
    process.env.GOOGLE_CLOUD_LOCATION = 'global'
    this.ai = new GoogleGenAI({ apiKey })
    if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
    else delete process.env.GOOGLE_CLOUD_LOCATION
  }

  async process(candidates: NewsCandidate[]): Promise<EditorialBrief[]> {
    if (candidates.length === 0) return []

    const candidateText = candidates.map((c) => {
      let entry = `[${c.id}] (${c.source} — ${c.sourceLabel}) ${c.headline}\n${c.summary}\nURL: ${c.url}\nScore: ${c.rawScore}`
      if (c.keyPoints?.length) {
        entry += `\nKey Points: ${c.keyPoints.join('. ')}`
      }
      if (c.discussionTopics?.length) {
        entry += `\nDiscussion Angles: ${c.discussionTopics.join('; ')}`
      }
      return entry
    }).join('\n\n')

    const response = await this.ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: `Here are the raw news candidates to process:\n\n${candidateText}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.4,
      },
    })

    const text = response.text?.trim() ?? ''
    const items = parseJsonResponse(text)

    const now = Date.now()
    const briefs = items.map((item, i) => ({
      id: `brief-${now}-${i}`,
      headline: item.headline,
      summary: item.summary,
      confidence: validateConfidence(item.confidence),
      priority: Math.max(0, Math.min(100, item.priority ?? 50)),
      isBreaking: item.isBreaking === true,
      sources: extractSources(candidates, item.relatedCandidateIds ?? [], item.headline ?? ''),
      relatedCandidateIds: item.relatedCandidateIds ?? [],
      generatedAt: now,
      used: false,
      imageUrl: pickBestImage(candidates, item.relatedCandidateIds ?? []),
      imageUrls: collectAllImages(candidates, item.relatedCandidateIds ?? []),
      needsResearch: item.needsResearch === true,
      recheckIntervalMs: clampRecheckInterval(item.recheckIntervalMinutes),
      activityLog: [{ timestamp: now, action: 'created' as const, detail: `Generated from ${item.relatedCandidateIds?.length ?? 0} candidates` }],
    }))

    // Post-processing: merge briefs that share candidate IDs (LLM sometimes still duplicates)
    return deduplicateBriefs(briefs)
  }
}

const MIN_RECHECK_MS = 60 * 60_000     // 1 hour minimum
const MAX_RECHECK_MS = 24 * 60 * 60_000 // 24 hours maximum
const DEFAULT_RECHECK_MS = 3 * 60 * 60_000 // 3 hours default

function clampRecheckInterval(minutes?: number): number {
  if (typeof minutes !== 'number' || minutes <= 0) return DEFAULT_RECHECK_MS
  const ms = minutes * 60_000
  return Math.max(MIN_RECHECK_MS, Math.min(MAX_RECHECK_MS, ms))
}

function deduplicateBriefs(briefs: EditorialBrief[]): EditorialBrief[] {
  // Sort by priority descending so the best version wins
  const sorted = [...briefs].sort((a, b) => b.priority - a.priority)
  const merged: EditorialBrief[] = []
  const consumedCandidateIds = new Set<string>()

  for (const brief of sorted) {
    const ids = brief.relatedCandidateIds
    const overlap = ids.some((id) => consumedCandidateIds.has(id))

    if (overlap) {
      // Find the existing brief that shares candidates and merge sources into it
      const existing = merged.find((m) =>
        m.relatedCandidateIds.some((id) => ids.includes(id))
      )
      if (existing) {
        for (const id of ids) {
          if (!existing.relatedCandidateIds.includes(id)) {
            existing.relatedCandidateIds.push(id)
          }
        }
        for (const src of brief.sources) {
          if (!existing.sources.some((s) => s.url === src.url && s.label === src.label)) {
            existing.sources.push(src)
          }
        }
        if (brief.isBreaking) existing.isBreaking = true
        if (!existing.imageUrl && brief.imageUrl) existing.imageUrl = brief.imageUrl
        // Merge imageUrls arrays
        if (brief.imageUrls?.length) {
          const set = new Set(existing.imageUrls ?? [])
          for (const url of brief.imageUrls) set.add(url)
          existing.imageUrls = [...set]
        }
        if (existing.confidence === 'developing' || existing.confidence === 'rumor') {
          existing.confidence = 'confirmed'
        }
      }
      continue
    }

    for (const id of ids) consumedCandidateIds.add(id)
    merged.push(brief)
  }

  return merged
}

function validateConfidence(val: string): 'confirmed' | 'developing' | 'rumor' {
  if (val === 'confirmed' || val === 'developing' || val === 'rumor') return val
  return 'developing'
}

function extractSources(
  candidates: NewsCandidate[],
  ids: string[],
  briefHeadline: string
): Array<{ type: SourceType; label: string; url: string }> {
  const idSet = new Set(ids)
  const matched = candidates.filter((c) => idSet.has(c.id))

  // Also find candidates with very similar headlines that the LLM missed linking
  const headlineWords = new Set(briefHeadline.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3))
  if (headlineWords.size > 0) {
    for (const c of candidates) {
      if (idSet.has(c.id)) continue
      const cWords = new Set(c.headline.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3))
      const overlap = [...headlineWords].filter((w) => cWords.has(w)).length
      const similarity = overlap / Math.max(headlineWords.size, 1)
      if (similarity >= 0.4) {
        matched.push(c)
        idSet.add(c.id)
      }
    }
  }

  // Deduplicate sources by label+url
  const seen = new Set<string>()
  const sources: Array<{ type: SourceType; label: string; url: string }> = []
  for (const c of matched) {
    const key = `${c.sourceLabel}|${c.url}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({ type: c.source, label: c.sourceLabel, url: c.url })
  }
  return sources
}

function parseJsonResponse(text: string): BriefJson[] {
  const clean = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

function pickBestImage(candidates: NewsCandidate[], ids: string[]): string | undefined {
  const idSet = new Set(ids)
  const linked = candidates
    .filter((c) => idSet.has(c.id) && c.imageUrl)
    .sort((a, b) => b.rawScore - a.rawScore)
  if (linked.length > 0) return linked[0].imageUrl

  return undefined
}

function collectAllImages(candidates: NewsCandidate[], ids: string[]): string[] {
  const idSet = new Set(ids)
  const urls = new Set<string>()
  // Collect from all linked candidates, ordered by score
  const linked = candidates
    .filter((c) => idSet.has(c.id))
    .sort((a, b) => b.rawScore - a.rawScore)
  for (const c of linked) {
    if (c.imageUrls) {
      for (const url of c.imageUrls) urls.add(url)
    } else if (c.imageUrl) {
      urls.add(c.imageUrl)
    }
  }
  return [...urls]
}
