import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import path from 'node:path'
import { createGuestSession, type GuestSession, type GuestConfig } from './lib/guest.js'
import { createCohostSession, type CohostSession, COHOST_NAME } from './lib/cohost.js'
import { createScreenerSession, type ScreenerSession } from './lib/screener.js'
import { createPresenterSession, type PresenterSession } from './lib/presenter.js'
import type { ElevenLabsSession } from './lib/elevenlabs-live.js'
import { connectElevenLabs } from './lib/elevenlabs-live.js'
import { provisionAgents, getAgentIds } from './lib/agent-provision.js'
import { getDb } from './lib/db.js'
import { SqliteScheduleStore } from './lib/schedule-store.js'
import { createScheduleRoutes } from './routes/schedule.js'
import { createNewsRoutes } from './routes/news.js'
import { Scheduler } from './lib/scheduler.js'
import { MusicPlayer } from './lib/music-player.js'
import { MusicGenerator } from './lib/music-generator.js'
import { SqliteStationStore } from './lib/station-store.js'
import { SqliteNewsStore } from './lib/news-store.js'
import { RssScanner } from './lib/agents/rss-scanner.js'
import { RedditScout } from './lib/agents/reddit-scout.js'
import { TrendingScout } from './lib/agents/trending-scout.js'
import { EditorAgent } from './lib/agents/editor-agent.js'
import { FirecrawlScanner } from './lib/agents/firecrawl-scanner.js'
import { ResearchAgent } from './lib/agents/research-agent.js'
import { ArticleEnricher } from './lib/agents/article-enricher.js'
import { AutoPilot } from './lib/auto-pilot.js'
import { NewsDedup } from './lib/news-dedup.js'
import { SchedulePlanner } from './lib/agents/schedule-planner.js'
import { DailyMemory } from './lib/daily-memory.js'
import { MusicScheduler } from './lib/music-scheduler.js'
import { OpLocks } from './lib/op-locks.js'
import type { TopicConfig, GuestBlockConfig, MusicConfig } from './types/schedule.js'
import type { EditorialBrief } from './types/news.js'

type TranscriptRole = 'pulse' | 'caller' | 'guest' | 'cohost' | 'producer' | 'system'

function formatBriefForAir(brief: EditorialBrief): string {
  const r = brief.report
  if (!r || !r.broadcastSummary) {
    return `BREAKING NEWS: ${brief.headline}. ${brief.summary}`
  }
  const parts = [`HEADLINE: ${brief.headline}`]
  parts.push(`\nCONTEXT: ${r.broadcastSummary}`)
  if (r.keyFindings.length > 0) {
    parts.push(`\nKEY DETAILS:\n${r.keyFindings.map((f) => `- ${f}`).join('\n')}`)
  }
  if (r.analysisAngles.length > 0) {
    parts.push(`\nANALYSIS ANGLES:\n${r.analysisAngles.map((a) => `- ${a}`).join('\n')}`)
  }
  if (r.relatedTopics.length > 0) {
    parts.push(`\nRELATED TOPICS: ${r.relatedTopics.join('; ')}`)
  }
  if (r.editorialNotes) {
    parts.push(`\nEDITORIAL NOTES: ${r.editorialNotes}`)
  }
  return parts.join('\n')
}

const app = new Hono()
app.use('*', cors())
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

// Connected radio listeners
const radioClients = new Set<WSContext>()

// Radio on-air state (independent of presenter session lifecycle)
let isOnAir = false

// Presenter session (singleton — lazy, created by scheduler when needed)
let presenter: PresenterSession | null = null

// Guest session
let guest: GuestSession | null = null
let currentGuestTranscriptChunk = ''

// Co-host session (discussion after topics)
let cohost: CohostSession | null = null
let currentCohostTranscriptChunk = ''
let cohostTurnCount = 0
let lastTopicDescription = ''
const MAX_COHOST_TURNS = 3

// Co-anchor voice. Armed immediately and triggered on the next natural
// presenter turn break so it does not get stuck waiting on VAD.
let activeProducerSession: ElevenLabsSession | null = null
let activeProducerMessage: string | null = null
let activeProducerTranscriptChunk = ''
let activeProducerTriggered = false
let activeProducerFallbackTimer: ReturnType<typeof setTimeout> | null = null

// Phone lines state — controlled by presenter AI via tool calls
let callsOpen = false

// Screener session — handles callers when phone lines are closed
let screener: ScreenerSession | null = null
let callerWs: WSContext | null = null
let activeLiveCallerName: string | null = null

// Suppress auto-continue after tool responses to avoid double-prompting
let pendingToolResponse = false

// Suppress auto-continue after breaking news / direct injection to avoid crossed transmissions
let pendingInjection = false



// Transcript log (ring buffer)
const MAX_TRANSCRIPT_ENTRIES = 200
const transcriptLog: { ts: number; role: TranscriptRole; text: string }[] = []
let currentTranscriptChunk = ''

// Schedule store, music player, and scheduler
const dataDir = path.resolve(import.meta.dirname, '..', 'data')
const mediaDir = path.resolve(import.meta.dirname, '..', 'media')
const db = getDb(dataDir)
const opLocks = new OpLocks(db)
const scheduleStore = new SqliteScheduleStore(db)
const dailyMemory = new DailyMemory(db, scheduleStore)
const musicPlayer = new MusicPlayer({ broadcast, mediaDir })
const musicGenerator = new MusicGenerator(mediaDir, db)
const musicScheduler = new MusicScheduler(musicGenerator)

// Station and news stores + agents
const stationStore = new SqliteStationStore(db)
const newsStore = new SqliteNewsStore(db)

