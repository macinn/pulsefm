import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import type { ScheduleStore } from '../lib/schedule-store.js'
import type { SchedulePlanner } from '../lib/agents/schedule-planner.js'
import type { AutoPilot } from '../lib/auto-pilot.js'
import type { ScheduleBlock, BlockConfig } from '../types/schedule.js'

function genId(): string {
  return randomBytes(8).toString('hex')
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function hasOverlap(blocks: ScheduleBlock[], newBlock: { startTime: string; durationMinutes: number; id?: string }): ScheduleBlock | null {
  const newStart = toMinutes(newBlock.startTime)
  const newEnd = newStart + newBlock.durationMinutes
  for (const b of blocks) {
    if (b.id === newBlock.id) continue
    const bStart = toMinutes(b.startTime)
    const bEnd = bStart + b.durationMinutes
    if (newStart < bEnd && newEnd > bStart) return b
  }
  return null
}

export function createScheduleRoutes(
  store: ScheduleStore,
  onBlockChanged?: (date: string, block: ScheduleBlock) => void,
  onExecuteBlock?: (date: string, blockId: string) => Promise<void>,
  schedulePlanner?: SchedulePlanner,
  getAvailableTracks?: () => string[],
  autoPilot?: AutoPilot,
) {
  const api = new Hono()

  // Get day schedule
  api.get('/:date', async (c) => {
    const date = c.req.param('date')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format, use YYYY-MM-DD' }, 400)
    const schedule = await store.getSchedule(date)
    return c.json(schedule)
  })

  // Save full schedule
  api.put('/:date', async (c) => {
    const date = c.req.param('date')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const body = await c.req.json<{ blocks: ScheduleBlock[] }>()
    if (!Array.isArray(body?.blocks)) return c.json({ error: 'blocks array is required' }, 400)
    await store.saveSchedule({ date, blocks: body.blocks })
    return c.json({ status: 'saved' })
  })

  // Add a block
  api.post('/:date/blocks', async (c) => {
    const date = c.req.param('date')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const body = await c.req.json<{
      type: ScheduleBlock['type']
      title: string
      startTime: string
      durationMinutes: number
      config: BlockConfig
    }>()

    if (!body?.type || !body?.title || !body?.startTime || !body?.durationMinutes || !body?.config) {
      return c.json({ error: 'type, title, startTime, durationMinutes, and config are required' }, 400)
    }

    const block: ScheduleBlock = {
      id: genId(),
      type: body.type,
      title: body.title,
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      status: 'pending',
      config: body.config,
    }

    const schedule = await store.getSchedule(date)

    const conflict = hasOverlap(schedule.blocks, block)
    if (conflict) {
      return c.json({ error: `Overlaps with "${conflict.title}" (${conflict.startTime}, ${conflict.durationMinutes}min)` }, 409)
    }

    schedule.blocks.push(block)
    schedule.blocks.sort((a, b) => a.startTime.localeCompare(b.startTime))
    await store.saveSchedule(schedule)
    onBlockChanged?.(date, block)
    return c.json(block, 201)
  })

  // Update a block
  api.patch('/:date/blocks/:id', async (c) => {
    const date = c.req.param('date')
    const id = c.req.param('id')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const body = await c.req.json<Partial<ScheduleBlock>>()

    if (body.startTime !== undefined || body.durationMinutes !== undefined) {
      const schedule = await store.getSchedule(date)
      const existing = schedule.blocks.find((b) => b.id === id)
      if (existing) {
        const check = {
          id,
          startTime: body.startTime ?? existing.startTime,
          durationMinutes: body.durationMinutes ?? existing.durationMinutes,
        }
        const conflict = hasOverlap(schedule.blocks, check)
        if (conflict) {
          return c.json({ error: `Overlaps with "${conflict.title}" (${conflict.startTime}, ${conflict.durationMinutes}min)` }, 409)
        }
      }
    }

    const updated = await store.updateBlock(date, id, body)
    if (!updated) return c.json({ error: 'Block not found' }, 404)
    onBlockChanged?.(date, updated)
    return c.json(updated)
  })

  // Delete a block
  api.delete('/:date/blocks/:id', async (c) => {
    const date = c.req.param('date')
    const id = c.req.param('id')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const deleted = await store.deleteBlock(date, id)
    if (!deleted) return c.json({ error: 'Block not found' }, 404)
    return c.json({ status: 'deleted' })
  })

  // Skip a block
  api.post('/:date/blocks/:id/skip', async (c) => {
    const date = c.req.param('date')
    const id = c.req.param('id')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const updated = await store.updateBlock(date, id, { status: 'skipped' })
    if (!updated) return c.json({ error: 'Block not found' }, 404)
    onBlockChanged?.(date, updated)
    return c.json(updated)
  })

  // Force-execute a block now (handled by scheduler via callback)
  api.post('/:date/blocks/:id/execute', async (c) => {
    const date = c.req.param('date')
    const id = c.req.param('id')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    const schedule = await store.getSchedule(date)
    const block = schedule.blocks.find((b) => b.id === id)
    if (!block) return c.json({ error: 'Block not found' }, 404)
    if (onExecuteBlock) {
      try {
        await onExecuteBlock(date, block.id)
      } catch {
        return c.json({ error: 'Radio is not on air' }, 409)
      }
    }
    return c.json({ status: 'execute-requested', block })
  })

  // Auto-generate schedule for the next few hours using AI
  api.post('/:date/auto-generate', async (c) => {
    const date = c.req.param('date')
    if (!DATE_RE.test(date)) return c.json({ error: 'Invalid date format' }, 400)
    if (!schedulePlanner) return c.json({ error: 'Schedule planner not configured' }, 501)

    const body = await c.req.json<{ windowHours?: number; stationId?: string; scanFirst?: boolean }>().catch((): { windowHours?: number; stationId?: string; scanFirst?: boolean } => ({}))
    const stationId = body.stationId || 'pulse-ai'
    const windowHours = body.windowHours || 3
    const scanFirst = body.scanFirst ?? false
    const tracks = getAvailableTracks?.() ?? []

    try {
      if (scanFirst && autoPilot) {
        console.log('[schedule/auto-generate] scanning for news first...')
        await autoPilot.scan()
        await autoPilot.process()
      }

      const blocks = await schedulePlanner.plan(stationId, tracks, windowHours)
      return c.json({ status: 'generated', blocksCreated: blocks.length, blocks })
    } catch (err) {
      console.error('[schedule/auto-generate] error:', err)
      return c.json({ error: 'Auto-generation failed' }, 500)
    }
  })

  return api
}
