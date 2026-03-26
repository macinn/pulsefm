import type { ScheduleStore } from './schedule-store.js'
import type { ScheduleBlock, TopicConfig, GuestBlockConfig, MusicConfig } from '../types/schedule.js'

export interface SchedulerDeps {
  store: ScheduleStore
  /** Ensure the presenter session is connected (lazy init) */
  ensurePresenter(): Promise<void>
  /** Inject a topic into the presenter */
  injectTopic(config: TopicConfig): void
  /** Start a guest segment */
  startGuest(config: GuestBlockConfig): Promise<void>
  /** Stop active guest segment */
  stopGuest(): void
  /** Play a music track */
  playMusic(config: MusicConfig): void
  /** Stop current music */
  stopMusic(): void
  /** Inject a break message */
  injectBreak(message: string): void
  /** Open phone lines for listener calls */
  openCalls(topic?: string): void
  /** Close phone lines */
  closeCalls(): void
  /** Broadcast a WS message to all clients */
  broadcast(message: string): void
  /** Warn presenter to wrap up (30s before block end) */
  onWrapUp?(): void
  /** Topic/guest finished early — fill remaining time with music */
  onBlockFinishedEarly?(remainingMs: number): void
  /** Number of connected listeners (for token saving) */
  getListenerCount?(): number
}

