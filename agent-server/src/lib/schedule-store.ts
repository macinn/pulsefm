import type Database from 'better-sqlite3'
import type { DaySchedule, ScheduleBlock } from '../types/schedule.js'

export interface ScheduleStore {
  getSchedule(date: string): Promise<DaySchedule>
  saveSchedule(schedule: DaySchedule): Promise<void>
  updateBlock(date: string, blockId: string, partial: Partial<ScheduleBlock>): Promise<ScheduleBlock | null>
  deleteBlock(date: string, blockId: string): Promise<boolean>
}

export class SqliteScheduleStore implements ScheduleStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  async getSchedule(date: string): Promise<DaySchedule> {
    const row = this.db.prepare('SELECT data FROM schedules WHERE date = ?').get(date) as { data: string } | undefined
    if (!row) return { date, blocks: [] }
    return JSON.parse(row.data) as DaySchedule
  }

  async saveSchedule(schedule: DaySchedule): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO schedules (date, data) VALUES (?, ?)').run(schedule.date, JSON.stringify(schedule))
  }

  async updateBlock(date: string, blockId: string, partial: Partial<ScheduleBlock>): Promise<ScheduleBlock | null> {
    const schedule = await this.getSchedule(date)
    const idx = schedule.blocks.findIndex((b) => b.id === blockId)
    if (idx === -1) return null
    schedule.blocks[idx] = { ...schedule.blocks[idx], ...partial, id: blockId }
    await this.saveSchedule(schedule)
    return schedule.blocks[idx]
  }

  async deleteBlock(date: string, blockId: string): Promise<boolean> {
    const schedule = await this.getSchedule(date)
    const before = schedule.blocks.length
    schedule.blocks = schedule.blocks.filter((b) => b.id !== blockId)
    if (schedule.blocks.length === before) return false
    await this.saveSchedule(schedule)
    return true
  }
}
