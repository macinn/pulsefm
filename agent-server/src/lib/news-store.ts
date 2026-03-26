import type Database from 'better-sqlite3'
import type { NewsCandidate, EditorialBrief, ActivityLogEntry } from '../types/news.js'

function normalizeHeadline(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function headlineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const wordsA = new Set(a.split(' ').filter((w) => w.length > 2))
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 2))
  if (wordsA.size === 0 && wordsB.size === 0) return 1
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  const union = new Set([...wordsA, ...wordsB]).size
  return union === 0 ? 0 : intersection / union
}

export interface NewsStore {
  addCandidates(stationId: string, candidates: NewsCandidate[]): Promise<void>
  getCandidates(stationId: string, opts?: { since?: number; limit?: number }): Promise<NewsCandidate[]>
  addBriefs(stationId: string, briefs: EditorialBrief[]): Promise<void>
  getBriefs(stationId: string, opts?: { since?: number; limit?: number; pendingOnly?: boolean }): Promise<EditorialBrief[]>
  markBriefUsed(stationId: string, briefId: string): Promise<void>
  sendBrief(stationId: string, briefId: string, method: string): Promise<EditorialBrief | null>
  addBriefLogEntry(stationId: string, briefId: string, entry: ActivityLogEntry): Promise<EditorialBrief | null>
  updateBrief(stationId: string, brief: EditorialBrief): Promise<void>
}

export class SqliteNewsStore implements NewsStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  async addCandidates(stationId: string, candidates: NewsCandidate[]): Promise<void> {
    const maxAge = Date.now() - 3 * 24 * 60 * 60 * 1000
    const insert = this.db.prepare('INSERT OR IGNORE INTO candidates (id, station_id, data, detected_at) VALUES (?, ?, ?, ?)')
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM candidates WHERE station_id = ?')

    const txn = this.db.transaction(() => {
      for (const c of candidates) {
        const articleDate = c.publishedAt ?? c.detectedAt
        if (articleDate < maxAge) continue
        insert.run(c.id, stationId, JSON.stringify(c), c.detectedAt)
      }
      // Trim to 500 per station
      const { cnt } = count.get(stationId) as { cnt: number }
      if (cnt > 500) {
        this.db.prepare(`DELETE FROM candidates WHERE station_id = ? AND id IN (
          SELECT id FROM candidates WHERE station_id = ? ORDER BY detected_at ASC LIMIT ?
        )`).run(stationId, stationId, cnt - 500)
      }
    })
    txn()
  }

  async getCandidates(stationId: string, opts?: { since?: number; limit?: number }): Promise<NewsCandidate[]> {
    let sql = 'SELECT data FROM candidates WHERE station_id = ?'
    const params: (string | number)[] = [stationId]
    if (opts?.since) {
      sql += ' AND detected_at >= ?'
      params.push(opts.since)
    }
    sql += ' ORDER BY detected_at ASC'
    if (opts?.limit) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }
    const rows = this.db.prepare(sql).all(...params) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as NewsCandidate)
  }

  async addBriefs(stationId: string, briefs: EditorialBrief[]): Promise<void> {
    const existingRows = this.db.prepare('SELECT data FROM briefs WHERE station_id = ?').all(stationId) as { data: string }[]
    const existing = existingRows.map((r) => JSON.parse(r.data) as EditorialBrief)

    const existingIds = new Set(existing.map((b) => b.id))
    const existingHeadlines = existing.map((b) => normalizeHeadline(b.headline))
    const existingCandidateIds = new Set(existing.flatMap((b) => b.relatedCandidateIds))

    const insert = this.db.prepare('INSERT OR IGNORE INTO briefs (id, station_id, data, generated_at, used) VALUES (?, ?, ?, ?, ?)')
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM briefs WHERE station_id = ?')

    const txn = this.db.transaction(() => {
      for (const b of briefs) {
        if (existingIds.has(b.id)) continue
        const norm = normalizeHeadline(b.headline)
        if (existingHeadlines.some((h) => headlineSimilarity(h, norm) >= 0.75)) continue
        if (b.relatedCandidateIds.length > 0 && b.relatedCandidateIds.every((id) => existingCandidateIds.has(id))) continue
        insert.run(b.id, stationId, JSON.stringify(b), b.generatedAt, b.used ? 1 : 0)
      }
      // Trim to 200 per station
      const { cnt } = count.get(stationId) as { cnt: number }
      if (cnt > 200) {
        this.db.prepare(`DELETE FROM briefs WHERE station_id = ? AND id IN (
          SELECT id FROM briefs WHERE station_id = ? ORDER BY generated_at ASC LIMIT ?
        )`).run(stationId, stationId, cnt - 200)
      }
    })
    txn()
  }

  async getBriefs(stationId: string, opts?: { since?: number; limit?: number; pendingOnly?: boolean }): Promise<EditorialBrief[]> {
    let sql = 'SELECT data FROM briefs WHERE station_id = ?'
    const params: (string | number)[] = [stationId]
    if (opts?.pendingOnly) {
      sql += ' AND used = 0'
    }
    if (opts?.since) {
      sql += ' AND generated_at >= ?'
      params.push(opts.since)
    }
    sql += ' ORDER BY generated_at ASC'
    if (opts?.limit) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }
    const rows = this.db.prepare(sql).all(...params) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as EditorialBrief)
  }

  private getBrief(stationId: string, briefId: string): EditorialBrief | null {
    const row = this.db.prepare('SELECT data FROM briefs WHERE station_id = ? AND id = ?').get(stationId, briefId) as { data: string } | undefined
    return row ? JSON.parse(row.data) as EditorialBrief : null
  }

  private saveBrief(stationId: string, brief: EditorialBrief): void {
    this.db.prepare('UPDATE briefs SET data = ?, used = ? WHERE station_id = ? AND id = ?')
      .run(JSON.stringify(brief), brief.used ? 1 : 0, stationId, brief.id)
  }

  async markBriefUsed(stationId: string, briefId: string): Promise<void> {
    const brief = this.getBrief(stationId, briefId)
    if (!brief) return
    brief.used = true
    const log = brief.activityLog ?? []
    log.push({ timestamp: Date.now(), action: 'sent', detail: 'Marked as used' })
    brief.activityLog = log
    this.saveBrief(stationId, brief)
  }

  async sendBrief(stationId: string, briefId: string, method: string): Promise<EditorialBrief | null> {
    const brief = this.getBrief(stationId, briefId)
    if (!brief) return null
    const now = Date.now()
    brief.used = true
    brief.sentAt = brief.sentAt ?? now
    brief.sentCount = (brief.sentCount ?? 0) + 1
    const log = brief.activityLog ?? []
    log.push({ timestamp: now, action: 'sent', detail: `Sent as ${method}` })
    brief.activityLog = log
    this.saveBrief(stationId, brief)
    return brief
  }

  async addBriefLogEntry(stationId: string, briefId: string, entry: ActivityLogEntry): Promise<EditorialBrief | null> {
    const brief = this.getBrief(stationId, briefId)
    if (!brief) return null
    const log = brief.activityLog ?? []
    log.push(entry)
    brief.activityLog = log
    brief.lastUpdatedAt = entry.timestamp
    this.saveBrief(stationId, brief)
    return brief
  }

  async updateBrief(stationId: string, brief: EditorialBrief): Promise<void> {
    this.saveBrief(stationId, brief)
  }
}