function todayDate(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function nowHHmm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + mins
  const nh = Math.floor(total / 60) % 24
  const nm = total % 60
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`
}

function hhmmToEpochMs(time: string): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export class Scheduler {
  private interval: ReturnType<typeof setInterval> | null = null
  private deps: SchedulerDeps
  private activeBlockId: string | null = null
  private activeBlockEndTime: string | null = null
  private activeBlockType: string | null = null
  private wrapUpTimer: ReturnType<typeof setTimeout> | null = null
  private wrapUpFired = false
  private waitingForListeners = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  start(intervalMs = 15_000) {
    if (this.interval) return
    this.interval = setInterval(() => this.tick(), intervalMs)
    // Run immediately once
    this.tick()
    console.log('[scheduler] started')
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    // Reset active block back to pending so it can be resumed on next start
    if (this.activeBlockId) {
      const date = todayDate()
      await this.deps.store.updateBlock(date, this.activeBlockId, { status: 'pending' })
      console.log(`[scheduler] reset active block ${this.activeBlockId} to pending`)
    }
    this.activeBlockId = null
    this.activeBlockEndTime = null
    this.activeBlockType = null
    this.clearWrapUpTimer()
    console.log('[scheduler] stopped')
  }

  /** Whether the scheduler currently has an active block running */
  hasActiveBlock(): boolean {
    return this.activeBlockId !== null
  }

  /** Get the type of the currently active block (if any) */
  getActiveBlockType(): string | null {
    return this.activeBlockType
  }

  /** Milliseconds remaining in the active block, or 0 if none */
  getRemainingMs(): number {
    if (!this.activeBlockEndTime) return 0
    const endMs = hhmmToEpochMs(this.activeBlockEndTime)
    return Math.max(0, endMs - Date.now())
  }

  /** Notify the scheduler that the topic/guest segment content finished early */
  notifyContentFinished(): void {
    if (!this.activeBlockId) return
    if (this.activeBlockType !== 'topic' && this.activeBlockType !== 'guest') return
    const remaining = this.getRemainingMs()
    if (remaining > 5000) {
      this.clearWrapUpTimer()
      console.log(`[scheduler] content finished early, ${Math.round(remaining / 1000)}s remaining`)
      this.deps.onBlockFinishedEarly?.(remaining)
    }
  }

  /** Check if there's a pending block starting within the next N minutes */
  async hasUpcomingBlock(withinMinutes: number): Promise<boolean> {
    const date = todayDate()
    const now = nowHHmm()
    const cutoff = addMinutes(now, withinMinutes)
    const schedule = await this.deps.store.getSchedule(date)
    return schedule.blocks.some(
      (b) => b.status === 'pending' && b.startTime >= now && b.startTime <= cutoff
    )
  }

  /** Whether the scheduler is paused waiting for listeners to connect */
  isWaitingForListeners(): boolean {
    return this.waitingForListeners
  }

  /** Notify that a listener connected — resume if waiting */
  notifyListenerConnected(): void {
    if (this.waitingForListeners) {
      console.log('[scheduler] listener connected — resuming')
      this.waitingForListeners = false
      this.tick()
    }
  }

  /** Force-execute a specific block now, regardless of its startTime */
  async executeBlock(date: string, blockId: string) {
    const schedule = await this.deps.store.getSchedule(date)
    const block = schedule.blocks.find((b) => b.id === blockId)
    if (!block || block.status !== 'pending') return
    await this.runBlock(date, block)
  }

  private async tick() {
    const date = todayDate()
    const now = nowHHmm()
    const schedule = await this.deps.store.getSchedule(date)

    // Check if active block has ended
    if (this.activeBlockId && this.activeBlockEndTime && now >= this.activeBlockEndTime) {
      await this.completeBlock(date, this.activeBlockId)
    }

    // Recover orphaned active blocks (e.g. after stop/start)
    if (!this.activeBlockId) {
      const orphaned = schedule.blocks.filter((b) => b.status === 'active')
      for (const block of orphaned) {
        await this.deps.store.updateBlock(date, block.id, { status: 'pending' })
        this.broadcastBlockUpdate(block.id, { ...block, status: 'pending' })
        console.log(`[scheduler] recovered orphaned active block: ${block.title}`)
      }
    }

    // Find the next pending block whose time has arrived (and hasn't fully elapsed)
    if (!this.activeBlockId) {
      const pending = schedule.blocks
        .filter((b) => {
          if (b.status !== 'pending') return false
          if (b.startTime > now) return false
          // Skip blocks whose end time has already passed
          const endTime = addMinutes(b.startTime, b.durationMinutes)
          return endTime > now
        })
        .sort((a, b) => a.startTime.localeCompare(b.startTime))

      // Also mark fully-elapsed pending blocks as skipped
      const expired = schedule.blocks.filter((b) => {
        if (b.status !== 'pending') return false
        if (b.startTime > now) return false
        const endTime = addMinutes(b.startTime, b.durationMinutes)
        return endTime <= now
      })
      for (const skipped of expired) {
        await this.deps.store.updateBlock(date, skipped.id, { status: 'skipped' })
        this.broadcastBlockUpdate(skipped.id, { ...skipped, status: 'skipped' })
        console.log(`[scheduler] skipped expired block: ${skipped.title} (ended ${addMinutes(skipped.startTime, skipped.durationMinutes)})`)
      }

      if (pending.length > 0) {
        // Execute the first ready block; skip any that are past their window
        const block = pending[pending.length - 1] // Most recent pending

        // AI blocks (topic, guest, calls, break) need listeners to save tokens
        const needsAI = block.type === 'topic' || block.type === 'guest' || block.type === 'calls' || block.type === 'break'
        const listeners = this.deps.getListenerCount?.() ?? 1
        if (needsAI && listeners === 0) {
          this.waitingForListeners = true
          console.log(`[scheduler] no listeners — pausing AI block "${block.title}" until someone connects`)
          return
        }
        this.waitingForListeners = false

        // Skip blocks that came before the chosen one
        for (const skipped of pending.slice(0, -1)) {
          await this.deps.store.updateBlock(date, skipped.id, { status: 'skipped' })
          this.broadcastBlockUpdate(skipped.id, { ...skipped, status: 'skipped' })
        }
        await this.runBlock(date, block)
      }
    }
  }

  private async runBlock(date: string, block: ScheduleBlock) {
    console.log(`[scheduler] executing block: ${block.title} (${block.type})`)

    // Ensure presenter is ready for blocks that need it
    if (block.type === 'topic' || block.type === 'guest' || block.type === 'calls' || block.type === 'break') {
      await this.deps.ensurePresenter()
    }

    // Mark active
    const updated = await this.deps.store.updateBlock(date, block.id, { status: 'active' })
    this.activeBlockId = block.id
    this.activeBlockEndTime = addMinutes(block.startTime, block.durationMinutes)
    this.activeBlockType = block.type
    if (updated) this.broadcastBlockUpdate(block.id, updated)

    const config = block.config

    // Start 30s wrap-up warning for topic/guest blocks
    if (block.type === 'topic' || block.type === 'guest') {
      this.startWrapUpTimer(block.durationMinutes)
    }

    switch (block.type) {
      case 'topic':
        this.deps.injectTopic(config as TopicConfig)
        break
      case 'guest':
        await this.deps.startGuest(config as GuestBlockConfig)
        break
      case 'music':
        this.deps.playMusic(config as MusicConfig)
        break
      case 'break':
        this.deps.injectBreak(
          (config as { message?: string }).message ?? 'We will be right back after a short break.'
        )
        break
      case 'calls':
        this.deps.openCalls((config as { topic?: string }).topic)
        break
    }
  }

  private async completeBlock(date: string, blockId: string) {
    this.clearWrapUpTimer()
    const schedule = await this.deps.store.getSchedule(date)
    const block = schedule.blocks.find((b) => b.id === blockId)
    if (!block) return

    // Type-specific cleanup
    if (block.type === 'guest') {
      this.deps.stopGuest()
    } else if (block.type === 'music') {
      this.deps.stopMusic()
    } else if (block.type === 'calls') {
      this.deps.closeCalls()
    }

    // Stop fill music that may be playing after early content finish
    if (block.type === 'topic' || block.type === 'guest') {
      this.deps.stopMusic()
    }

    const updated = await this.deps.store.updateBlock(date, blockId, { status: 'completed' })
    this.activeBlockId = null
    this.activeBlockEndTime = null
    this.activeBlockType = null
    if (updated) this.broadcastBlockUpdate(blockId, updated)
    console.log(`[scheduler] completed block: ${block.title}`)
  }

  private startWrapUpTimer(durationMinutes: number) {
    this.clearWrapUpTimer()
    this.wrapUpFired = false
    const warnAtMs = Math.max(0, (durationMinutes * 60 - 30) * 1000)
    this.wrapUpTimer = setTimeout(() => {
      this.wrapUpFired = true
      console.log('[scheduler] 30s warning — wrap up')
      this.deps.onWrapUp?.()
    }, warnAtMs)
  }

  private clearWrapUpTimer() {
    if (this.wrapUpTimer) {
      clearTimeout(this.wrapUpTimer)
      this.wrapUpTimer = null
    }
  }

  private broadcastBlockUpdate(blockId: string, block: ScheduleBlock) {
    this.deps.broadcast(
      JSON.stringify({ type: 'schedule-update', blockId, block })
    )
  }
}
