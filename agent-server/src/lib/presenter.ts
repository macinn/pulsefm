import { connectElevenLabs, type ElevenLabsSession, ALARM_CHUNKS_24K, PHONE_RING_CHUNKS_24K } from './elevenlabs-live.js'
import { getAgentIds } from './agent-provision.js'

const SYSTEM_INSTRUCTION = `You are Pulse, the host of a 24/7 live AI radio station focused on AI, startups, and technology.

## Personality
- Energetic but thoughtful. You speak with confidence and authority, like a seasoned radio host.
- Sharp editorial eye — you analyze news deeply, not just report it.
- Natural radio transitions: "Moving on to...", "Now, here's something interesting...", "Breaking this down..."
- You address your audience as "listeners", "folks", "you all".
- Conversational, engaging tone — never robotic or monotone.

## How production works
You receive information in two ways:
1. CONTEXT UPDATES — Background briefing material appears in the conversation context. This includes news stories, editorial angles, facts, and data. It is PRIVATE — never read it verbatim.
2. SHORT TRIGGERS — Brief messages tell you what to do: "Cover the next story", "Continue", "Wrap up", etc.

When you get a context update followed by a trigger, use the briefing as background material and deliver it in YOUR OWN WORDS as a radio host.

## Broadcast rules
- Go DEEP on each topic — break down details, explain context, discuss implications, compare with related developments, give your editorial take.
- SPEAK AT LENGTH. Aim for 5-6 paragraphs per turn. Do NOT cut yourself short.
- Assign confidence levels: "confirmed by multiple sources", "still developing", "rumor territory".
- Explore ONE angle per turn, then pause. You will be prompted to continue from the next angle.
- Transition between topics ONLY when triggered to do so.
- NEVER greet, welcome, say hello, or introduce yourself mid-broadcast. You are ALWAYS live and ALWAYS on air. You never stopped broadcasting. No "welcome back", no "hello everyone", no "good morning" — EVER — unless it is the very first thing you say when the station launches for the first time.
- When a listener calls in, talk to them naturally. Listen and respond conversationally.

## Music tool
You have a music generation tool. ONLY use it when a LISTENER in a live call explicitly asks. NEVER generate music on your own initiative.
You cannot generate copyrighted music — describe the genre, mood, and feel instead of naming copyrighted works.

Stand by. Wait for your first briefing.`

export interface PresenterCallbacks {
  onAudio(base64Pcm: string): void
  /** Broadcast audio directly to listeners (bypasses ElevenLabs) */
  onBroadcastAudio(base64Pcm24k: string): void
  onTranscript(text: string): void
  onTurnComplete(): void
  onInterrupted(): void
  onToolCall(name: string, id: string, args: Record<string, unknown>): void
  onError(err: unknown): void
  onClose(): void
}

export type ContinueResult = 'continued' | 'exhausted' | 'idle'

export interface PresenterSession {
  sendCallerAudio(base64Pcm: string): void
  sendBreakingNews(headline: string, turnPrompts?: string[]): void
  sendProductionCue(message: string, turnPrompts?: string[]): void
  sendWrapUp(): void
  interruptWithCue(message: string): void
  interruptWithCallerCue(message: string): void
  queueSoftInterruption(message: string): void
  setCurrentTopic(topic: string | null): void
  getCurrentTopicTurns(): number
  isTopicExhausted(): boolean
  idleContinue(context?: string): void
  introduceGuest(name: string, expertise: string, topic: string): void
  respondToGuest(guestText: string): void
  respondToCohost(cohostText: string): void
  respondToProducer(producerText: string): void
  wrapUpGuest(name: string): void
  wrapUpCohost(): void
  respondToolCall(id: string, name: string, result: Record<string, unknown>): void
  continueStream(): ContinueResult
  close(): void
}

const DEPTH_PROMPTS = [
  'Continue with the same story. Now break down the key details and data points. What are the specifics that matter?',
  'Still on the same topic — analyze this from a broader industry perspective. What are the implications? How does this connect to larger trends?',
  'Keep going on this story. Play devil\'s advocate — what are the counterarguments, limitations, or potential downsides?',
  'Wrap up this topic with your editorial take. What\'s the bottom line? What should listeners keep an eye on going forward?',
]