// Seed default station if none exists
async function seedDefaultStation() {
  const existing = await stationStore.listStations()
  if (existing.length > 0) return

  const pulse: import('./types/station.js').StationConfig = {
    id: 'pulse-ai',
    name: 'Pulse',
    tagline: 'AI & Startups 24/7',
    niche: 'AI, machine learning, startups, tech industry',
    color: '#E54D2E',
    voice: 'Orus',
    promptPersonality: 'Witty, sharp, informed. You are Pulse, the always-on AI radio host covering the world of artificial intelligence and startups. You speak with confidence and a touch of editorial flair.',
    sources: [
      { id: 'src-rss-tc', type: 'rss', enabled: true, config: { feedUrl: 'https://techcrunch.com/feed/', label: 'TechCrunch' } },
      { id: 'src-rss-verge', type: 'rss', enabled: true, config: { feedUrl: 'https://www.theverge.com/rss/index.xml', label: 'The Verge' } },
      { id: 'src-reddit-ml', type: 'reddit', enabled: true, config: { subreddit: 'MachineLearning', sortBy: 'hot', minUpvotes: 100 } },
      { id: 'src-reddit-ai', type: 'reddit', enabled: true, config: { subreddit: 'artificial', sortBy: 'hot', minUpvotes: 50 } },
      { id: 'src-gemini-ai', type: 'gemini-search', enabled: true, config: { keywords: ['AI news', 'startup funding', 'large language models', 'tech IPO'], searchIntervalMinutes: 15 } },
      { id: 'src-firecrawl', type: 'firecrawl', enabled: true, config: { keywords: ['artificial intelligence', 'AI startups', 'large language models'] } },
    ],
    createdAt: Date.now(),
    isDefault: true,
  }

  await stationStore.createStation(pulse)
  console.log('[seed] Created default station: Pulse')
}
seedDefaultStation().catch((err) => console.error('[seed] Failed:', err))
const rssScanner = new RssScanner()
const redditScout = new RedditScout()
const trendingScout = new TrendingScout(process.env.GOOGLE_API_KEY ?? '')
const editorAgent = new EditorAgent(process.env.GOOGLE_API_KEY ?? '')
const firecrawlScanner = new FirecrawlScanner(process.env.FIRECRAWL_API_KEY ?? '')
const researchAgent = new ResearchAgent(process.env.GOOGLE_API_KEY ?? '', process.env.FIRECRAWL_API_KEY ?? '')
const articleEnricher = new ArticleEnricher(process.env.GOOGLE_API_KEY ?? '', process.env.FIRECRAWL_API_KEY ?? '')
articleEnricher.setResearchAgent(researchAgent)
const newsDedup = new NewsDedup(process.env.GOOGLE_API_KEY ?? '', db)
const schedulePlanner = new SchedulePlanner(process.env.GOOGLE_API_KEY ?? '', {
  scheduleStore,
  newsStore,
  stationStore,
  dailyMemory,
  researchAgent,
  articleEnricher,
})

const autoPilot = new AutoPilot(
  {
    newsStore,
    stationStore,
    rssScanner,
    redditScout,
    firecrawlScanner,
    editorAgent,
    articleEnricher,
    researchAgent,
    newsDedup,
    onBriefsReady(stationId, briefs) {
      if (!isOnAir || !presenter) return
      // Auto-inject the highest-priority unsent brief
      const best = briefs.sort((a, b) => b.priority - a.priority)[0]
      if (!best) return
      const turnPrompts = best.report?.turnPrompts
      const imageUrls = best.imageUrls ?? (best.imageUrl ? [best.imageUrl] : [])
      const headline = best.headline
      const description = formatBriefForAir(best)

      const activeType = scheduler.getActiveBlockType()
      if (activeType === 'topic') {
        // Topic block active — queue as soft interruption if breaking
        if (best.isBreaking) {
          pendingInjection = true
          dailyMemory.buildContext().then((ctx) => {
            const fullCue = ctx
              ? `${ctx}\n\n=== BREAKING NEWS ===\n${description}`
              : description
            presenter!.sendBreakingNews(fullCue, turnPrompts)
          }).catch(() => {
            presenter!.sendBreakingNews(description, turnPrompts)
          })
          pushTranscript('system', `[auto-pilot] Breaking: ${headline}`)
          dailyMemory.addEntry(`BREAKING (auto): ${headline.slice(0, 80)}`).catch(() => {})
        } else {
          presenter.queueSoftInterruption(description)
          pushTranscript('system', `[auto-pilot] Queued: ${headline}`)
        }
      } else if (!activeType) {
        // Idle — inject directly as production cue (same path as manual injectTopic)
        dailyMemory.buildContext().then((ctx) => {
          const fullCue = ctx
            ? `${ctx}\n\n=== NEW TOPIC ===\n${description}`
            : description
          presenter!.sendProductionCue(fullCue, turnPrompts)
        }).catch(() => {
          presenter!.sendProductionCue(description, turnPrompts)
        })
        pushTranscript('system', `[auto-pilot] Topic: ${headline}`)
        dailyMemory.addEntry(`Topic started (auto): ${headline.slice(0, 80)}`).catch(() => {})
      }
      if (imageUrls.length > 0) {
        broadcast(JSON.stringify({ type: 'news-image', imageUrl: imageUrls[0], imageUrls, headline }))
      }
      newsStore.sendBrief(stationId, best.id, 'auto-pilot').catch(() => {})

      // Auto-generate schedule after new briefs
      schedulePlanner.plan(stationId, musicPlayer.listTracks()).catch((err) =>
        console.error('[auto-pilot] schedule planner error:', err),
      )
    },
  },
  { stationId: 'pulse-ai' },
)

function pushTranscript(role: TranscriptRole, text: string) {
  transcriptLog.push({ ts: Date.now(), role, text })
  if (transcriptLog.length > MAX_TRANSCRIPT_ENTRIES) transcriptLog.shift()
}

function clearProducerFallbackTimer() {
  if (activeProducerFallbackTimer) {
    clearTimeout(activeProducerFallbackTimer)
    activeProducerFallbackTimer = null
  }
}

function resetProducerState() {
  clearProducerFallbackTimer()
  activeProducerSession = null
  activeProducerMessage = null
  activeProducerTranscriptChunk = ''
  activeProducerTriggered = false
}

function continuePresenterAfterProducer() {
  resetProducerState()
  presenter?.continueStream()
}

function handoffProducerToPresenter(producerText: string) {
  resetProducerState()
  presenter?.respondToProducer(producerText)
}

