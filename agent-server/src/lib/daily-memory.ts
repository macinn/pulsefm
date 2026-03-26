import type Database from 'better-sqlite3'
import type { ScheduleStore } from './schedule-store.js'

export class DailyMemory {
  private db: Database.Database
  private scheduleStore: ScheduleStore

  constructor(db: Database.Database, scheduleStore: ScheduleStore) {
    this.db = db
    this.scheduleStore = scheduleStore
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private timestamp(): string {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  async addEntry(text: string, date?: string): Promise<void> {
    const d = date ?? this.today()
    const line = `- [${this.timestamp()}] ${text}\n`
    const row = this.db.prepare('SELECT content FROM daily_memory WHERE date = ?').get(d) as { content: string } | undefined
    if (row) {
      this.db.prepare('UPDATE daily_memory SET content = ? WHERE date = ?').run(row.content + line, d)
    } else {
      const header = `# Pulse Daily Memory — ${d}\n\n`
      this.db.prepare('INSERT INTO daily_memory (date, content) VALUES (?, ?)').run(d, header + line)
    }
  }

  async getMemory(date?: string): Promise<string> {
    const d = date ?? this.today()
    const row = this.db.prepare('SELECT content FROM daily_memory WHERE date = ?').get(d) as { content: string } | undefined
    return row?.content ?? ''
  }

  async buildContext(): Promise<string> {
    const date = this.today()
    const parts: string[] = []

    const memory = await this.getMemory(date)
    if (memory) {
      parts.push('=== SHOW MEMORY (what happened today) ===')
      parts.push(memory.replace(/^# .+\n\n/, ''))
    }

    const schedule = await this.scheduleStore.getSchedule(date)
    const upcoming = schedule.blocks
      .filter((b) => b.status === 'pending')
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 5)

    if (upcoming.length > 0) {
      parts.push('=== COMING UP NEXT ===')
      for (const b of upcoming) {
        parts.push(`- [${b.startTime}] ${b.type}: ${b.title}`)
      }
    }

    return parts.join('\n')
  }
}
