import { GoogleGenAI, Type } from '@google/genai'
import { randomBytes } from 'node:crypto'
import type { ScheduleStore } from '../schedule-store.js'
import type { NewsStore } from '../news-store.js'
import type { StationStore } from '../station-store.js'
import type { DailyMemory } from '../daily-memory.js'
import type { EditorialBrief, EnrichmentReport } from '../../types/news.js'
import type { ScheduleBlock, DaySchedule } from '../../types/schedule.js'
import type { ResearchAgent } from './research-agent.js'
import type { ArticleEnricher } from './article-enricher.js'

const GUEST_VOICE_MAP: Record<string, string> = {
  'Sarah': 'EXAVITQu4vr4xnSDxMaL',
  'Jessica': 'cgSgspJ2msm6clMCkdW9',
  'Lily': 'pFZP5JQG7iQjIQuC4Bku',
  'Roger': 'CwhRBWXzGAHq8TQ4Fs17',
  'Eric': 'cjVigY5qzO86Huf0OWal',
  'George': 'JBFqnCBsd6RMkjVDRZzb',
}
const GUEST_VOICES = Object.keys(GUEST_VOICE_MAP)

const SYSTEM_PROMPT = `You are a radio schedule planner for "Pulse", a 24/7 AI radio station covering AI, startups, and technology.

Given a list of news briefs (some are news stories, some are evergreen/feature topics) and available music tracks, generate a schedule for the NEXT FEW HOURS (the time window provided). Do NOT fill the entire day — only plan what's needed for the given window.

## Block Types

1. **topic** — A segment covering a brief (news or evergreen). Each brief becomes one topic block. Duration: 8-12 minutes depending on importance.
2. **music** — A music transition between segments. Duration: 3-5 minutes. Place one between every 2-3 topic blocks.
3. **guest** — An AI expert guest discusses a topic with the host. Duration: 10-15 minutes. Include 1-2 per planning window if there are enough topics. Pick the most interesting/debatable story for the guest. Invent a realistic expert name and expertise area relevant to the story.
4. **calls** — Open phone lines for listener call-ins. Duration: 5-10 minutes. Include at most 1 per window, usually after a hot topic.

## Rules

1. Start with the highest-priority and breaking news first. Evergreen topics should fill gaps after news.
2. Alternate between topics and music — never put 3+ topics back to back without a music break.
3. Guest blocks replace a topic block for that story (the guest discusses it instead).
4. All startTime values must be in HH:mm format (24-hour).
5. Blocks must NOT overlap — each block starts after the previous one ends.
6. Use only tracks from the available tracks list for music blocks.
7. For topic blocks, use the brief's report.broadcastSummary as the description if available, otherwise use the summary. Include report.turnPrompts if available.
8. For guest blocks, invent a plausible expert (not a real public figure) — a researcher, founder, analyst, etc.
9. Pick guest voices from this list: Sarah, Jessica, Lily, Roger, Eric, George. Vary them.
10. You should plan for the entire time window provided. Keep the radio busy. Pack blocks TIGHTLY — the next block starts exactly when the previous one ends. There should be ZERO dead air or unscheduled gaps.
11. Schedule ALL the briefs provided — they have already been pre-selected to fit the window. Do not skip any unless the show history indicates it was already covered.
12. You will receive a SHOW HISTORY with what was covered in the last 2 days. Do NOT repeat topics that were already covered UNLESS the brief explicitly contains new developments or updates. If a story has updates, frame the block title to reflect the update (e.g. "UPDATE: ...", "New details on ...").
13. Use the show history to maintain narrative continuity — reference back to earlier coverage when relevant.
14. Briefs marked as [EVERGREEN] are feature/discussion topics, not breaking news. Place them AFTER news stories. They are great candidates for guest blocks.`