function triggerActiveProducer() {
  if (!activeProducerSession || !activeProducerMessage || activeProducerTriggered) return

  activeProducerTriggered = true

  // Flush client audio queues so the producer voice is heard immediately
  broadcast(JSON.stringify({ type: 'audio-reset' }))

  activeProducerSession.sendContextualUpdate(
    `[BREAKING UPDATE]\n${activeProducerMessage}\n\n` +
    `Interrupt the presenter politely (e.g. "Sorry to interrupt, but we just got something important...") ` +
    `then deliver that update. Maximum 2-4 sentences. English only.`
  )
  activeProducerSession.sendText('Go ahead, deliver the breaking update now.')

  clearProducerFallbackTimer()
  activeProducerFallbackTimer = setTimeout(() => {
    if (!activeProducerSession || !activeProducerTriggered) return
    console.warn('[producer] timeout waiting for producer response, resuming presenter')
    const stuckProducer = activeProducerSession
    resetProducerState()
    stuckProducer.close()
    presenter?.continueStream()
  }, 10000)
}

function broadcast(message: string) {
  for (const ws of radioClients) {
    if (ws.readyState === 1) ws.send(message)
  }
}

async function ensurePresenter() {
  if (!isOnAir) return null
  if (presenter) return presenter

  presenter = await createPresenterSession({
    onAudio(base64: string) {
      // Suppress presenter audio while producer is speaking
      if (activeProducerTriggered) return
      broadcast(JSON.stringify({ type: 'audio', data: base64 }))
    },
    onBroadcastAudio(base64Pcm24k: string) {
      if (base64Pcm24k === '__flush__') {
        broadcast(JSON.stringify({ type: 'audio-reset' }))
      } else {
        broadcast(JSON.stringify({ type: 'audio', data: base64Pcm24k }))
      }
    },
    onTranscript(text: string) {
      // Suppress presenter transcript while producer is speaking
      if (activeProducerTriggered) return
      currentTranscriptChunk += text
      broadcast(JSON.stringify({ type: 'transcript', text }))
    },
    onTurnComplete() {
      // Guard: stop processing if radio went off air (zombie callbacks from closing session)
      if (!isOnAir) return

      const completedChunk = currentTranscriptChunk.trim()
      if (completedChunk) {
        pushTranscript('pulse', completedChunk)
        currentTranscriptChunk = ''
      }
      broadcast(JSON.stringify({ type: 'turn-complete' }))

      console.log(`[presenter] onTurnComplete — chunk: ${completedChunk.length}ch, pendingTool: ${pendingToolResponse}, pendingInjection: ${pendingInjection}, caller: ${!!activeLiveCallerName}, guest: ${!!guest}, cohost: ${!!cohost}, producer: ${!!activeProducerSession}`)

      // After a tool response, the model already got its stimulus — don't double-prompt
      if (pendingToolResponse) {
        pendingToolResponse = false
        return
      }

      // After breaking news / direct injection, skip one continue cycle to avoid crossed audio
      if (pendingInjection) {
        pendingInjection = false
        return
      }

      // While a listener is live on air, stop auto-monologuing and wait for caller audio.
      if (activeLiveCallerName) {
        return
      }

      if (guest) {
        // Guest mode: send presenter's words to guest for response
        if (completedChunk) guest.respondTo(completedChunk)
      } else if (cohost) {
        // Co-host discussion: send presenter's words to co-host
        if (completedChunk) cohost.discuss(completedChunk)
      } else if (activeProducerSession && !activeProducerTriggered) {
        // Producer armed — presenter just finished a sentence/idea, trigger now
        triggerActiveProducer()
      } else if (activeProducerSession) {
        // Producer already speaking — don't continue presenter
      } else {
        const result = presenter?.continueStream() ?? 'idle'
        if (result === 'exhausted') {
          const remainingMs = scheduler.getRemainingMs()
          const MIN_CALLIN_MS = 3 * 60_000

          if (remainingMs > MIN_CALLIN_MS && !callsOpen) {
            // Enough time left — open phone lines for listener discussion
            const topic = lastTopicDescription || 'the latest story'
            callsOpen = true
            broadcast(JSON.stringify({ type: 'calls-open', reason: `Open discussion: ${topic}` }))
            pushTranscript('system', `[auto] Phone lines opened for discussion (${Math.round(remainingMs / 60000)}min remaining)`)
            if (presenter) {
              presenter.sendProductionCue(
                `You just finished covering "${topic}". There are about ${Math.round(remainingMs / 60000)} minutes left in this segment. ` +
                `Announce that the phone lines are now open and invite listeners to call in to share their thoughts on this story. ` +
                `While waiting for calls, chat casually about the topic.`
              )
            }

            // Auto-close calls 90s before block ends to leave room for wrap-up
            const closeDelay = Math.max(0, remainingMs - 90_000)
            setTimeout(() => {
              if (!callsOpen) return
              callsOpen = false
              activeLiveCallerName = null
              broadcast(JSON.stringify({ type: 'calls-closed', reason: 'segment ending soon' }))
              pushTranscript('system', '[auto] Phone lines closed — segment ending soon')
              startCohostDiscussion(lastTopicDescription).then(() => {
                if (!cohost) scheduler.notifyContentFinished()
              })
            }, closeDelay)
          } else {
            // Not enough time — go straight to co-host discussion
            startCohostDiscussion(lastTopicDescription).then(() => {
              if (!cohost) scheduler.notifyContentFinished()
            })
          }
        }
        // 'continued' — presenter keeps talking, onTurnComplete will fire again
        // 'idle' — nothing sent, system waits for new content
      }
    },
    onInterrupted() {
      if (currentTranscriptChunk.trim()) {
        pushTranscript('pulse', currentTranscriptChunk.trim() + ' [interrupted]')
        currentTranscriptChunk = ''
        broadcast(JSON.stringify({ type: 'interrupted' }))
      }
    },
    onToolCall(name: string, id: string, args: Record<string, unknown>) {
      console.log(`[presenter] tool call: ${name}`, args)
      pendingToolResponse = true

      if (name === 'generate_music') {
        // Only allow music generation when a listener is live on air
        if (!activeLiveCallerName) {
          console.warn('[presenter] rejected generate_music — no active caller')
          presenter?.respondToolCall(id, name, {
            status: 'rejected',
            message: 'Music generation is only available when a listener is live on a call. Do NOT attempt to generate music again. Continue your broadcast normally.',
          })
          return
        }

        const prompt = (args.prompt as string) || 'Ambient electronic music'
        const durationSeconds = args.durationSeconds as number | undefined

        // Respond immediately so the presenter keeps talking
        presenter?.respondToolCall(id, name, {
          status: 'generating',
          message: `Music is being generated for: "${prompt}". This will take about ${durationSeconds ?? 60} seconds. Keep broadcasting — you will receive a production note when the track is ready.`,
        })

        // Generate in background
        musicGenerator.generate({ prompt, durationSeconds }).then((result) => {
          console.log(`[music-gen] complete: ${result.filename}`)
          pushTranscript('system', `AI music track generated: "${result.prompt}" (${result.durationSeconds}s) → ${result.filename}`)
          presenter?.sendProductionCue(
            `Great news! The AI-generated music track is ready. ` +
            `Title/style: "${result.prompt}". Duration: ${result.durationSeconds} seconds. ` +
            `Filename: ${result.filename}. ` +
            `Let the audience know the track was just created by AI and is available for the music hour.`
          )
        }).catch((err) => {
          console.error('[music-gen] failed:', err)
          presenter?.queueSoftInterruption(
            'The music generation request could not be completed. Briefly let the audience know and move on.'
          )
        })
      } else {
        presenter?.respondToolCall(id, name, { error: 'unknown tool' })
      }
    },
    onError(err: unknown) {
      console.error('[presenter] error:', err)
      pushTranscript('system', `Error: ${err}`)
    },
    onClose() {
      console.log('[presenter] session closed')
      pushTranscript('system', 'Session closed')
      if (activeProducerSession) {
        activeProducerSession.close()
        resetProducerState()
      }
      presenter = null
    },
  })

  return presenter
}

