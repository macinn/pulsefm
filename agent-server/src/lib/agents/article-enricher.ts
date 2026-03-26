import { GoogleGenAI } from '@google/genai'
import Firecrawl from '@mendable/firecrawl-js'
import type { NewsCandidate, EditorialBrief, EnrichmentReport } from '../../types/news.js'
import type { ResearchAgent } from './research-agent.js'

const MAX_ARTICLE_LENGTH = 12_000
const FETCH_TIMEOUT_MS = 8_000
const MIN_USEFUL_TEXT = 300
const MAX_CONCURRENT_FETCHES = 5

const REPORT_SYSTEM = `You are a senior news analyst preparing a comprehensive briefing for a live AI radio host. You will receive a news brief (headline, summary, confidence, sources) along with the raw text extracted from each source URL.

Your job is to produce a detailed REPORT that gives the host everything they need to cover this story in depth for 3-5 minutes on air.

Rules:
- Read ALL the source texts carefully. Cross-reference facts between sources.
- The "broadcastSummary" should be a rich, 4-8 sentence narrative covering the full story — context, what happened, who is involved, why it matters. Written conversationally for radio.
- "keyFindings" should be 4-8 specific facts, data points, or developments from the sources. Be precise — include numbers, names, dates when available.
- "analysisAngles" should be 3-5 angles the host can explore on air: implications, controversies, expert opinions, comparisons with related events, what to watch next.
- "relatedTopics" should be 2-4 related stories or broader themes the host could connect this to.
- "editorialNotes" should be 2-3 sentences of editorial guidance: what's most interesting, what's unverified, what the host should emphasize or be careful about.
- "informationQuality" must be one of: "rich" (multiple detailed sources, plenty of material), "adequate" (enough to cover but could use more depth), or "thin" (sources are sparse, paywalled, or lack detail).

CRITICAL — "turnPrompts" generation rules:

The radio host covers this story across multiple speaking turns, each lasting ~20-30 seconds of narration. Generate 10-15 sequential prompts that guide the host through a deep-dive on the story. These have STRICT requirements:

1. EACH PROMPT MUST BE A DETAILED MINI-BRIEF (4-8 sentences). Include ALL the specific information the host needs for that turn: names, numbers, dates, quotes, context, and the angle to take. The host should be able to read ONLY that prompt and deliver 20-30 seconds of rich, informed commentary without inventing anything.

2. ZERO OVERLAP between prompts. Each prompt must cover a DISTINCT facet of the story. Before writing, mentally partition the story into non-overlapping segments: the hook, the main event, each key actor/detail, each implication, context/history, counter-perspectives, and the editorial close. Then assign each segment to exactly one prompt. NEVER repeat a fact, name, number, or concept across prompts.

3. BUILD A NARRATIVE ARC with clear progression:
   - Prompt 1: The hook — dramatic opening with the core headline fact. Set the scene.
   - Prompts 2-4: The meat — each covering a DIFFERENT key finding or development. Include specific data, names, and details unique to that prompt.
   - Prompts 5-7: Deeper context — each exploring a DIFFERENT angle (industry impact, historical parallel, expert opinion, technical explanation). Only one angle per prompt.
   - Prompts 8-10: Implications and controversy — each covering a DIFFERENT consequence, concern, or debate. Bring in voices, criticism, or counterpoints.
   - Prompts 11-13: Broader connections — relate to the wider landscape, future outlook, what to watch. Each prompt a distinct thread.
   - Final prompt: Editorial wrap-up — the host's bottom-line take and a memorable closing thought.

4. USE CONCRETE DETAILS from the sources. Each prompt should contain at least 2-3 specific facts (numbers, quotes, names, dates) from the source material that are NOT used in any other prompt. If a source mentions "$845 million in contracts," that number goes in exactly ONE prompt. If "Jeramie Scott" is quoted, that quote appears in exactly ONE prompt.

5. INSTRUCT, DON'T SCRIPT. Tell the host what to talk about and give them the material, but don't write their script. Use phrases like "Explain how...", "Break down the fact that...", "Highlight the tension between...", "Point out that according to [source]...".

- Write in English. Be substantive, not generic.

Return ONLY valid JSON:
{
  "broadcastSummary": string,
  "keyFindings": string[],
  "analysisAngles": string[],
  "relatedTopics": string[],
  "editorialNotes": string,
  "informationQuality": "rich" | "adequate" | "thin",
  "turnPrompts": string[]
}`