const BLOCK_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, description: 'Block type: topic, music, guest, or calls' },
      title: { type: Type.STRING, description: 'Display title for the block' },
      startTime: { type: Type.STRING, description: 'Start time in HH:mm format' },
      durationMinutes: { type: Type.NUMBER, description: 'Duration in minutes' },
      briefId: { type: Type.STRING, description: 'ID of the editorial brief (for topic/guest blocks only)' },
      // Topic config
      description: { type: Type.STRING, description: 'For topic blocks: full editorial content' },
      turnPrompts: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'For topic blocks: talking points' },
      imageUrls: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'For topic blocks: image URLs' },
      // Guest config
      guestName: { type: Type.STRING, description: 'For guest blocks: expert name' },
      guestExpertise: { type: Type.STRING, description: 'For guest blocks: area of expertise' },
      guestTopic: { type: Type.STRING, description: 'For guest blocks: discussion topic' },
      guestVoice: { type: Type.STRING, description: 'For guest blocks: voice name' },
      // Music config
      playlist: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'For music blocks: track filenames' },
      musicLabel: { type: Type.STRING, description: 'For music blocks: label' },
      // Calls config
      callsTopic: { type: Type.STRING, description: 'For calls blocks: topic for callers' },
    },
    required: ['type', 'title', 'startTime', 'durationMinutes'],
  },
}

interface PlannedBlock {
  type: string
  title: string
  startTime: string
  durationMinutes: number
  briefId?: string
  description?: string
  turnPrompts?: string[]
  imageUrls?: string[]
  guestName?: string
  guestExpertise?: string
  guestTopic?: string
  guestVoice?: string
  playlist?: string[]
  musicLabel?: string
  callsTopic?: string
}

// Average minutes per content slot (topic/guest ~10min + music break ~4min)
const AVG_SLOT_MINUTES = 14
const MAX_SLOTS_PER_WINDOW = 6

const EVERGREEN_SYSTEM = `You are a creative radio programmer for "Pulse", a 24/7 AI radio station. Given the station's niche, recent show history, and number of slots to fill, propose interesting EVERGREEN discussion topics.

Evergreen topics are NOT breaking news — they are feature segments, deep dives, explainers, debates, or trend analyses that are always relevant and interesting to the audience. Examples:
- "The state of AI regulation worldwide in 2026"
- "How startups are rethinking hiring with AI agents"
- "Open source vs closed source models: who's winning?"
- "The psychology of AI hype cycles"
- "Building AI products: lessons from failed startups"

Rules:
- Each topic must be specific enough to research and discuss for 10-15 minutes
- Avoid topics already covered in the show history
- Avoid topics from the PREVIOUSLY USED list
- Mix formats: some analytical, some provocative/debate-worthy, some educational
- Return ONLY the topic titles as a JSON array of strings`

const EVERGREEN_SCHEMA = {
  type: Type.ARRAY,
  items: { type: Type.STRING },
}

export interface SchedulePlannerDeps {
  scheduleStore: ScheduleStore
  newsStore: NewsStore
  stationStore: StationStore
  dailyMemory?: DailyMemory
  researchAgent?: ResearchAgent
  articleEnricher?: ArticleEnricher
}

export class SchedulePlanner {
  private ai: GoogleGenAI
  private deps: SchedulePlannerDeps

  constructor(apiKey: string, deps: SchedulePlannerDeps) {
    const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
    process.env.GOOGLE_CLOUD_LOCATION = 'global'
    this.ai = new GoogleGenAI({ apiKey })
    if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
    else delete process.env.GOOGLE_CLOUD_LOCATION
    this.deps = deps
  }

