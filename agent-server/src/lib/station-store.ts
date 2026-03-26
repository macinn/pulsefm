import type Database from 'better-sqlite3'
import type { StationConfig } from '../types/station.js'

export interface StationStore {
  listStations(): Promise<StationConfig[]>
  getStation(id: string): Promise<StationConfig | null>
  createStation(config: StationConfig): Promise<StationConfig>
  updateStation(id: string, partial: Partial<StationConfig>): Promise<StationConfig | null>
  deleteStation(id: string): Promise<boolean>
}

export class SqliteStationStore implements StationStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  async listStations(): Promise<StationConfig[]> {
    const rows = this.db.prepare('SELECT data FROM stations').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as StationConfig)
  }

  async getStation(id: string): Promise<StationConfig | null> {
    const row = this.db.prepare('SELECT data FROM stations WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as StationConfig : null
  }

  async createStation(config: StationConfig): Promise<StationConfig> {
    this.db.prepare('INSERT OR REPLACE INTO stations (id, data) VALUES (?, ?)').run(config.id, JSON.stringify(config))
    return config
  }

  async updateStation(id: string, partial: Partial<StationConfig>): Promise<StationConfig | null> {
    const existing = await this.getStation(id)
    if (!existing) return null
    const updated = { ...existing, ...partial, id }
    this.db.prepare('UPDATE stations SET data = ? WHERE id = ?').run(JSON.stringify(updated), id)
    return updated
  }

  async deleteStation(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM stations WHERE id = ?').run(id)
    return result.changes > 0
  }
}
