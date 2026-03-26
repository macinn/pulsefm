import { GoogleGenAI } from '@google/genai'
import type Database from 'better-sqlite3'
import type { NewsCandidate } from '../types/news.js'

const EMBEDDING_MODEL = 'text-embedding-004'
const DUPLICATE_THRESHOLD = 0.85
const RELATED_THRESHOLD = 0.70

interface StoredEmbedding {
  candidateId: string
  headline: string
  vector: number[]
  storedAt: number
}

export interface DedupResult {
  unique: NewsCandidate[]
  duplicates: { candidate: NewsCandidate; matchedId: string; similarity: number }[]
  related: { candidate: NewsCandidate; matchedId: string; similarity: number }[]
}

export class NewsDedup {
  private ai: GoogleGenAI
  private db: Database.Database

  constructor(apiKey: string, db: Database.Database) {
    this.ai = new GoogleGenAI({ apiKey })
    this.db = db
  }

  private loadEmbeddings(stationId: string): StoredEmbedding[] {
    const rows = this.db.prepare('SELECT candidate_id, headline, vector, stored_at FROM embeddings WHERE station_id = ? ORDER BY stored_at ASC')
      .all(stationId) as { candidate_id: string; headline: string; vector: string; stored_at: number }[]
    return rows.map((r) => ({
      candidateId: r.candidate_id,
      headline: r.headline,
      vector: JSON.parse(r.vector) as number[],
      storedAt: r.stored_at,
    }))
  }

  private saveEmbeddings(stationId: string, embeddings: StoredEmbedding[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO embeddings (candidate_id, station_id, headline, vector, stored_at) VALUES (?, ?, ?, ?, ?)')
    const txn = this.db.transaction(() => {
      for (const e of embeddings) {
        insert.run(e.candidateId, stationId, e.headline, JSON.stringify(e.vector), e.storedAt)
      }
      // Keep max 1000 per station
      const count = this.db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE station_id = ?').get(stationId) as { cnt: number }
      if (count.cnt > 1000) {
        this.db.prepare(`DELETE FROM embeddings WHERE station_id = ? AND candidate_id IN (
          SELECT candidate_id FROM embeddings WHERE station_id = ? ORDER BY stored_at ASC LIMIT ?
        )`).run(stationId, stationId, count.cnt - 1000)
      }
    })
    txn()
  }

  private async getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const result = await this.ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts.map((t) => ({ role: 'user', parts: [{ text: t }] })),
    })
    // The response contains embeddings array
    if (result.embeddings) {
      return result.embeddings.map((e) => e.values ?? [])
    }
    return []
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }

  private findBestMatch(vector: number[], existing: StoredEmbedding[]): { id: string; similarity: number } | null {
    let bestSim = 0
    let bestId = ''
    for (const entry of existing) {
      const sim = this.cosineSimilarity(vector, entry.vector)
      if (sim > bestSim) {
        bestSim = sim
        bestId = entry.candidateId
      }
    }
    return bestSim >= RELATED_THRESHOLD ? { id: bestId, similarity: bestSim } : null
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url)
      // Strip tracking params, fragments, trailing slashes
      u.hash = ''
      const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'fbclid', 'gclid']
      for (const p of stripParams) u.searchParams.delete(p)
      let path = u.pathname.replace(/\/+$/, '') || '/'
      const host = u.hostname.replace(/^www\./, '')
      return `${host}${path}${u.search}`
    } catch {
      return url
    }
  }

  async deduplicate(stationId: string, candidates: NewsCandidate[]): Promise<DedupResult> {
    if (candidates.length === 0) return { unique: [], duplicates: [], related: [] }

    // Phase 1: URL-based pre-dedup — same normalized URL = definite duplicate
    const seenUrls = new Map<string, number>()
    const urlDeduped: NewsCandidate[] = []
    const urlDuplicates: { candidate: NewsCandidate; matchedId: string; similarity: number }[] = []
    for (const c of candidates) {
      const normUrl = this.normalizeUrl(c.url)
      const existingIdx = seenUrls.get(normUrl)
      if (existingIdx !== undefined) {
        urlDuplicates.push({ candidate: c, matchedId: urlDeduped[existingIdx].id, similarity: 1.0 })
      } else {
        seenUrls.set(normUrl, urlDeduped.length)
        urlDeduped.push(c)
      }
    }

    if (urlDeduped.length === 0) return { unique: [], duplicates: urlDuplicates, related: [] }

    // Phase 2: Semantic embedding dedup
    const existing = this.loadEmbeddings(stationId)
    const texts = urlDeduped.map((c) => `${c.headline}. ${c.summary}`)

    let vectors: number[][]
    try {
      vectors = await this.getEmbeddings(texts)
    } catch (err) {
      console.warn('[news-dedup] embedding failed, passing all candidates through:', err)
      return { unique: urlDeduped, duplicates: urlDuplicates, related: [] }
    }

    if (vectors.length !== urlDeduped.length) {
      console.warn(`[news-dedup] vector count mismatch: ${vectors.length} vs ${urlDeduped.length}`)
      return { unique: urlDeduped, duplicates: urlDuplicates, related: [] }
    }

    const result: DedupResult = { unique: [], duplicates: [...urlDuplicates], related: [] }
    const newEmbeddings: StoredEmbedding[] = []

    for (let i = 0; i < urlDeduped.length; i++) {
      const candidate = urlDeduped[i]
      const vector = vectors[i]
      // Check against both existing embeddings and newly added ones in this batch
      const allEmbeddings = [...existing, ...newEmbeddings]
      const match = this.findBestMatch(vector, allEmbeddings)

      if (match && match.similarity >= DUPLICATE_THRESHOLD) {
        result.duplicates.push({ candidate, matchedId: match.id, similarity: match.similarity })
      } else if (match && match.similarity >= RELATED_THRESHOLD) {
        result.related.push({ candidate, matchedId: match.id, similarity: match.similarity })
        // Still add related items — they bring new info
        newEmbeddings.push({ candidateId: candidate.id, headline: candidate.headline, vector, storedAt: Date.now() })
        result.unique.push(candidate)
      } else {
        newEmbeddings.push({ candidateId: candidate.id, headline: candidate.headline, vector, storedAt: Date.now() })
        result.unique.push(candidate)
      }
    }

    if (newEmbeddings.length > 0) {
      this.saveEmbeddings(stationId, [...existing, ...newEmbeddings])
    }

    console.log(`[news-dedup] ${candidates.length} candidates: ${result.unique.length} unique, ${result.duplicates.length} duplicates, ${result.related.length} related`)
    return result
  }
}