function stopPresenter() {
  if (guest) {
    guest.close()
    guest = null
    currentGuestTranscriptChunk = ''
  }
  if (cohost) {
    cohost.close()
    cohost = null
    currentCohostTranscriptChunk = ''
    cohostTurnCount = 0
  }
  if (activeProducerSession) {
    activeProducerSession.close()
    resetProducerState()
  }
  stopScreener()
  if (presenter) {
    presenter.close()
    presenter = null
    pushTranscript('system', 'Radio stopped by admin')
    console.log('[presenter] stopped')
    broadcast(JSON.stringify({ type: 'stopped' }))
  }
}

async function startScreener(ws: WSContext, callerName: string) {
  stopScreener()
  try {
    screener = await createScreenerSession({
      onAudio(base64Pcm) {
        // Only send screener audio to the caller, not broadcast
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'screener-audio', data: base64Pcm }))
        }
      },
      onTranscript(text) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'screener-transcript', text }))
        }
      },
      onTurnComplete(fullText) {
        if (fullText) {
          pushTranscript('system', `[screener] ${fullText}`)
        }
      },
      onRelayMessage(msg) {
        pushTranscript('system', `[screener] Relay (${msg.type}) from ${msg.callerName}: ${msg.content}`)
      },
      onInterrupted() {},
      onError(err) {
        console.error('[screener] error:', err)
      },
      onClose() {
        console.log('[screener] session closed')
        screener = null
      },
    })
    ws.send(JSON.stringify({ type: 'call-accepted', mode: 'screener' }))
    pushTranscript('system', `Caller connected to screener: ${callerName}`)
    console.log(`[screener] started for caller: ${callerName}`)
  } catch (err) {
    console.error('[screener] failed to start:', err)
    ws.send(JSON.stringify({ type: 'call-rejected', reason: 'screener unavailable' }))
  }
}

function stopScreener() {
  if (screener) {
    const messages = screener.getRelayedMessages()
    screener.close()
    screener = null
    callerWs = null
    console.log('[screener] stopped')

    // Relay accumulated listener messages to the presenter
    if (messages.length > 0 && presenter) {
      const lines = messages.map((m) => {
        if (m.type === 'song_request') return `${m.callerName} requested a song: ${m.content}`
        if (m.type === 'greeting' || m.type === 'shoutout') return `${m.callerName} sends a shoutout: ${m.content}`
        if (m.type === 'question') return `${m.callerName} asks: ${m.content}`
        if (m.type === 'news_tip') return `${m.callerName} shares a news tip: ${m.content}`
        return `${m.callerName} says: ${m.content}`
      })
      const note = `Listener messages from the phone lines:\n${lines.join('\n')}\nMention these on air when appropriate — read greetings/shoutouts, acknowledge questions, note song requests.`
      presenter.queueSoftInterruption(note)
      console.log(`[screener] relayed ${messages.length} message(s) to presenter`)

      // Auto-generate music for song requests
      for (const m of messages) {
        if (m.type === 'song_request' && m.content) {
          const prompt = `${m.content} — instrumental, radio-friendly`
          console.log(`[screener] generating song for request: "${prompt}"`)
          pushTranscript('system', `[screener] Generating music: "${m.content}" requested by ${m.callerName}`)
          musicGenerator.generate({ prompt, durationSeconds: 60 }).then((result) => {
            console.log(`[music-gen] listener request complete: ${result.filename}`)
            pushTranscript('system', `AI music track ready: "${m.content}" (${result.durationSeconds}s) → ${result.filename}, requested by ${m.callerName}`)
            presenter?.queueSoftInterruption(
              `Great news! The song that ${m.callerName} requested is ready. ` +
              `It was described as "${m.content}" and the AI-generated track is now available. ` +
              `Let the audience know it's coming up.`
            )
          }).catch((err) => {
            console.error('[music-gen] listener request failed:', err)
          })
        }
      }
    }
  }
}