  private async getRecentHistory(today: string): Promise<string> {
    if (!this.deps.dailyMemory) return ''

    const parts: string[] = []
    const dt = new Date(today + 'T12:00:00')

    for (let i = 2; i >= 0; i--) {
      const d = new Date(dt)
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      const memory = await this.deps.dailyMemory.getMemory(dateStr)
      if (memory) {
        const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : '2 days ago'
        parts.push(`--- ${label} (${dateStr}) ---`)
        parts.push(memory.replace(/^# .+\n\n/, '').trim())
      }
    }

    return parts.join('\n')
  }

  /**
   * Generate evergreen topic briefs to fill empty slots.
   * Each topic is researched and enriched to produce a full report with turnPrompts.
   */
  private async generateEvergreenBriefs(stationId: string, count: number, showHistory: string): Promise<EditorialBrief[]> {
    if (count <= 0 || !this.deps.researchAgent || !this.deps.articleEnricher) return []

    const station = await this.deps.stationStore.getStation(stationId)
    const niche = station?.niche ?? 'AI, startups, and technology'

    // Load past evergreen headlines to avoid repetition
    const allBriefs = await this.deps.newsStore.getBriefs(stationId)
    const pastEvergreen = allBriefs
      .filter((b) => b.id.startsWith('eg-'))
      .map((b) => b.headline)
    const pastList = pastEvergreen.length > 0
      ? `\nPREVIOUSLY USED EVERGREEN TOPICS (do NOT repeat or rephrase these):\n${pastEvergreen.map((h) => `- ${h}`).join('\n')}`
      : ''

    console.log(`[schedule-planner] generating ${count} evergreen topics for niche: ${niche} (${pastEvergreen.length} past topics excluded)`)

    const prompt = [
      `Station niche: ${niche}`,
      `Number of topics needed: ${count}`,
      showHistory ? `\nSHOW HISTORY (avoid these):\n${showHistory}` : '',
      pastList,
      `\nGenerate ${count} evergreen topic titles.`,
    ].filter(Boolean).join('\n')

    let topics: string[] = []
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: EVERGREEN_SYSTEM,
          responseMimeType: 'application/json',
          responseSchema: EVERGREEN_SCHEMA,
          temperature: 0.9,
        },
      })
      topics = JSON.parse(response.text ?? '[]')
      if (!Array.isArray(topics)) topics = []
    } catch (err) {
      console.warn(`[schedule-planner] evergreen topic generation failed: ${(err as Error).message}`)
      return []
    }

    console.log(`[schedule-planner] generated ${topics.length} evergreen topics, researching...`)

    // Research + enrich each topic in parallel (bounded)
    const results: EditorialBrief[] = []
    for (const topic of topics.slice(0, count)) {
      try {
        // Create a synthetic brief for the research pipeline
        let syntheticBrief: EditorialBrief = {
          id: `eg-${randomBytes(6).toString('hex')}`,
          headline: topic,
          summary: `Evergreen feature topic: ${topic}`,
          confidence: 'confirmed',
          priority: 30,
          isBreaking: false,
          sources: [],
          relatedCandidateIds: [],
          generatedAt: Date.now(),
          used: false,
        }

        // Phase 1: Research via Google Search + Firecrawl
        syntheticBrief = await this.deps.researchAgent!.research(syntheticBrief)

        // Phase 2: Enrich to generate full report with turnPrompts
        syntheticBrief = await this.deps.articleEnricher!.enrichBrief(syntheticBrief, [])

        if (syntheticBrief.report?.turnPrompts?.length) {
          results.push(syntheticBrief)
          console.log(`[schedule-planner] evergreen ready: "${topic.slice(0, 60)}"`)
        } else {
          console.warn(`[schedule-planner] evergreen skipped (no turnPrompts): "${topic.slice(0, 60)}"`)
        }
      } catch (err) {
        console.warn(`[schedule-planner] evergreen research failed for "${topic.slice(0, 40)}": ${(err as Error).message}`)
      }
    }

    // Persist evergreen briefs to the store as used so they won't repeat
    if (results.length > 0) {
      const toStore = results.map((b) => ({ ...b, used: true }))
      await this.deps.newsStore.addBriefs(stationId, toStore).catch((err) =>
        console.warn(`[schedule-planner] failed to persist evergreen briefs: ${(err as Error).message}`)
      )
    }

    return results
  }

  async plan(stationId: string, availableTracks: string[], windowHours = 3): Promise<ScheduleBlock[]> {
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    // Get existing schedule — preserve completed/active blocks
    const existing = await this.deps.scheduleStore.getSchedule(date)
    // Preserve completed, active, and skipped blocks always.
    const preserved = existing.blocks.filter((b) =>
      b.status === 'completed' || b.status === 'active' || b.status === 'skipped'
    )

    // Find the latest end time among completed/active blocks or use current time
    let windowStart = currentMinutes
    for (const b of preserved) {
      if (b.status !== 'completed' && b.status !== 'active') continue
      const bEnd = toMinutes(b.startTime) + b.durationMinutes
      if (bEnd > windowStart) windowStart = bEnd
    }
    // Round up to next minute boundary (no 5-min rounding — fill ASAP)
    windowStart = Math.ceil(windowStart)
    const windowEnd = Math.min(windowStart + windowHours * 60, 24 * 60)

    // Preserve pending blocks that fall OUTSIDE the planning window
    // (e.g. manually created blocks for later times)
    const pendingOutsideWindow = existing.blocks.filter((b) => {
      if (b.status !== 'pending') return false
      const bStart = toMinutes(b.startTime)
      return bStart >= windowEnd || (bStart + b.durationMinutes) <= windowStart
    })

    if (windowEnd - windowStart < 10) {
      console.log('[schedule-planner] not enough time in window, skipping')
      return []
    }

    // Compute available gaps within the window (accounting for preserved blocks)
    const fixedBlocks = [...preserved.filter(b => b.status !== 'skipped'), ...pendingOutsideWindow]
    const gaps = computeGaps(fixedBlocks, windowStart, windowEnd)
    const totalAvailableMinutes = gaps.reduce((sum, g) => sum + g.minutes, 0)

    if (totalAvailableMinutes < 10) {
      console.log(`[schedule-planner] only ${totalAvailableMinutes} minutes available, skipping`)
      return []
    }

    // Calculate how many content slots fit in the available time (capped)
    const maxSlots = Math.min(MAX_SLOTS_PER_WINDOW, Math.floor(totalAvailableMinutes / AVG_SLOT_MINUTES))

    // Get pending briefs — only take what fits, sorted by priority
    const allBriefs = await this.deps.newsStore.getBriefs(stationId, { pendingOnly: true })
    const sortedBriefs = allBriefs.sort((a, b) => b.priority - a.priority)
    const briefs = sortedBriefs.slice(0, maxSlots)
    const reservedCount = allBriefs.length - briefs.length

    const startTimeStr = minutesToTime(windowStart)
    const endTimeStr = minutesToTime(windowEnd)

    // Gather show history from last 2 days
    const showHistory = await this.getRecentHistory(date)

    // Generate evergreen topics if not enough news briefs to fill the window
    const evergreenSlotsNeeded = Math.max(0, maxSlots - briefs.length)
    let evergreenBriefs: EditorialBrief[] = []
    if (evergreenSlotsNeeded > 0) {
      evergreenBriefs = await this.generateEvergreenBriefs(stationId, evergreenSlotsNeeded, showHistory)
    }

    const allSchedulableBriefs = [...briefs, ...evergreenBriefs]
    if (allSchedulableBriefs.length === 0) {
      console.log('[schedule-planner] no briefs or evergreen topics available')
      return []
    }

    if (reservedCount > 0) {
      console.log(`[schedule-planner] reserved ${reservedCount} briefs for future windows`)
    }
    console.log(`[schedule-planner] planning ${startTimeStr}-${endTimeStr} with ${briefs.length} news + ${evergreenBriefs.length} evergreen briefs and ${availableTracks.length} tracks`)

    const briefsSummary = allSchedulableBriefs.map((b) => {
      const isEvergreen = b.id.startsWith('eg-')
      let entry = `[${b.id}]${isEvergreen ? ' [EVERGREEN]' : ''} "${b.headline}" (priority: ${b.priority}, confidence: ${b.confidence}, breaking: ${b.isBreaking})\nSummary: ${b.summary}`
      if (b.report) {
        entry += `\nBroadcast summary: ${b.report.broadcastSummary}`
        if (b.report.turnPrompts?.length) {
          entry += `\nTurn prompts: ${b.report.turnPrompts.join(' | ')}`
        }
        if (b.report.analysisAngles?.length) {
          entry += `\nAnalysis angles: ${b.report.analysisAngles.join('; ')}`
        }
      }
      if (b.imageUrls?.length) {
        entry += `\nImages: ${b.imageUrls.join(', ')}`
      }
      return entry
    }).join('\n\n')

    const tracksList = availableTracks.length > 0
      ? `Available music tracks:\n${availableTracks.join('\n')}`
      : 'No music tracks available — skip music blocks.'

    const historySection = showHistory
      ? `\n\n=== SHOW HISTORY (last 2 days — avoid repeating these topics) ===\n${showHistory}`
      : ''

    const gapsDescription = gaps.map(g => `- ${g.start} to ${g.end} (${g.minutes} minutes)`).join('\n')

    const userPrompt = `Plan the schedule for time window ${startTimeStr} to ${endTimeStr}.${historySection}

AVAILABLE TIME SLOTS (fill these completely, no dead air):
${gapsDescription}

Total available: ${totalAvailableMinutes} minutes.

News briefs to schedule:
${briefsSummary}

${tracksList}

Available guest voices: ${GUEST_VOICES.join(', ')}

Generate the blocks array. Start the first block at ${gaps[0]?.start ?? startTimeStr}. Pack blocks tightly — each block starts EXACTLY when the previous one ends. Fill ALL available time.`

    const response = await this.ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: BLOCK_SCHEMA,
        temperature: 0.7,
      },
    })

    const planned = JSON.parse(response.text ?? '[]') as PlannedBlock[]
    if (!Array.isArray(planned) || planned.length === 0) {
      console.warn('[schedule-planner] LLM returned empty schedule')
      return []
    }

    // Convert planned blocks to ScheduleBlock format
    const newBlocks: ScheduleBlock[] = []
    const usedBriefIds = new Set<string>()

    for (const p of planned) {
      const blockType = validateBlockType(p.type)
      if (!blockType) continue

      // Validate time is within window
      const blockStart = toMinutes(p.startTime)
      if (blockStart < windowStart || blockStart >= windowEnd) continue

      const block: ScheduleBlock = {
        id: randomBytes(8).toString('hex'),
        type: blockType,
        title: p.title,
        startTime: p.startTime,
        durationMinutes: Math.max(1, Math.round(p.durationMinutes)),
        status: 'pending',
        config: buildConfig(p, allSchedulableBriefs),
      }

      // Check overlap against preserved (excluding skipped) + outside-window pending + already-added new blocks
      const overlapCheck = [...preserved.filter(b => b.status !== 'skipped'), ...pendingOutsideWindow, ...newBlocks]
      if (hasOverlap(overlapCheck, block)) continue

      newBlocks.push(block)

      if (p.briefId) usedBriefIds.add(p.briefId)
    }

    if (newBlocks.length === 0) {
      console.warn('[schedule-planner] no valid blocks after validation')
      return []
    }

    // Pack blocks contiguously into available gaps (eliminate dead air)
    newBlocks.sort((a, b) => a.startTime.localeCompare(b.startTime))
    let blockIdx = 0
    for (const gap of gaps) {
      let cursor = toMinutes(gap.start)
      const gapEnd = toMinutes(gap.end)

      while (blockIdx < newBlocks.length && cursor + newBlocks[blockIdx].durationMinutes <= gapEnd) {
        newBlocks[blockIdx].startTime = minutesToTime(cursor)
        cursor += newBlocks[blockIdx].durationMinutes
        blockIdx++
      }

      // Fill remaining gap with music
      const remaining = gapEnd - cursor
      if (remaining >= 3 && availableTracks.length > 0) {
        newBlocks.push({
          id: randomBytes(8).toString('hex'),
          type: 'music',
          title: 'Music',
          startTime: minutesToTime(cursor),
          durationMinutes: remaining,
          status: 'pending',
          config: { playlist: availableTracks.slice(0, 3), label: 'Transition', loop: true },
        })
      }
    }

    // Keep preserved + outside-window pending + new AI-generated blocks
    const finalBlocks = [
      ...preserved,
      ...pendingOutsideWindow,
      ...newBlocks,
    ].sort((a, b) => a.startTime.localeCompare(b.startTime))

    const schedule: DaySchedule = { date, blocks: finalBlocks }
    await this.deps.scheduleStore.saveSchedule(schedule)

    // Mark used news briefs (skip evergreen — they aren't in the store)
    for (const briefId of usedBriefIds) {
      if (briefId.startsWith('eg-')) continue
      await this.deps.newsStore.sendBrief(stationId, briefId, 'schedule-planner').catch(() => {})
    }

    const newsUsed = [...usedBriefIds].filter((id) => !id.startsWith('eg-')).length
    const evergreenUsed = [...usedBriefIds].filter((id) => id.startsWith('eg-')).length
    console.log(`[schedule-planner] created ${newBlocks.length} blocks (${newsUsed} news, ${evergreenUsed} evergreen), ${reservedCount} briefs reserved`)
    return newBlocks
  }
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function validateBlockType(type: string): ScheduleBlock['type'] | null {
  const valid = ['topic', 'guest', 'music', 'calls']
  return valid.includes(type) ? type as ScheduleBlock['type'] : null
}

