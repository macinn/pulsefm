import { GoogleGenAI } from '@google/genai'
import type { GroundingChunk } from '@google/genai'
import Firecrawl from '@mendable/firecrawl-js'
import type { EditorialBrief, SourceType } from '../../types/news.js'

const SYSTEM_PROMPT = `You are a research agent for "Pulse", a live AI radio station focused on AI, startups, and technology. You receive a news brief that needs deeper investigation. Use Google Search to find the latest, most detailed information about this topic.

CRITICAL DATE RULE: Only include information and sources published within the last 3 days. Ignore outdated articles, old product launches, or stale announcements — even if they appear in search results. If the story turns out to be old news (not from the last 3 days), say so clearly.

Research the story and write:
1. A comprehensive 4-6 sentence summary with the latest details, context, and implications. Conversational and radio-ready.
2. 2-5 key facts as bullet points.
3. On the very last line, write exactly one of: CONFIDENCE: confirmed | CONFIDENCE: developing | CONFIDENCE: rumor

Do NOT include source URLs — they are extracted automatically from grounding metadata.`

const SYNTHESIS_PROMPT = `You are a senior research analyst for "Pulse", a live AI radio station. You have collected raw material from multiple web sources about a news story. Your job is to synthesize this into a definitive, radio-ready research brief.

CRITICAL DATE RULE: Only include information published within the last 3 days. Discard anything older.

You will receive:
- The original brief (headline + summary)
- Grounded search results (from Google Search)
- Deep-scraped article content (from Firecrawl web search + scrape)

Synthesize ALL material into:
1. A comprehensive 6-10 sentence summary incorporating the best facts from ALL sources. Conversational, radio-ready, rich in detail. Cross-reference between sources for accuracy.
2. 4-8 key facts as bullet points — specific numbers, names, dates, quotes.
3. On the very last line, write exactly one of: CONFIDENCE: confirmed | CONFIDENCE: developing | CONFIDENCE: rumor

Prefer concrete data over vague claims. If sources contradict, note the discrepancy. Do NOT include source URLs.`

const MAX_SCRAPE_LENGTH = 6_000
const MAX_FIRECRAWL_RESULTS = 5
const MAX_DEEP_SCRAPE = 3

interface ResolvedChunk {
  uri: string
  title: string
}

export class ResearchAgent {
  private ai: GoogleGenAI
  private firecrawl: Firecrawl | null = null

  constructor(apiKey: string, firecrawlApiKey?: string) {
    const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
    process.env.GOOGLE_CLOUD_LOCATION = 'global'
    this.ai = new GoogleGenAI({ apiKey })
    if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
    else delete process.env.GOOGLE_CLOUD_LOCATION
    if (firecrawlApiKey) this.firecrawl = new Firecrawl({ apiKey: firecrawlApiKey })
  }