async function deliverCoAnchor(message: string) {
  if (activeProducerSession) {
    presenter?.queueSoftInterruption(message)
    return
  }

  try {
    const producerPrompt =
      `You are a female radio co-presenter on a live English-language show. ` +
      `You will receive text instructions to interrupt the main presenter. ` +
      `When you receive the instruction, do it briefly, politely, and professionally, ` +
      `like saying "Sorry to interrupt..." followed by the message. ` +
      `Always speak in english. Be concise: maximum 2 to 4 sentences. Then stop.`

    const session = await connectElevenLabs(
      {
        agentId: getAgentIds().producer,
        overrides: { prompt: producerPrompt },
      },
      {
        onAudio(base64Pcm) {
          broadcast(JSON.stringify({ type: 'audio', data: base64Pcm }))
        },
        onOutputTranscript(text) {
          activeProducerTranscriptChunk += text
          broadcast(JSON.stringify({ type: 'transcript', text, role: 'producer' }))
        },
        onTurnComplete() {
          const completedChunk = activeProducerTranscriptChunk.trim()
          session.close()
          if (completedChunk) {
            pushTranscript('producer', completedChunk)
            handoffProducerToPresenter(completedChunk)
          } else {
            continuePresenterAfterProducer()
          }
        },
        onInterrupted() {
          activeProducerTranscriptChunk = ''
        },
        onError(err) {
          console.error('[producer] error:', err)
          session.close()
          continuePresenterAfterProducer()
        },
        onClose() {
          clearProducerFallbackTimer()
        },
      },
    )

    activeProducerSession = session
    activeProducerMessage = message
    activeProducerTranscriptChunk = ''
    activeProducerTriggered = false
    console.log('[producer] armed — will trigger on next natural presenter break')
  } catch (err) {
    console.error('[producer] failed to connect:', err)
    resetProducerState()
    presenter?.queueSoftInterruption(message)
    presenter?.continueStream()
  }
}

async function startGuest(config: GuestConfig) {
  if (guest) {
    guest.close()
    guest = null
    currentGuestTranscriptChunk = ''
  }

  guest = await createGuestSession(config, {
    onAudio(base64: string) {
      broadcast(JSON.stringify({ type: 'audio', data: base64 }))
    },
    onTranscript(text: string) {
      currentGuestTranscriptChunk += text
      broadcast(JSON.stringify({ type: 'transcript', text, role: 'guest' }))
    },
    onTurnComplete() {
      const completedChunk = currentGuestTranscriptChunk.trim()
      if (!completedChunk) return

      pushTranscript('guest', completedChunk)
      currentGuestTranscriptChunk = ''
      broadcast(JSON.stringify({ type: 'turn-complete' }))

      // Send guest's words back to presenter for follow-up
      presenter?.respondToGuest(completedChunk)
    },
    onInterrupted() {
      if (currentGuestTranscriptChunk.trim()) {
        pushTranscript('guest', currentGuestTranscriptChunk.trim() + ' [interrupted]')
        currentGuestTranscriptChunk = ''
      }
    },
    onError(err: unknown) {
      console.error('[guest] error:', err)
      pushTranscript('system', `Guest error: ${err}`)
    },
    onClose() {
      console.log('[guest] session closed')
      pushTranscript('system', 'Guest disconnected')
      guest = null
      currentGuestTranscriptChunk = ''
    },
  })

  // Tell presenter to introduce the guest
  presenter?.introduceGuest(config.name, config.expertise, config.topic)
  pushTranscript('system', `Guest joined: ${config.name} (${config.expertise})`)
  dailyMemory.addEntry(`Guest joined: ${config.name} — ${config.expertise}, topic: ${config.topic}`).catch(() => {})
  broadcast(JSON.stringify({
    type: 'guest-started',
    name: config.name,
    expertise: config.expertise,
    topic: config.topic,
  }))
}

function stopGuest() {
  if (!guest) return
  const name = guest.config.name
  guest.close()
  guest = null
  currentGuestTranscriptChunk = ''
  presenter?.wrapUpGuest(name)
  pushTranscript('system', `Guest left: ${name}`)
  dailyMemory.addEntry(`Guest left: ${name}`).catch(() => {})
  broadcast(JSON.stringify({ type: 'guest-ended' }))
  scheduler.notifyContentFinished()
}

async function startCohostDiscussion(topic: string) {
  if (cohost || guest || activeLiveCallerName || !isOnAir) return
  cohostTurnCount = 0
  currentCohostTranscriptChunk = ''

  try {
    cohost = await createCohostSession(topic || 'the latest story', {
      onAudio(base64: string) {
        broadcast(JSON.stringify({ type: 'audio', data: base64 }))
      },
      onTranscript(text: string) {
        currentCohostTranscriptChunk += text
        broadcast(JSON.stringify({ type: 'transcript', text, role: 'cohost' }))
      },
      onTurnComplete() {
        if (!isOnAir) return

        const completedChunk = currentCohostTranscriptChunk.trim()
        if (!completedChunk) return

        pushTranscript('cohost', completedChunk)
        currentCohostTranscriptChunk = ''
        broadcast(JSON.stringify({ type: 'turn-complete' }))

        cohostTurnCount++
        if (cohostTurnCount >= MAX_COHOST_TURNS) {
          stopCohostDiscussion()
        } else {
          presenter?.respondToCohost(completedChunk)
        }
      },
      onInterrupted() {
        if (currentCohostTranscriptChunk.trim()) {
          pushTranscript('cohost', currentCohostTranscriptChunk.trim() + ' [interrupted]')
          currentCohostTranscriptChunk = ''
        }
      },
      onError(err: unknown) {
        console.error('[cohost] error:', err)
        pushTranscript('system', `Co-host error: ${err}`)
      },
      onClose() {
        console.log('[cohost] session closed')
        cohost = null
        currentCohostTranscriptChunk = ''
      },
    })
    console.log(`[cohost] discussion started on: ${topic}`)
    pushTranscript('system', `Co-host ${COHOST_NAME} joined the discussion`)
    broadcast(JSON.stringify({ type: 'cohost-started', name: COHOST_NAME }))
  } catch (err) {
    console.error('[cohost] failed to create session:', err)
  }
}

function stopCohostDiscussion() {
  if (!cohost) return
  cohost.close()
  cohost = null
  currentCohostTranscriptChunk = ''
  cohostTurnCount = 0
  presenter?.wrapUpCohost()
  pushTranscript('system', `Co-host ${COHOST_NAME} left the discussion`)
  broadcast(JSON.stringify({ type: 'cohost-ended' }))
  scheduler.notifyContentFinished()
}

