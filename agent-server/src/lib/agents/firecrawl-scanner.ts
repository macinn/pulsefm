import Firecrawl from '@mendable/firecrawl-js'
import type { NewsCandidate } from '../../types/news.js'
import type { FirecrawlConfig } from '../../types/station.js'

const DEFAULT_LIMIT = 10

export class FirecrawlScanner {
  private client: Firecrawl
  private seenUrls = new Set<string>()

  constructor(apiKey: string) {
    this.client = new Firecrawl({ apiKey })
  }

  async scan(configs: FirecrawlConfig[]): Promise<NewsCandidate[]> {
    const candidates: NewsCandidate[] = []

    const results = await Promise.allSettled(
      configs.map((cfg) => this.searchNews(cfg))
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value)
      }
    }

    return candidates
  }

  private async searchNews(config: FirecrawlConfig): Promise<NewsCandidate[]> {
    const limit = config.limit ?? DEFAULT_LIMIT
    const candidates: NewsCandidate[] = []

    // Search each keyword independently for better coverage
    const results = await Promise.allSettled(
      config.keywords.map((keyword) =>
        this.client.search(keyword, { limit, sources: ['news'] })
      )
    )

    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const newsResults = result.value.news ?? []

      for (const item of newsResults) {
        const url = 'url' in item ? item.url : undefined
        if (!url || this.seenUrls.has(url)) continue

        const title = 'title' in item ? (item.title ?? '') : ''
        if (!title) continue

        this.seenUrls.add(url)

        const snippet = 'snippet' in item ? (item.snippet ?? '') : ''
        const dateStr = 'date' in item ? (item.date as string | undefined) : undefined
        const imageUrl = 'imageUrl' in item ? (item.imageUrl as string | undefined) : undefined
        const publishedAt = dateStr ? parseRelativeDate(dateStr) : undefined

        candidates.push({
          id: `firecrawl-${hashUrl(url)}`,
          headline: title.trim(),
          summary: snippet.slice(0, 500),
          url,
          source: 'firecrawl',
          sourceLabel: extractDomain(url),
          detectedAt: Date.now(),
          rawScore: 65,
          imageUrl: imageUrl ?? undefined,
          imageUrls: imageUrl ? [imageUrl] : [],
          publishedAt,
        })
      }
    }

    return candidates
  }

  resetSeen(): void {
    this.seenUrls.clear()
  }
}

function hashUrl(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^www\./, '')
  } catch {
    return 'web'
  }
}

/** Parse Firecrawl relative dates like "14 minutes ago", "1 day ago", "2 days ago" */
function parseRelativeDate(dateStr: string): number | undefined {
  const now = Date.now()
  const match = dateStr.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i)
  if (!match) {
    // Try parsing as absolute date
    const ts = Date.parse(dateStr)
    return isNaN(ts) ? undefined : ts
  }
  const amount = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const msMap: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
  }
  return now - amount * (msMap[unit] ?? 0)
}
