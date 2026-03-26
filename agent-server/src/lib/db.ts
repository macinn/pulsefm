import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

let _db: Database.Database | null = null

export function getDb(dataDir: string): Database.Database {
  if (_db) return _db

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  const dbPath = path.join(dataDir, 'pulse.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      date TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      data TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      PRIMARY KEY (station_id, id)
    );

    CREATE TABLE IF NOT EXISTS briefs (
      id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      data TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (station_id, id)
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      candidate_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      headline TEXT NOT NULL,
      vector TEXT NOT NULL,
      stored_at INTEGER NOT NULL,
      PRIMARY KEY (station_id, candidate_id)
    );

    CREATE TABLE IF NOT EXISTS daily_memory (
      date TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_library (
      filename TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      enhanced_prompt TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS op_locks (
      op TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL
    );
  `)

  return _db
}