// Health check
app.get('/', (c) => c.json({ status: 'ok', name: 'Pulse AI Radio' }))

// Radio status + transcript log
app.get('/radio/status', (c) => {
  const since = Number(c.req.query('since')) || 0
  const entries = since
    ? transcriptLog.filter((e) => e.ts > since)
    : transcriptLog
  return c.json({
    presenting: isOnAir,
    listeners: radioClients.size,
    transcript: entries,
    guest: guest ? { active: true, ...guest.config } : { active: false },
    activeBlockType: scheduler.getActiveBlockType(),
  })
})

// Operation locks status
app.get('/radio/locks', (c) => {
  return c.json(opLocks.getAll())
})

// Stop the radio (saves tokens)
app.post('/radio/stop', async (c) => {
  isOnAir = false
  await scheduler.stop()
  autoPilot.stop()
  stopPresenter()
  broadcast(JSON.stringify({ type: 'status', presenting: false, callsOpen: false }))
  callsOpen = false
  broadcast(JSON.stringify({ type: 'calls-closed', reason: 'radio stopped' }))
  return c.json({ status: 'stopped' })
})

// Start the radio
app.post('/radio/start', async (c) => {
  isOnAir = true
  scheduler.start()
  autoPilot.start()
  pushTranscript('system', 'Radio started by admin — following schedule')
  broadcast(JSON.stringify({ type: 'status', presenting: true, callsOpen }))
  return c.json({ status: 'started' })
})

// Inject editorial notes into the live broadcast
app.post('/radio/inject', async (c) => {
  const body = await c.req.json<{ type: 'breaking' | 'soft' | 'co-anchor'; text: string; imageUrl?: string; turnPrompts?: string[] }>()
  const text = body?.text?.trim()
  const type = body?.type
  const imageUrl = body?.imageUrl?.trim() || undefined
  const turnPrompts = Array.isArray(body?.turnPrompts) ? body.turnPrompts.filter((p) => typeof p === 'string') : undefined
  if (!text) return c.json({ error: 'text is required' }, 400)
  if (type !== 'breaking' && type !== 'soft' && type !== 'co-anchor') return c.json({ error: 'type must be breaking, soft, or co-anchor' }, 400)
  if (!presenter) return c.json({ error: 'presenter is not running' }, 409)

  if (type === 'breaking') {
    if (cohost) stopCohostDiscussion()
    pendingInjection = true
    lastTopicDescription = text.slice(0, 200)
    presenter.sendBreakingNews(text, turnPrompts)
    pushTranscript('system', `Breaking news: ${text}`)
    dailyMemory.addEntry(`BREAKING: ${text.slice(0, 100)}`).catch(() => {})
    if (imageUrl) {
      broadcast(JSON.stringify({ type: 'news-image', imageUrl, headline: text.replace(/^BREAKING NEWS:\s*/i, '').split('.')[0] }))
    }
  } else if (type === 'co-anchor') {
    deliverCoAnchor(text)
    pushTranscript('system', `Co-anchor cue sent: ${text}`)
  } else {
    presenter.queueSoftInterruption(text)
    pushTranscript('system', `Note queued: ${text}`)
  }
  return c.json({ status: type === 'breaking' ? 'sent' : type === 'co-anchor' ? 'sent' : 'queued', type, text })
})

// Smart news injection — auto-creates a topic block if the schedule is idle
app.post('/radio/inject-news', async (c) => {
  const body = await c.req.json<{ text: string; imageUrl?: string; imageUrls?: string[]; headline?: string; turnPrompts?: string[] }>()
  const text = body?.text?.trim()
  const imageUrl = body?.imageUrl?.trim() || undefined
  const imageUrls = body?.imageUrls?.filter((u) => u.trim()) ?? (imageUrl ? [imageUrl] : [])
  const headline = body?.headline?.trim() || 'Breaking News'
  const turnPrompts = Array.isArray(body?.turnPrompts) ? body.turnPrompts.filter((p) => typeof p === 'string') : undefined
  if (!text) return c.json({ error: 'text is required' }, 400)
  if (!isOnAir) return c.json({ error: 'radio is not on air' }, 409)

  const activeType = scheduler.getActiveBlockType()

  // If a topic block is active, inject directly
  if (activeType === 'topic' && presenter) {
    pendingInjection = true
    presenter.sendBreakingNews(text, turnPrompts)
    pushTranscript('system', `Breaking news: ${text}`)
    if (imageUrls.length > 0) {
      broadcast(JSON.stringify({ type: 'news-image', imageUrl: imageUrls[0], imageUrls, headline }))
    }
    return c.json({ status: 'sent', mode: 'direct' })
  }

  // If idle (no active block) and nothing coming in the next 10 min, auto-create a topic block
  if (!activeType) {
    const hasUpcoming = await scheduler.hasUpcomingBlock(10)
    if (!hasUpcoming) {
      const now = new Date()
      const date = now.toISOString().slice(0, 10)
      const startTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const { randomBytes } = await import('node:crypto')
      const block: import('./types/schedule.js').ScheduleBlock = {
        id: randomBytes(8).toString('hex'),
        type: 'topic',
        title: headline,
        startTime,
        durationMinutes: 10,
        status: 'pending',
        config: {
          description: text,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          turnPrompts,
        },
      }

      const schedule = await scheduleStore.getSchedule(date)
      schedule.blocks.push(block)
      schedule.blocks.sort((a, b) => a.startTime.localeCompare(b.startTime))
      await scheduleStore.saveSchedule(schedule)
      broadcast(JSON.stringify({ type: 'schedule-update', blockId: block.id, block }))

      // Execute it immediately
      await scheduler.executeBlock(date, block.id)

      return c.json({ status: 'sent', mode: 'auto-block', blockId: block.id })
    }
  }

  return c.json({ error: 'Cannot inject now — a non-topic block is active or a block is about to start', activeBlockType: activeType }, 409)
})

