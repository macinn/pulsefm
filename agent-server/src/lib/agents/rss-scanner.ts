import type { NewsCandidate } from '../../types/news.js'
import type { RssSourceConfig } from '../../types/station.js'
import RssParser from 'rss-parser'

const parser = new RssParser({
  timeout: 10_000,
  headers: { 'User-Agent': 'PulseRadio/1.0 (news aggregator)' },
  customFields: {
    item: [['media:content', 'mediaContent', { keepArray: false }]],
  },
})

export class RssScanner {
  private seenUrls = new Set<string>()

  async scan(sources: RssSourceConfig[]): Promise<NewsCandidate[]> {
    const candidates: NewsCandidate[] = []

    const results = await Promise.allSettled(
      sources.map((src) => this.scanFeed(src))
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value)
      }
    }

    return candidates
  }

  private async scanFeed(source: RssSourceConfig): Promise<NewsCandidate[]> {
    const feed = await parser.parseURL(source.feedUrl)
    const candidates: NewsCandidate[] = []

    for (const item of feed.items) {
      const url = item.link ?? item.guid ?? ''
      if (!url || this.seenUrls.has(url)) continue

      this.seenUrls.add(url)

      const imageUrl = extractImageUrl(item as unknown as Record<string, unknown>)
      const imageUrls = extractAllImageUrls(item as unknown as Record<string, unknown>)

      const pubDate = item.isoDate ? new Date(item.isoDate).getTime() : undefined

      candidates.push({
        id: `rss-${hashCode(url)}`,
        headline: item.title?.trim() ?? 'Untitled',
        summary: stripHtml(item.contentSnippet ?? item.content ?? '').slice(0, 500),
        url,
        source: 'rss',
        sourceLabel: source.label || feed.title || source.feedUrl,
        detectedAt: pubDate ?? Date.now(),
        rawScore: 50,
        ...(imageUrl ? { imageUrl } : {}),
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
        publishedAt: pubDate,
      })
    }

    return candidates
  }

  resetSeen(): void {
    this.seenUrls.clear()
  }
}

function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

function extractImageUrl(item: Record<string, unknown>): string | undefined {
  // Try enclosure (standard RSS image)
  const enc = item.enclosure as Record<string, string> | undefined
  if (enc?.url && enc.type?.startsWith('image/')) return enc.url

  // Try media:content
  const media = item.mediaContent as Record<string, string> | undefined
  if (media?.url) return media.url
  const mediaAttrs = (media as Record<string, Record<string, string>> | undefined)?.$
  if (mediaAttrs?.url) return mediaAttrs.url

  // Try extracting first <img> from content
  const content = (item.content ?? item['content:encoded'] ?? '') as string
  const imgMatch = content.match(/<img[^>]+src="([^"]+)"/)
  if (imgMatch?.[1]) return imgMatch[1]

  return undefined
}

function extractAllImageUrls(item: Record<string, unknown>): string[] {
  const urls = new Set<string>()

  const enc = item.enclosure as Record<string, string> | undefined
  if (enc?.url && enc.type?.startsWith('image/')) urls.add(enc.url)

  const media = item.mediaContent as Record<string, string> | undefined
  if (media?.url) urls.add(media.url)
  const mediaAttrs = (media as Record<string, Record<string, string>> | undefined)?.$
  if (mediaAttrs?.url) urls.add(mediaAttrs.url)

  // Extract all <img> from content
  const content = (item.content ?? item['content:encoded'] ?? '') as string
  const imgRegex = /<img[^>]+src="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = imgRegex.exec(content)) !== null) {
    if (match[1]) urls.add(match[1])
  }

  return [...urls]
}