interface SourceFetchResult {
  url: string
  label: string
  text: string | null
  charCount: number
}

interface ReportResult {
  broadcastSummary: string
  keyFindings: string[]
  analysisAngles: string[]
  relatedTopics: string[]
  editorialNotes: string
  informationQuality: 'rich' | 'adequate' | 'thin'
  turnPrompts: string[]
}

export class ArticleEnricher {
  private ai: GoogleGenAI
  private firecrawl: Firecrawl | null = null
  private researchAgent: ResearchAgent | null = null

  constructor(apiKey: string, firecrawlApiKey?: string) {
    const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
    process.env.GOOGLE_CLOUD_LOCATION = 'global'
    this.ai = new GoogleGenAI({ apiKey })
    if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
    else delete process.env.GOOGLE_CLOUD_LOCATION
    if (firecrawlApiKey) this.firecrawl = new Firecrawl({ apiKey: firecrawlApiKey })
  }

  setResearchAgent(agent: ResearchAgent) {
    this.researchAgent = agent
  }

  /** Enrich a single brief: fetch all sources, build report, auto-research if thin */
  async enrichBrief(brief: EditorialBrief, candidates: NewsCandidate[]): Promise<EditorialBrief> {
    const allUrls = collectUrls(brief, candidates)
    if (allUrls.length === 0 && !this.researchAgent) return brief

    console.log(`[enricher] brief "${brief.headline.slice(0, 60)}" — fetching ${allUrls.length} source(s)...`)

    // Fetch all source URLs with bounded concurrency
    const fetched = await this.fetchAllSources(allUrls)
    const withContent = fetched.filter((f) => f.text && f.charCount >= MIN_USEFUL_TEXT)

    console.log(`[enricher] ${withContent.length}/${fetched.length} sources had usable content`)

    // Build context for the LLM
    const sourceTexts = fetched.map((f, i) => {
      if (!f.text || f.charCount < MIN_USEFUL_TEXT) {
        return `--- SOURCE ${i + 1}: ${f.label} (${f.url}) ---\n[No usable content — paywall, empty, or fetch failed]`
      }
      return `--- SOURCE ${i + 1}: ${f.label} (${f.url}) ---\n${f.text.slice(0, MAX_ARTICLE_LENGTH)}`
    }).join('\n\n')

    const prompt = [
      `HEADLINE: ${brief.headline}`,
      `EDITOR SUMMARY: ${brief.summary}`,
      `CONFIDENCE: ${brief.confidence}`,
      `SOURCES (${fetched.length} total, ${withContent.length} with content):`,
      '',
      sourceTexts,
    ].join('\n')

    let report: ReportResult | null = null

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.1-flash-lite-preview',
        contents: prompt,
        config: {
          systemInstruction: REPORT_SYSTEM,
          temperature: 0.3,
        },
      })

      report = parseReportResult(response.text?.trim() ?? '')
    } catch (err) {
      console.warn(`[enricher] LLM report failed for "${brief.headline.slice(0, 40)}": ${(err as Error).message}`)
    }

    // If info is thin or no report, auto-research to fill gaps
    let researchedBrief = brief
    const infoIsThin = !report || report.informationQuality === 'thin' || withContent.length === 0
    if (infoIsThin && this.researchAgent) {
      console.log(`[enricher] info is thin for "${brief.headline.slice(0, 40)}" — auto-researching...`)
      try {
        researchedBrief = await this.researchAgent.research(brief)
      } catch (err) {
        console.warn(`[enricher] auto-research failed: ${(err as Error).message}`)
      }
    }

    const now = Date.now()
    const enrichmentReport: EnrichmentReport = report ? {
      broadcastSummary: report.broadcastSummary,
      keyFindings: report.keyFindings,
      analysisAngles: report.analysisAngles,
      relatedTopics: report.relatedTopics,
      editorialNotes: report.editorialNotes,
      turnPrompts: report.turnPrompts,
      sourcesReviewed: fetched.length,
      sourcesWithContent: withContent.length,
      needsFollowUp: report.informationQuality !== 'rich',
      followUpReason: report.informationQuality === 'thin'
        ? 'Sources lacked detail — needs deeper investigation'
        : report.informationQuality === 'adequate'
          ? 'Story could benefit from additional sources or updates'
          : undefined,
      generatedAt: now,
    } : {
      broadcastSummary: researchedBrief.summary,
      keyFindings: [],
      analysisAngles: [],
      relatedTopics: [],
      editorialNotes: 'Report generation failed — using research data only.',
      turnPrompts: [],
      sourcesReviewed: fetched.length,
      sourcesWithContent: withContent.length,
      needsFollowUp: true,
      followUpReason: 'Report generation failed — retry recommended',
      generatedAt: now,
    }

    return {
      ...researchedBrief,
      report: enrichmentReport,
      sources: researchedBrief.sources,
      confidence: researchedBrief.confidence,
      imageUrl: researchedBrief.imageUrl,
      imageUrls: researchedBrief.imageUrls,
      lastUpdatedAt: now,
    }
  }

  private async fetchAllSources(urls: { url: string; label: string }[]): Promise<SourceFetchResult[]> {
    const results: SourceFetchResult[] = []

    for (let i = 0; i < urls.length; i += MAX_CONCURRENT_FETCHES) {
      const batch = urls.slice(i, i + MAX_CONCURRENT_FETCHES)
      const batchResults = await Promise.allSettled(
        batch.map(async ({ url, label }) => {
          const text = await this.fetchArticleText(url)
          return { url, label, text, charCount: text?.length ?? 0 }
        })
      )
      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value)
        else results.push({ url: '', label: '', text: null, charCount: 0 })
      }
    }

    return results
  }

  private async fetchArticleText(url: string): Promise<string | null> {
    if (this.firecrawl) {
      try {
        const result = await this.firecrawl.scrape(url, { formats: ['markdown'] })
        if (result.markdown) return result.markdown
      } catch {
        // Fall through to manual fetch
      }
    }
    return fetchArticleTextFallback(url)
  }
}