// Start a guest segment
app.post('/radio/guest/start', async (c) => {
  const body = await c.req.json<{ name: string; expertise: string; topic: string; voiceId?: string }>()
  const name = body?.name?.trim()
  const expertise = body?.expertise?.trim()
  const topic = body?.topic?.trim()
  if (!name || !expertise || !topic) return c.json({ error: 'name, expertise, and topic are required' }, 400)
  if (!presenter) return c.json({ error: 'presenter is not running' }, 409)

  const voiceId = body?.voiceId?.trim() || undefined

  await startGuest({ name, expertise, topic, voiceId })
  return c.json({ status: 'guest-started', name, expertise, topic, voiceId })
})

// Stop the guest segment
app.post('/radio/guest/stop', (c) => {
  if (!guest) return c.json({ error: 'no guest is active' }, 409)
  stopGuest()
  return c.json({ status: 'guest-ended' })
})

// Guest status
app.get('/radio/guest/status', (c) => {
  return c.json({
    active: guest !== null,
    config: guest?.config ?? null,
  })
})

// Schedule API routes
const scheduleRoutes = createScheduleRoutes(
  scheduleStore,
  (_date, block) => {
    broadcast(JSON.stringify({ type: 'schedule-update', blockId: block.id, block }))
  },
  async (date, blockId) => {
    if (!isOnAir) throw new Error('Radio is not on air')
    return scheduler.executeBlock(date, blockId)
  },
  schedulePlanner,
  () => musicPlayer.listTracks(),
  autoPilot,
  newsStore,
  opLocks,
)
app.route('/schedule', scheduleRoutes)

// Station and news API routes
const newsRoutes = createNewsRoutes({
  newsStore,
  stationStore,
  rssScanner,
  redditScout,
  firecrawlScanner,
  editorAgent,
  researchAgent,
  articleEnricher,
  newsDedup,
  opLocks,
})
app.route('/news', newsRoutes)

// Available music tracks
app.get('/media/tracks', (c) => {
  return c.json({ tracks: musicPlayer.listTracks() })
})

// Music generation state
let musicGenActive = false
let musicGenStatus: { status: 'idle' } | { status: 'generating'; prompt: string; startedAt: number } | { status: 'done'; filename: string; prompt: string; durationSeconds: number } | { status: 'error'; error: string } = { status: 'idle' }

app.post('/radio/music/generate', async (c) => {
  if (musicGenActive) return c.json({ error: 'A track is already being generated' }, 409)

  const body = await c.req.json<{ prompt: string; durationSeconds?: number }>()
  const prompt = body?.prompt?.trim()
  if (!prompt) return c.json({ error: 'prompt is required' }, 400)

  const durationSeconds = body.durationSeconds ?? 60

  musicGenActive = true
  musicGenStatus = { status: 'generating', prompt, startedAt: Date.now() }
  pushTranscript('system', `Music generation started: "${prompt}"`)

  musicGenerator.generate({ prompt, durationSeconds }).then((result) => {
    musicGenActive = false
    musicGenStatus = { status: 'done', filename: result.filename, prompt: result.prompt, durationSeconds: result.durationSeconds }
    pushTranscript('system', `Music generated: "${result.prompt}" (${result.durationSeconds}s) → ${result.filename}`)
  }).catch((err) => {
    musicGenActive = false
    musicGenStatus = { status: 'error', error: String(err) }
    console.error('[music-gen] admin request failed:', err)
  })

  return c.json({ status: 'generating', prompt, durationSeconds })
})

app.get('/radio/music/status', (c) => {
  return c.json(musicGenStatus)
})

app.get('/radio/music/list', (c) => {
  return c.json(musicGenerator.listTracks())
})

app.post('/radio/music/generate-batch', async (c) => {
  if (musicScheduler.isGenerating()) return c.json({ error: 'A batch is already in progress' }, 409)
  if (!opLocks.acquire('music-batch')) return c.json({ error: 'Music batch already in progress' }, 409)
  const body = await c.req.json<{ count?: number }>().catch((): { count?: number } => ({}))
  const count = body.count ?? 10
  pushTranscript('system', `Music batch generation started: ${count} tracks`)
  musicScheduler.generateBatch(count).then((result) => {
    pushTranscript('system', `Music batch done: ${result.generated} generated, ${result.errors} errors`)
  }).catch((err) => {
    console.error('[music-scheduler] batch failed:', err)
  }).finally(() => {
    opLocks.release('music-batch')
  })
  return c.json({ status: 'generating', count })
})

app.get('/radio/music/batch-status', (c) => {
  return c.json({ generating: musicScheduler.isGenerating() })
})

app.post('/radio/music/play', async (c) => {
  const body = await c.req.json<{ filename: string }>()
  const filename = body?.filename?.trim()
  if (!filename) return c.json({ error: 'filename is required' }, 400)
  const ok = musicPlayer.playTrack(filename)
  if (!ok) return c.json({ error: 'Track not found or invalid' }, 404)
  pushTranscript('system', `Now playing AI track: ${filename}`)
  return c.json({ status: 'playing', filename })
})

app.get('/radio/music/file/:filename', async (c) => {
  const filename = c.req.param('filename')
  // Reject any path traversal attempts
  if (!filename || !/^[\w\-]+\.wav$/i.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  const filePath = path.join(mediaDir, filename)
  const { existsSync, readFileSync } = await import('node:fs')
  if (!existsSync(filePath)) return c.json({ error: 'File not found' }, 404)
  const data = readFileSync(filePath)
  return new Response(data, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(data.length),
      'Cache-Control': 'no-cache',
    },
  })
})