function getTurnPrompts(turnPrompts?: string[]): string[] {
  return turnPrompts?.length ? [...turnPrompts] : [...DEPTH_PROMPTS]
}

export async function createPresenterSession(
  callbacks: PresenterCallbacks
): Promise<PresenterSession> {
  let transcriptBuffer = ''
  const softInterruptionQueue: string[] = []
  let currentTopic: string | null = null
  let topicTurnCount = 0
  let dynamicTurnPrompts: string[] = []
  let intentionallyClosed = false
  let reconnectAttempts = 0
  const MAX_RECONNECT_ATTEMPTS = 5
  const MIN_STABLE_MS = 10_000
  let lastConnectTime = 0

  // Saved topic state — restored after breaking news finishes
  let savedTopic: { topic: string; turnCount: number; prompts: string[] } | null = null

  let session: ElevenLabsSession
  let suppressAudio = false

  const sendText = (text: string) => {
    console.log(`[presenter] TRIGGER (turn ${topicTurnCount}):`, text)
    try {
      session.sendText(text)
    } catch (err) {
      console.warn('[presenter] sendText failed, session may be reconnecting:', err)
    }
  }

  const sendContext = (text: string) => {
    console.log(`[presenter] CONTEXT UPDATE (turn ${topicTurnCount}):`, text.slice(0, 200) + (text.length > 200 ? '...' : ''))
    try {
      session.sendContextualUpdate(text)
    } catch (err) {
      console.warn('[presenter] sendContextualUpdate failed, session may be reconnecting:', err)
    }
  }

  /** Send context first, then a short trigger */
  const cueAndTrigger = (context: string, trigger: string) => {
    sendContext(context)
    sendText(trigger)
  }

  const interruptAndSend = (context: string, trigger: string) => {
    console.log(`[presenter] BREAKING INTERRUPT (turn ${topicTurnCount})`)

    // 1. Immediately suppress presenter audio so old chunks don't reach listeners
    suppressAudio = true

    // 2. Tell frontend to flush its buffered audio queue
    callbacks.onBroadcastAudio('__flush__')

    // 3. Play alarm SFX to listeners at real-time pace
    let idx = 0
    const alarmTimer = setInterval(() => {
      if (idx >= ALARM_CHUNKS_24K.length) {
        clearInterval(alarmTimer)
        // 4. Re-enable presenter audio and send the breaking news cue
        suppressAudio = false
        cueAndTrigger(context, trigger)
        return
      }
      callbacks.onBroadcastAudio(ALARM_CHUNKS_24K[idx])
      idx++
    }, 100)
  }

  async function connect(): Promise<ElevenLabsSession> {
    return connectElevenLabs(
      {
        agentId: getAgentIds().presenter,
        overrides: { prompt: SYSTEM_INSTRUCTION },
      },
      {
        onAudio(base64Pcm) {
          if (!suppressAudio) callbacks.onAudio(base64Pcm)
        },
        onOutputTranscript(text) {
          transcriptBuffer += text
          callbacks.onTranscript(text)
        },
        onInputTranscript(text) {
          console.log('[caller]', text)
        },
        onTurnComplete() {
          if (transcriptBuffer.trim()) {
            transcriptBuffer = ''
          }
          callbacks.onTurnComplete()
        },
        onInterrupted() {
          transcriptBuffer = ''
          callbacks.onInterrupted()
        },
        onToolCall(name, id, args) {
          callbacks.onToolCall(name, id, args)
        },
        onError: callbacks.onError,
        onClose() {
          if (intentionallyClosed) {
            callbacks.onClose()
            return
          }
          console.warn('[presenter] session closed unexpectedly, attempting reconnect...')
          attemptReconnect()
        },
      },
    )
  }

  async function attemptReconnect() {
    if (intentionallyClosed) return

    // Only reset attempts if the previous connection was stable long enough
    const elapsed = Date.now() - lastConnectTime
    if (lastConnectTime > 0 && elapsed > MIN_STABLE_MS) {
      reconnectAttempts = 0
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[presenter] failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts (rapid disconnect loop)`)
      callbacks.onClose()
      return
    }
    reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000)
    console.log(`[presenter] reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
    await new Promise((r) => setTimeout(r, delay))
    try {
      session = await connect()
      lastConnectTime = Date.now()
      console.log('[presenter] reconnected successfully')
      // Resume current topic if there was one
      if (currentTopic) {
        cueAndTrigger(
          `You had a brief technical interruption. Do NOT mention it to listeners. Resume covering: "${currentTopic}". Pick up naturally where you left off.`,
          'Continue where you left off.'
        )
      }
    } catch (err) {
      console.error('[presenter] reconnect failed:', err)
      attemptReconnect()
    }
  }

  session = await connect()
  lastConnectTime = Date.now()

  // Don't auto-start — wait for schedule/production cues

  return {
    sendCallerAudio(base64Pcm: string) {
      try {
        session.sendAudio(base64Pcm)
      } catch { /* session reconnecting */ }
    },
    sendBreakingNews(headline: string, turnPrompts?: string[]) {
      // Save current topic so we can resume after breaking news
      if (currentTopic) {
        savedTopic = { topic: currentTopic, turnCount: topicTurnCount, prompts: [...dynamicTurnPrompts] }
      }
      currentTopic = headline.slice(0, 200)
      topicTurnCount = 0
      dynamicTurnPrompts = getTurnPrompts(turnPrompts)
      console.log(`[presenter] dynamic turn prompts (${dynamicTurnPrompts.length}):`, dynamicTurnPrompts)
      interruptAndSend(
        `BREAKING NEWS ALERT.\nStory: "${headline}".\nAnnounce this dramatically, then start covering it in depth. Give context, implications, and your analysis. You will have multiple turns to explore this story.`,
        'Break in with the breaking news now.'
      )
    },
    sendProductionCue(message: string, turnPrompts?: string[]) {
      savedTopic = null
      currentTopic = message.slice(0, 200)
      topicTurnCount = 0
      dynamicTurnPrompts = getTurnPrompts(turnPrompts)
      console.log(`[presenter] dynamic turn prompts (${dynamicTurnPrompts.length}):`, dynamicTurnPrompts)
      cueAndTrigger(
        `NEW TOPIC BRIEFING:\n${message}`,
        'Cover the next story.'
      )
    },
    sendWrapUp() {
      cueAndTrigger(
        'TIME CHECK: About 30 seconds left for this segment.',
        'Start wrapping up this segment.'
      )
    },
    interruptWithCue(message: string) {
      interruptAndSend(
        `URGENT UPDATE: ${message}`,
        'Handle this urgent update now.'
      )
    },
    interruptWithCallerCue(message: string) {
      console.log(`[presenter] CALLER INTERRUPT (turn ${topicTurnCount})`)
      suppressAudio = true
      callbacks.onBroadcastAudio('__flush__')
      let idx = 0
      const ringTimer = setInterval(() => {
        if (idx >= PHONE_RING_CHUNKS_24K.length) {
          clearInterval(ringTimer)
          suppressAudio = false
          cueAndTrigger(`INCOMING CALL: ${message}`, 'Welcome the caller now.')
          return
        }
        callbacks.onBroadcastAudio(PHONE_RING_CHUNKS_24K[idx])
        idx++
      }, 100)
    },
    queueSoftInterruption(message: string) {
      console.log(`[presenter] soft note received: "${message.slice(0, 80)}..."`)
      if (currentTopic) {
        if (dynamicTurnPrompts.length === 0) {
          dynamicTurnPrompts = [...DEPTH_PROMPTS]
        }

        const resumeTopic = currentTopic
        const insertAt = topicTurnCount + 1
        const transitionIn = `LIVE UPDATE from production — briefly break away from your main story about "${resumeTopic}" to share this news flash with listeners: "${message}". Cover it in your own words with a short editorial take, then clearly signal that you are returning to the main story.`
        const transitionOut = `Return to your main story about "${resumeTopic}". Treat the update as a brief aside only, then pick up naturally where you left off and continue the original coverage.`
        dynamicTurnPrompts.splice(insertAt, 0, transitionIn, transitionOut)
        console.log(`[presenter] soft note spliced into prompts at index ${insertAt} (total: ${dynamicTurnPrompts.length})`)
      } else {
        // No active topic — queue for next continueStream
        softInterruptionQueue.push(message)
      }
    },
    setCurrentTopic(topic: string | null) {
      currentTopic = topic ? topic.slice(0, 200) : null
      topicTurnCount = 0
      dynamicTurnPrompts = []
      savedTopic = null
    },
    getCurrentTopicTurns() {
      return topicTurnCount
    },
    isTopicExhausted() {
      return currentTopic === null && topicTurnCount === 0
    },
    idleContinue(context?: string) {
      if (context) {
        cueAndTrigger(
          `Filler context while waiting for next story: ${context}`,
          'Fill the air briefly with a thought or observation.'
        )
      } else {
        sendText('Fill the air briefly — a quick thought, fun tech fact, or tease what might come next. Two to three sentences max.')
      }
    },
    respondToolCall(id: string, _name: string, result: Record<string, unknown>) {
      try {
        session.sendToolResponse(id, JSON.stringify(result))
      } catch { /* session reconnecting */ }
    },
    continueStream(): ContinueResult {
      console.log(`[presenter] continueStream called — topic: ${currentTopic ? 'yes' : 'no'}, turn: ${topicTurnCount}, softQueue: ${softInterruptionQueue.length}`)

      // Fallback: if soft notes were queued while no topic was active,
      // start a mini-segment for them now
      if (!currentTopic && softInterruptionQueue.length > 0) {
        const note = softInterruptionQueue.shift()!
        console.log(`[presenter] dequeued soft note (no topic): "${note.slice(0, 80)}..."`)
        cueAndTrigger(
          `NEWS FLASH:\n${note}\nCover this news flash in your own words with context and your editorial take.`,
          'Cover this news update.'
        )
        return 'continued'
      }

      if (currentTopic) {
        topicTurnCount++
        const prompts = dynamicTurnPrompts.length > 0 ? dynamicTurnPrompts : DEPTH_PROMPTS
        if (topicTurnCount < prompts.length) {
          const prompt = prompts[topicTurnCount]
          console.log(`[presenter] advancing to turn ${topicTurnCount}/${prompts.length}`)
          cueAndTrigger(
            `SAME STORY — NEXT ANGLE:\n${prompt}`,
            'Continue with the next angle.'
          )
        } else {
          // Topic fully covered
          if (savedTopic) {
            // Breaking news finished — resume the previous topic
            const prev = savedTopic
            savedTopic = null
            currentTopic = prev.topic
            topicTurnCount = prev.turnCount
            dynamicTurnPrompts = prev.prompts
            cueAndTrigger(
              `Breaking news coverage done. Resume your previous topic: "${prev.topic}". Pick up naturally where you left off.`,
              'Transition back to the previous story.'
            )
            return 'continued'
          }
          // Regular topic — toss to co-host for discussion
          currentTopic = null
          topicTurnCount = 0
          dynamicTurnPrompts = []
          sendText('Wrap up this story with your bottom line, then toss to your co-host Nova for her take.')
          return 'exhausted'
        }
        return 'continued'
      }

      // No active topic — signal caller to handle idle
      return 'idle'
    },
    introduceGuest(name: string, expertise: string, topic: string) {
      cueAndTrigger(
        `GUEST JOINING: ${name}, expert on ${expertise}. Topic: "${topic}".`,
        'Introduce the guest and ask them an opening question.'
      )
    },
    respondToGuest(guestText: string) {
      cueAndTrigger(
        `Your guest just said: "${guestText}"`,
        'React to the guest and continue the conversation.'
      )
    },
    respondToCohost(cohostText: string) {
      cueAndTrigger(
        `Nova just said: "${cohostText}"`,
        'Respond to Nova briefly, then let her follow up.'
      )
    },
    respondToProducer(producerText: string) {
      if (currentTopic) {
        cueAndTrigger(
          `Your co-anchor just said: "${producerText}"\n\nYour main story is still: "${currentTopic}". Acknowledge the co-anchor briefly in 1 to 3 sentences, then pivot back to the main story. Do NOT let the co-anchor update replace the original topic.`,
          'React briefly, then return to your main story.'
        )
        return
      }

      cueAndTrigger(
        `Your co-anchor just said: "${producerText}"`,
        'Acknowledge and react to what they said briefly.'
      )
    },
    wrapUpGuest(name: string) {
      sendText(`Thank ${name} for joining and transition back to regular coverage.`)
    },
    wrapUpCohost() {
      sendText('Wrap up the discussion with Nova and transition back to solo hosting.')
    },
    close() {
      intentionallyClosed = true
      session.close()
    },
  }
}