function collectUrls(brief: EditorialBrief, candidates: NewsCandidate[]): { url: string; label: string }[] {
  const seen = new Set<string>()
  const urls: { url: string; label: string }[] = []

  // Sources from the editor's brief
  for (const src of brief.sources) {
    if (src.url && src.url.startsWith('http') && !seen.has(src.url)) {
      seen.add(src.url)
      urls.push({ url: src.url, label: src.label })
    }
  }

  // Source URLs from related candidates
  const relatedIds = new Set(brief.relatedCandidateIds)
  for (const c of candidates) {
    if (relatedIds.has(c.id) && c.url && c.url.startsWith('http') && !seen.has(c.url)) {
      if (c.url.startsWith('https://www.reddit.com')) continue
      seen.add(c.url)
      urls.push({ url: c.url, label: c.sourceLabel })
    }
  }

  return urls
}

async function fetchArticleTextFallback(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PulseRadioBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    })
    clearTimeout(timeout)

    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null
    }

    const html = await res.text()
    return extractReadableText(html)
  } catch {
    return null
  }
}

function extractReadableText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')

  const articleMatch = text.match(/<article[\s\S]*?<\/article>/i)
    || text.match(/<main[\s\S]*?<\/main>/i)
    || text.match(/<div[^>]+class="[^"]*(?:article|post|entry|content|story)[^"]*"[\s\S]*?<\/div>/i)

  if (articleMatch) {
    text = articleMatch[0]
  }

  text = text.replace(/<[^>]+>/g, ' ')

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&\w+;/g, ' ')

  text = text.replace(/\s+/g, ' ').trim()

  return text
}

function parseReportResult(text: string): ReportResult | null {
  const clean = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const parsed = JSON.parse(clean)
    if (typeof parsed !== 'object' || parsed === null) return null
    const quality = parsed.informationQuality
    return {
      broadcastSummary: typeof parsed.broadcastSummary === 'string' ? parsed.broadcastSummary : '',
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.filter((p: unknown) => typeof p === 'string') : [],
      analysisAngles: Array.isArray(parsed.analysisAngles) ? parsed.analysisAngles.filter((p: unknown) => typeof p === 'string') : [],
      relatedTopics: Array.isArray(parsed.relatedTopics) ? parsed.relatedTopics.filter((p: unknown) => typeof p === 'string') : [],
      editorialNotes: typeof parsed.editorialNotes === 'string' ? parsed.editorialNotes : '',
      informationQuality: quality === 'rich' || quality === 'adequate' || quality === 'thin' ? quality : 'adequate',
      turnPrompts: Array.isArray(parsed.turnPrompts) ? parsed.turnPrompts.filter((p: unknown) => typeof p === 'string') : [],
    }
  } catch {
    return null
  }
}