  async research(brief: EditorialBrief): Promise<EditorialBrief> {
    const cutoffDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const prompt = [
      `Today is ${today}. Research this news story in depth.`,
      `IMPORTANT: Only look for information published between ${cutoffDate} and ${today}. Discard anything older.`,
      `Headline: ${brief.headline}`,
      `Current summary: ${brief.summary}`,
      `Current confidence: ${brief.confidence}`,
      `Sources so far: ${brief.sources.map((s) => s.label).join(', ') || 'none'}`,
    ].join('\n')

    // Phase 1: Google Search grounding
    const response = await this.ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
        temperature: 0.3,
      },
    })

    const metadata = response.candidates?.[0]?.groundingMetadata
    const chunks = metadata?.groundingChunks ?? []
    const supports = metadata?.groundingSupports ?? []

    const groundedText = supports.map((s) => s.segment?.text ?? '').join(' ').trim()

    // Resolve Google redirect URLs to real source URLs
    const resolvedChunks = await resolveAllChunks(chunks)

    // Phase 2: Firecrawl independent search + scrape
    const firecrawlSources: { url: string; label: string; content: string }[] = []
    if (this.firecrawl) {
      try {
        const searchResults = await this.firecrawlSearch(brief.headline)
        // Exclude URLs already found via grounding
        const groundingUrls = new Set(resolvedChunks.map((c) => c.uri))
        const existingUrls = new Set(brief.sources.map((s) => s.url))
        const newResults = searchResults.filter(
          (r) => !groundingUrls.has(r.url) && !existingUrls.has(r.url)
        )

        // Scrape top results for full content
        const toScrape = newResults.slice(0, MAX_DEEP_SCRAPE)
        const scrapeResults = await Promise.allSettled(
          toScrape.map(async (r) => {
            const result = await this.firecrawl!.scrape(r.url, { formats: ['markdown'] })
            return { ...r, content: (result.markdown ?? '').slice(0, MAX_SCRAPE_LENGTH) }
          })
        )
        for (const r of scrapeResults) {
          if (r.status === 'fulfilled' && r.value.content.length > 200) {
            firecrawlSources.push(r.value)
          }
        }
        // Also keep results we didn't scrape (they may have snippets)
        for (const r of newResults.slice(MAX_DEEP_SCRAPE)) {
          if (r.content.length > 100) firecrawlSources.push(r)
        }
      } catch (err) {
        console.warn(`[research] Firecrawl search failed: ${(err as Error).message}`)
      }
    }

    // Deep-scrape top grounding URLs via Firecrawl
    let groundingDeepContent = ''
    if (this.firecrawl) {
      const topUrls = resolvedChunks.filter((c) => c.uri).slice(0, MAX_DEEP_SCRAPE)
      const scrapeResults = await Promise.allSettled(
        topUrls.map(async (c) => {
          const result = await this.firecrawl!.scrape(c.uri, { formats: ['markdown'] })
          return result.markdown ?? ''
        })
      )
      const scraped = scrapeResults
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => (r as PromiseFulfilledResult<string>).value.slice(0, MAX_SCRAPE_LENGTH))
      if (scraped.length > 0) groundingDeepContent = scraped.join('\n---\n')
    }

    // Build updated sources from all channels
    const updatedSources = [...brief.sources]
    for (const chunk of resolvedChunks) {
      if (!chunk.uri) continue
      if (!updatedSources.some((s) => s.url === chunk.uri)) {
        updatedSources.push({ label: chunk.title, url: chunk.uri, type: 'gemini-search' as SourceType })
      }
    }
    for (const fc of firecrawlSources) {
      if (!updatedSources.some((s) => s.url === fc.url)) {
        updatedSources.push({ label: fc.label, url: fc.url, type: 'firecrawl' as SourceType })
      }
    }

    // Phase 3: Synthesis — if we have Firecrawl content, do a second LLM pass
    let summary: string
    let confidence: 'confirmed' | 'developing' | 'rumor' | null = null

    const hasFirecrawlContent = firecrawlSources.some((s) => s.content.length > 200)
    const hasGroundingContent = groundedText.length > 100 || groundingDeepContent.length > 200

    if (hasFirecrawlContent && hasGroundingContent) {
      // Rich data from both channels — synthesize
      const firecrawlBlock = firecrawlSources
        .map((s, i) => `--- FIRECRAWL SOURCE ${i + 1}: ${s.label} (${s.url}) ---\n${s.content.slice(0, MAX_SCRAPE_LENGTH)}`)
        .join('\n\n')

      const synthesisPrompt = [
        `Today is ${today}. Only include info from ${cutoffDate} to ${today}.`,
        `\nORIGINAL BRIEF:`,
        `Headline: ${brief.headline}`,
        `Summary: ${brief.summary}`,
        `\nGOOGLE SEARCH GROUNDING RESULTS:`,
        groundedText,
        groundingDeepContent ? `\nDEEP-SCRAPED GROUNDING CONTENT:\n${groundingDeepContent}` : '',
        `\nFIRECRAWL WEB SEARCH RESULTS:`,
        firecrawlBlock,
      ].filter(Boolean).join('\n')

      try {
        const synthResponse = await this.ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: synthesisPrompt,
          config: { systemInstruction: SYNTHESIS_PROMPT, temperature: 0.3 },
        })
        const synthText = synthResponse.text?.trim() ?? ''
        const confMatch = synthText.match(/CONFIDENCE:\s*(confirmed|developing|rumor)/i)
        confidence = confMatch ? validateConfidence(confMatch[1].toLowerCase()) : null
        summary = synthText.replace(/\s*CONFIDENCE:\s*(confirmed|developing|rumor)\s*/gi, '').trim()
        console.log(`[research] synthesis pass — combined grounding + ${firecrawlSources.length} Firecrawl sources`)
      } catch (err) {
        console.warn(`[research] synthesis LLM failed, using grounding only: ${(err as Error).message}`)
        summary = groundedText.replace(/\s*CONFIDENCE:\s*(confirmed|developing|rumor)\s*/gi, '').trim()
        const confMatch = groundedText.match(/CONFIDENCE:\s*(confirmed|developing|rumor)/i)
        confidence = confMatch ? validateConfidence(confMatch[1].toLowerCase()) : null
      }
    } else {
      // Single-channel: use grounded text directly (original behavior)
      if (!groundedText) return brief
      const confMatch = groundedText.match(/CONFIDENCE:\s*(confirmed|developing|rumor)/i)
      confidence = confMatch ? validateConfidence(confMatch[1].toLowerCase()) : null
      summary = groundedText.replace(/\s*CONFIDENCE:\s*(confirmed|developing|rumor)\s*/gi, '').trim()
      if (groundingDeepContent) {
        summary += '\n\n[Deep source content]:\n' + groundingDeepContent.slice(0, MAX_SCRAPE_LENGTH)
      }
    }

    // Check for image URLs in grounding chunks
    const imageChunks = chunks
      .filter((c) => c.image?.imageUri)
      .map((c) => c.image!.imageUri!)

    return {
      ...brief,
      summary,
      sources: updatedSources,
      confidence: confidence ?? brief.confidence,
      imageUrl: imageChunks[0] || brief.imageUrl,
      imageUrls: mergeImageUrls(brief.imageUrls, imageChunks[0] || null),
      lastResearchedAt: Date.now(),
    }
  }

  /** Search Firecrawl for a topic and return results with snippets */
  private async firecrawlSearch(headline: string): Promise<{ url: string; label: string; content: string }[]> {
    if (!this.firecrawl) return []
    const response = await this.firecrawl.search(headline, { limit: MAX_FIRECRAWL_RESULTS })

    const results: { url: string; label: string; content: string }[] = []

    for (const item of response.web ?? []) {
      const url = 'url' in item ? item.url : undefined
      const title = 'title' in item ? (item.title ?? '') : ''
      if (!url) continue
      const markdown = 'markdown' in item ? (item.markdown ?? '') : ''
      const description = 'description' in item ? (item.description ?? '') : ''
      results.push({ url, label: title || extractDomain(url), content: markdown || description })
    }

    for (const item of response.news ?? []) {
      const url = 'url' in item ? item.url : undefined
      const title = 'title' in item ? (item.title ?? '') : ''
      if (!url) continue
      const snippet = 'snippet' in item ? (item.snippet ?? '') : ''
      results.push({ url, label: title || extractDomain(url), content: snippet })
    }

    console.log(`[research] Firecrawl search returned ${results.length} results for "${headline.slice(0, 50)}"`)
    return results
  }
}

function validateConfidence(val: string): 'confirmed' | 'developing' | 'rumor' | null {
  if (val === 'confirmed' || val === 'developing' || val === 'rumor') return val
  return null
}

function mergeImageUrls(existing?: string[], newUrl?: string | null): string[] {
  const set = new Set(existing ?? [])
  if (newUrl) set.add(newUrl)
  return [...set]
}

async function resolveAllChunks(chunks: GroundingChunk[]): Promise<ResolvedChunk[]> {
  return Promise.all(
    chunks.map(async (chunk) => {
      const rawUri = chunk.web?.uri ?? ''
      const title = chunk.web?.title ?? ''
      const uri = await resolveRedirectUrl(rawUri)
      return { uri, title }
    })
  )
}

async function resolveRedirectUrl(url: string): Promise<string> {
  if (!url || !url.includes('vertexaisearch.cloud.google.com')) return url
  try {
    const res = await fetch(url, { redirect: 'manual' })
    return res.headers.get('location') ?? url
  } catch {
    return url
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'web'
  }
}