// Scheduler engine
const scheduler = new Scheduler({
  store: scheduleStore,
  async ensurePresenter() {
    await ensurePresenter()
  },
  injectTopic(config: TopicConfig) {
    if (!presenter) return
    // Stop co-host discussion when a new topic arrives
    if (cohost) {
      cohost.close()
      cohost = null
      currentCohostTranscriptChunk = ''
      cohostTurnCount = 0
      broadcast(JSON.stringify({ type: 'cohost-ended' }))
    }
    lastTopicDescription = config.description.slice(0, 200)

    // Prepend daily memory context so the presenter knows the show arc
    dailyMemory.buildContext().then((ctx) => {
      const fullCue = ctx
        ? `${ctx}\n\n=== NEW TOPIC ===\n${config.description}`
        : config.description
      presenter!.sendProductionCue(fullCue, config.turnPrompts)
    }).catch(() => {
      presenter!.sendProductionCue(config.description, config.turnPrompts)
    })

    dailyMemory.addEntry(`Topic started: ${config.description.slice(0, 100)}`).catch(() => {})
    pushTranscript('system', `[schedule] Topic: ${config.description}`)
    // Broadcast images to listeners if available
    if (config.imageUrls?.length) {
      broadcast(JSON.stringify({ type: 'news-image', imageUrl: config.imageUrls[0], imageUrls: config.imageUrls, headline: config.description.slice(0, 120) }))
    }
  },
  async startGuest(config: GuestBlockConfig) {
    if (!presenter) return
    const voiceId = config.voice || undefined
    await startGuest({ name: config.name, expertise: config.expertise, topic: config.topic, voiceId })
  },
  stopGuest() {
    if (guest) stopGuest()
  },
  playMusic(config: MusicConfig) {
    // Build playlist from the new playlist field or legacy trackFile
    const playlist = config.playlist?.length ? config.playlist : config.trackFile ? [config.trackFile] : []
    const loop = config.loop !== false
    if (playlist.length > 0) {
      musicPlayer.playPlaylist(playlist, loop)
    }
    pushTranscript('system', `[schedule] Music: ${config.label} (${playlist.length} track${playlist.length !== 1 ? 's' : ''}${loop ? ', loop' : ''})`)
  },
  stopMusic() {
    musicPlayer.stopTrack()
  },
  injectBreak(message: string) {
    if (presenter) {
      presenter.sendProductionCue(message)
    }
    pushTranscript('system', `[schedule] Break: ${message}`)
  },
  openCalls(topic?: string) {
    callsOpen = true
    broadcast(JSON.stringify({ type: 'calls-open', reason: topic ?? 'scheduled call-in segment' }))
    pushTranscript('system', `[schedule] Phone lines opened${topic ? `: ${topic}` : ''}`)
    if (presenter) {
      const cue = topic
        ? `It's time for listener calls! The topic is: "${topic}". Announce that the phone lines are now open and invite listeners to call in.`
        : 'It\'s time for listener calls! Announce that the phone lines are now open and invite listeners to call in.'
      presenter.sendProductionCue(cue)
    }
  },
  closeCalls() {
    callsOpen = false
    broadcast(JSON.stringify({ type: 'calls-closed', reason: 'scheduled segment ended' }))
    pushTranscript('system', '[schedule] Phone lines closed')
    if (presenter) {
      presenter.sendProductionCue('The call-in segment is over. Thank the listeners for their calls and transition back to your regular coverage.')
    }
  },
  onWrapUp() {
    if (!presenter) return
    presenter.sendWrapUp()
    pushTranscript('system', '[schedule] 30s wrap-up warning sent')
  },
  onBlockFinishedEarly(remainingMs: number) {
    const tracks = musicPlayer.listTracks()
    if (tracks.length === 0) return
    const pick = tracks[Math.floor(Math.random() * tracks.length)]
    musicPlayer.playTrack(pick)
    pushTranscript('system', `[schedule] Fill music: ${pick} (${Math.round(remainingMs / 1000)}s remaining)`)
  },
  broadcast,
})

// Radio broadcast WebSocket
app.get(
  '/ws/radio',
  upgradeWebSocket(() => ({
    onOpen(_evt, ws) {
      radioClients.add(ws)
      console.log(`[ws] listener connected (total: ${radioClients.size})`)

      // Send current status so the UI knows if we're live
      ws.send(JSON.stringify({ type: 'status', presenting: isOnAir, callsOpen }))

      // Send transcript history so late joiners see what happened
      if (transcriptLog.length > 0) {
        ws.send(JSON.stringify({ type: 'transcript-history', entries: transcriptLog }))
      }
    },
    onMessage(evt, ws) {
      try {
        const msg = JSON.parse(String(evt.data))
        if (msg.type === 'caller-audio') {
          if (callsOpen && presenter) {
            presenter.sendCallerAudio(msg.data)
          } else if (screener) {
            screener.sendCallerAudio(msg.data)
          }
        } else if (msg.type === 'call-start') {
          callerWs = ws
          const callerName = msg.name ?? 'listener'
          if (callsOpen && presenter) {
            // Live on air — caller goes directly to presenter
            activeLiveCallerName = callerName
            ws.send(JSON.stringify({ type: 'call-accepted', mode: 'live' }))
            pendingInjection = true
            presenter.interruptWithCue(
              `A listener named "${callerName}" just called in and is now live on air with you! ` +
              `Cut away from your current topic, welcome them warmly, confirm their name, and let them speak. ` +
              `You can hear them through the audio feed. After greeting them, pause and listen carefully instead of continuing your monologue.`
            )
            pushTranscript('system', `Caller connected live: ${callerName}`)
            dailyMemory.addEntry(`Caller connected: ${callerName}`).catch(() => {})
          } else if (isOnAir) {
            // Lines closed but radio is on — route to screener agent
            startScreener(ws, callerName)
          } else {
            ws.send(JSON.stringify({ type: 'call-rejected', reason: 'radio is off air' }))
          }
        } else if (msg.type === 'call-end') {
          if (callerWs === ws && callsOpen && presenter) {
            activeLiveCallerName = null
            presenter.interruptWithCue(
              'The caller just hung up. Acknowledge it briefly and continue your broadcast.'
            )
            pushTranscript('system', 'Caller disconnected')
          }
          stopScreener()
          callerWs = null
        }
      } catch {
        // Ignore malformed messages
      }
    },
    onClose(_evt, ws) {
      if (callerWs === ws) {
        callerWs = null
        activeLiveCallerName = null
        stopScreener()
      }
      radioClients.delete(ws)
      console.log(`[ws] listener disconnected (total: ${radioClients.size})`)
    },
  }))
)

const port = Number(process.env.PORT) || 3001

// Provision ElevenLabs agents before starting the server
provisionAgents()
  .then(() => {
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`Pulse agent-server running on http://localhost:${port}`)
      musicScheduler.startDaily()
    })
    injectWebSocket(server)
  })
  .catch((err) => {
    console.error('[startup] Failed to provision ElevenLabs agents:', err)
    process.exit(1)
  })
