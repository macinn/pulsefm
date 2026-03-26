import type { NewsCandidate } from '../../types/news.js'
import type { RedditSourceConfig } from '../../types/station.js'

const REDDIT_BASE = 'https://www.reddit.com'
const USER_AGENT = 'PulseRadio/1.0 (news aggregator bot)'

interface RedditPost {
  data: {
    id: string
    title: string
    selftext: string
    url: string
    permalink: string
    score: number
    created_utc: number
    subreddit: string
    is_self: boolean
    link_flair_text?: string
    thumbnail?: string
    preview?: { images?: Array<{ source?: { url?: string } }> }
  }
}

interface RedditListing {
  data: {
    children: RedditPost[]
  }
}

export class RedditScout {
  private seenIds = new Set<string>()

  async scan(sources: RedditSourceConfig[]): Promise<NewsCandidate[]> {
    const candidates: NewsCandidate[] = []

    const results = await Promise.allSettled(
      sources.map((src) => this.scanSubreddit(src))
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value)
      }
    }

    return candidates
  }

  private async scanSubreddit(source: RedditSourceConfig): Promise<NewsCandidate[]> {
    const url = `${REDDIT_BASE}/r/${encodeURIComponent(source.subreddit)}/${source.sortBy}.json?limit=25`
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`Reddit r/${source.subreddit}: ${res.status}`)
    }

    const listing = (await res.json()) as RedditListing
    const candidates: NewsCandidate[] = []

    for (const post of listing.data.children) {
      const d = post.data
      if (this.seenIds.has(d.id)) continue
      if (source.minUpvotes && d.score < source.minUpvotes) continue

      this.seenIds.add(d.id)

      const imageUrl = d.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, '&')
        || (d.thumbnail && d.thumbnail.startsWith('http') ? d.thumbnail : undefined)

      const imageUrls: string[] = []
      if (d.preview?.images) {
        for (const img of d.preview.images) {
          const src = img?.source?.url?.replace(/&amp;/g, '&')
          if (src) imageUrls.push(src)
        }
      }
      if (imageUrls.length === 0 && d.thumbnail && d.thumbnail.startsWith('http')) {
        imageUrls.push(d.thumbnail)
      }

      const publishedAt = d.created_utc * 1000

      candidates.push({
        id: `reddit-${d.id}`,
        headline: d.title.trim(),
        summary: d.selftext.slice(0, 500) || d.title,
        url: d.is_self
          ? `${REDDIT_BASE}${d.permalink}`
          : d.url,
        source: 'reddit',
        sourceLabel: `r/${d.subreddit}`,
        detectedAt: publishedAt,
        rawScore: scoreFromUpvotes(d.score),
        ...(imageUrl ? { imageUrl } : {}),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        publishedAt,
      })
    }

    return candidates
  }

  resetSeen(): void {
    this.seenIds.clear()
  }
}

function scoreFromUpvotes(score: number): number {
  if (score >= 1000) return 90
  if (score >= 500) return 75
  if (score >= 100) return 60
  if (score >= 50) return 45
  return 30
}