function computeGaps(blocks: ScheduleBlock[], windowStartMin: number, windowEndMin: number): Array<{ start: string; end: string; minutes: number }> {
  const sorted = blocks
    .filter((b) => {
      const bStart = toMinutes(b.startTime)
      const bEnd = bStart + b.durationMinutes
      return bEnd > windowStartMin && bStart < windowEndMin
    })
    .sort((a, b) => a.startTime.localeCompare(b.startTime))

  const gaps: Array<{ start: string; end: string; minutes: number }> = []
  let cursor = windowStartMin

  for (const block of sorted) {
    const bStart = toMinutes(block.startTime)
    const bEnd = bStart + block.durationMinutes

    if (bStart > cursor) {
      gaps.push({
        start: minutesToTime(cursor),
        end: minutesToTime(bStart),
        minutes: bStart - cursor,
      })
    }
    cursor = Math.max(cursor, bEnd)
  }

  if (cursor < windowEndMin) {
    gaps.push({
      start: minutesToTime(cursor),
      end: minutesToTime(windowEndMin),
      minutes: windowEndMin - cursor,
    })
  }

  return gaps
}

function hasOverlap(blocks: ScheduleBlock[], newBlock: ScheduleBlock): boolean {
  const newStart = toMinutes(newBlock.startTime)
  const newEnd = newStart + newBlock.durationMinutes
  for (const b of blocks) {
    const bStart = toMinutes(b.startTime)
    const bEnd = bStart + b.durationMinutes
    if (newStart < bEnd && newEnd > bStart) return true
  }
  return false
}

function buildConfig(p: PlannedBlock, briefs: EditorialBrief[]): ScheduleBlock['config'] {
  const brief = p.briefId ? briefs.find((b) => b.id === p.briefId) : undefined

  switch (p.type) {
    case 'topic':
      return {
        description: p.description || brief?.report?.broadcastSummary || brief?.summary || p.title,
        imageUrls: p.imageUrls?.length ? p.imageUrls : brief?.imageUrls ?? [],
        turnPrompts: p.turnPrompts?.length ? p.turnPrompts : brief?.report?.turnPrompts,
        sources: brief?.sources?.map((s) => s.label),
      }
    case 'guest':
      return {
        name: p.guestName || 'AI Expert',
        expertise: p.guestExpertise || 'Technology',
        topic: p.guestTopic || brief?.headline || p.title,
        voice: GUEST_VOICE_MAP[p.guestVoice ?? ''] ?? GUEST_VOICE_MAP['Sarah'],
      }
    case 'music':
      return {
        playlist: p.playlist?.length ? p.playlist : [],
        label: p.musicLabel || p.title,
        loop: true,
      }
    case 'calls':
      return {
        topic: p.callsTopic || brief?.headline,
      }
    default:
      return { message: p.title }
  }
}
