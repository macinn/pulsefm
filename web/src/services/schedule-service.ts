import type { DaySchedule, ScheduleBlock, BlockConfig, BlockType } from '@/types/schedule'

import { getApiUrl } from '@/lib/config'

export async function fetchSchedule(date: string): Promise<DaySchedule> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}`)
  if (!res.ok) throw new Error(`Failed to fetch schedule: ${res.status}`)
  return res.json()
}

export async function saveSchedule(date: string, blocks: ScheduleBlock[]): Promise<void> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  })
  if (!res.ok) throw new Error(`Failed to save schedule: ${res.status}`)
}

export async function addBlock(
  date: string,
  block: { type: BlockType; title: string; startTime: string; durationMinutes: number; config: BlockConfig }
): Promise<ScheduleBlock> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(block),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Failed to add block: ${res.status}`)
  }
  return res.json()
}

export async function updateBlock(
  date: string,
  blockId: string,
  partial: Partial<ScheduleBlock>
): Promise<ScheduleBlock> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/blocks/${blockId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Failed to update block: ${res.status}`)
  }
  return res.json()
}

export async function deleteBlock(date: string, blockId: string): Promise<void> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/blocks/${blockId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`Failed to delete block: ${res.status}`)
}

export async function skipBlock(date: string, blockId: string): Promise<ScheduleBlock> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/blocks/${blockId}/skip`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to skip block: ${res.status}`)
  return res.json()
}

export async function executeBlock(date: string, blockId: string): Promise<void> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/blocks/${blockId}/execute`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Failed to execute block: ${res.status}`)
  }
}

export async function fetchTracks(): Promise<string[]> {
  const res = await fetch(`${getApiUrl()}/media/tracks`)
  if (!res.ok) return []
  const data = await res.json()
  return data.tracks ?? []
}

export async function autoGenerate(
  date: string,
  opts?: { windowHours?: number; scanFirst?: boolean }
): Promise<{ blocksCreated: number }> {
  const res = await fetch(`${getApiUrl()}/schedule/${date}/auto-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      windowHours: opts?.windowHours,
      scanFirst: opts?.scanFirst,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Auto-generation failed' }))
    throw new Error(err.error || 'Auto-generation failed')
  }
  return res.json()
}
