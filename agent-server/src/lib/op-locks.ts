import type Database from 'better-sqlite3'

export type OpName = 'scan' | 'process' | 'auto-generate' | 'music-batch'

export class OpLocks {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    // Clean stale locks older than 10 minutes on startup
    this.db.prepare('DELETE FROM op_locks WHERE started_at < ?').run(Date.now() - 10 * 60_000)
  }

  acquire(op: OpName): boolean {
    try {
      this.db.prepare('INSERT INTO op_locks (op, started_at) VALUES (?, ?)').run(op, Date.now())
      return true
    } catch {
      return false // UNIQUE constraint violation = already locked
    }
  }

  release(op: OpName): void {
    this.db.prepare('DELETE FROM op_locks WHERE op = ?').run(op)
  }

  isLocked(op: OpName): boolean {
    const row = this.db.prepare('SELECT 1 FROM op_locks WHERE op = ?').get(op)
    return !!row
  }

  getAll(): Record<OpName, boolean> {
    const ops: OpName[] = ['scan', 'process', 'auto-generate', 'music-batch']
    const locked = new Set(
      (this.db.prepare('SELECT op FROM op_locks').all() as { op: string }[]).map((r) => r.op),
    )
    return Object.fromEntries(ops.map((op) => [op, locked.has(op)])) as Record<OpName, boolean>
  }
}
