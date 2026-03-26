import WebSocket from 'ws'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is required')

const WS_BASE = 'wss://api.elevenlabs.io/v1/convai/conversation'
const API_BASE = 'https://api.elevenlabs.io/v1'

export interface ElevenLabsCallbacks {
  onAudio(base64Pcm: string): void
  onInputTranscript?(text: string): void
  onOutputTranscript?(text: string): void
  onPartialText?(text: string): void
  onToolCall?(name: string, id: string, args: Record<string, unknown>): void
  onTurnComplete(): void
  onInterrupted(): void
  onError(err: unknown): void
  onClose(): void
}

export interface ElevenLabsSession {
  sendText(text: string): void
  sendContextualUpdate(text: string): void
  sendAudio(base64Pcm: string): void
  sendToolResponse(id: string, result: string, isError?: boolean): void
  close(): void
}

// Breaking news alarm SFX — two-tone siren (~1.5s) split into 100ms chunks for streaming.
// Generated at 16kHz for ElevenLabs input; also exported at 24kHz for listener broadcast.
const ALARM_CHUNK_DURATION_MS = 100
const ALARM_TOTAL_MS = 1500

function generateAlarmChunks(sampleRate: number): string[] {
  const samplesPerChunk = Math.floor(sampleRate * ALARM_CHUNK_DURATION_MS / 1000)
  const totalSamples = Math.floor(sampleRate * ALARM_TOTAL_MS / 1000)
  const chunks: string[] = []
  const amplitude = 20000

  for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
    const chunkSamples = Math.min(samplesPerChunk, totalSamples - offset)
    const buf = Buffer.alloc(chunkSamples * 2)
    for (let i = 0; i < chunkSamples; i++) {
      const t = (offset + i) / sampleRate
      // Cycle between two tones: 880Hz and 660Hz, switching every 250ms
      const cycle = Math.floor(t / 0.25) % 2
      const freq = cycle === 0 ? 880 : 660
      // Add slight urgency tremolo
      const tremolo = 1 - 0.3 * Math.sin(2 * Math.PI * 8 * t)
      const sample = Math.round(amplitude * tremolo * Math.sin(2 * Math.PI * freq * t))
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }
    chunks.push(buf.toString('base64'))
  }
  return chunks
}

// Pre-computed alarm chunks

/** Alarm SFX at 24kHz for broadcasting directly to listeners */
export const ALARM_CHUNKS_24K = generateAlarmChunks(24000)

// Phone ring SFX — classic double-ring pattern (~2s) for caller connections.
const RING_CHUNK_DURATION_MS = 100
const RING_TOTAL_MS = 2000

function generatePhoneRingChunks(sampleRate: number): string[] {
  const samplesPerChunk = Math.floor(sampleRate * RING_CHUNK_DURATION_MS / 1000)
  const totalSamples = Math.floor(sampleRate * RING_TOTAL_MS / 1000)
  const chunks: string[] = []
  const amplitude = 16000

  for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
    const chunkSamples = Math.min(samplesPerChunk, totalSamples - offset)
    const buf = Buffer.alloc(chunkSamples * 2)
    for (let i = 0; i < chunkSamples; i++) {
      const t = (offset + i) / sampleRate
      // Double-ring pattern: ring 0-0.4s, silence 0.4-0.6s, ring 0.6-1.0s, silence 1.0-2.0s
      const tMod = t % 2
      const isRinging = (tMod < 0.4) || (tMod >= 0.6 && tMod < 1.0)
      if (!isRinging) {
        buf.writeInt16LE(0, i * 2)
        continue
      }
      // Classic phone: two mixed frequencies (440Hz + 480Hz) with slight modulation
      const sig = Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)
      const envelope = 1 - 0.15 * Math.sin(2 * Math.PI * 20 * t)
      const sample = Math.round(amplitude * 0.5 * envelope * sig)
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }
    chunks.push(buf.toString('base64'))
  }
  return chunks
}

/** Phone ring SFX at 24kHz for caller connection broadcast */
export const PHONE_RING_CHUNKS_24K = generatePhoneRingChunks(24000)

export interface ElevenLabsConnectOptions {
  agentId: string
  overrides?: {
    prompt?: string
    firstMessage?: string
    voiceId?: string
    language?: string
  }
  dynamicVariables?: Record<string, string | number | boolean>
}

interface ConversationInitMetadata {
  conversation_initiation_metadata_event: {
    conversation_id: string
    agent_output_audio_format: string
    user_input_audio_format: string
  }
}

async function getSignedUrl(agentId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/convai/conversation/get-signed-url?agent_id=${agentId}`, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY! },
  })
  if (!res.ok) throw new Error(`Failed to get signed URL: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { signed_url: string }
  return data.signed_url
}

export async function connectElevenLabs(
  options: ElevenLabsConnectOptions,
  callbacks: ElevenLabsCallbacks,
): Promise<ElevenLabsSession> {
  const signedUrl = await getSignedUrl(options.agentId)

  return new Promise<ElevenLabsSession>((resolve, reject) => {
    const ws = new WebSocket(signedUrl, ['convai'])
    let resolved = false
    let closed = false
    let pingInterval: ReturnType<typeof setInterval> | null = null

    // Track mode to detect turn completion (speaking → listening)
    let currentMode: 'speaking' | 'listening' = 'listening'

    ws.on('open', () => {
      console.log('[elevenlabs] websocket connected')

      // Send conversation_initiation_client_data with overrides
      const initData: Record<string, unknown> = {
        type: 'conversation_initiation_client_data',
      }

      const overrides: Record<string, unknown> = {}
      if (options.overrides?.prompt || options.overrides?.firstMessage || options.overrides?.language) {
        overrides.agent = {
          prompt: options.overrides.prompt ? { prompt: options.overrides.prompt } : undefined,
          first_message: options.overrides.firstMessage,
          language: options.overrides.language,
        }
      }
      if (options.overrides?.voiceId) {
        overrides.tts = { voice_id: options.overrides.voiceId }
        console.log('[elevenlabs] voice_id override:', options.overrides.voiceId)
      }
      if (Object.keys(overrides).length > 0) {
        initData.conversation_config_override = overrides
      }
      if (options.dynamicVariables) {
        initData.dynamic_variables = options.dynamicVariables
      }

      ws.send(JSON.stringify(initData))
    })

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        const type = msg.type as string

        switch (type) {
          case 'conversation_initiation_metadata': {
            const meta = msg as ConversationInitMetadata
            console.log(
              '[elevenlabs] session started:',
              meta.conversation_initiation_metadata_event.conversation_id,
              'output:', meta.conversation_initiation_metadata_event.agent_output_audio_format,
            )
            if (!resolved) {
              resolved = true
              // Keepalive: send user_activity every 25s to prevent idle timeout
              pingInterval = setInterval(() => {
                if (!closed) ws.send(JSON.stringify({ type: 'user_activity' }))
              }, 25000)
              resolve(session)
            }
            break
          }

          case 'audio': {
            const audioBase64 = msg.audio_event?.audio_base_64
            if (audioBase64) {
              if (currentMode !== 'speaking') {
                currentMode = 'speaking'
              }
              callbacks.onAudio(audioBase64)
            }
            break
          }

          case 'user_transcript': {
            const transcript = msg.user_transcription_event?.user_transcript
            if (transcript) {
              callbacks.onInputTranscript?.(transcript)
            }
            break
          }

          case 'agent_response': {
            const text = msg.agent_response_event?.agent_response
            if (text) {
              callbacks.onOutputTranscript?.(text)
            }
            break
          }

          case 'interruption': {
            currentMode = 'listening'
            callbacks.onInterrupted()
            break
          }

          case 'client_tool_call': {
            const tool = msg.client_tool_call
            if (tool) {
              callbacks.onToolCall?.(
                tool.tool_name,
                tool.tool_call_id,
                typeof tool.parameters === 'string' ? JSON.parse(tool.parameters) : tool.parameters ?? {},
              )
            }
            break
          }

          case 'ping': {
            ws.send(JSON.stringify({
              type: 'pong',
              event_id: msg.ping_event?.event_id,
            }))
            break
          }

          case 'agent_response_correction':
          case 'internal_tentative_agent_response':
            // Streaming partial or correction — ignore
            break

          case 'agent_chat_response_part': {
            const part = msg.agent_chat_response_part_event?.text
            if (part) callbacks.onPartialText?.(part)
            break
          }

          case 'error': {
            const errMsg = msg.error_event?.message ?? 'Unknown ElevenLabs error'
            callbacks.onError(new Error(errMsg))
            break
          }

          case 'vad_score': {
            // When we detect the agent has stopped speaking and VAD indicates
            // the user is not speaking either, that's a turn boundary.
            // ElevenLabs doesn't have an explicit turnComplete event.
            // We detect it by: audio stops flowing + we were speaking before.
            // This is handled below via the silence timer.
            break
          }

          default:
            // agent_tool_request, agent_tool_response, mcp_tool_call, etc.
            break
        }
      } catch (err) {
        callbacks.onError(err)
      }
    })

    // Turn completion detection: ElevenLabs has no explicit turnComplete event.
    // We detect it by tracking when audio stops flowing after the agent was speaking.
    let silenceTimer: ReturnType<typeof setTimeout> | null = null
    const SILENCE_THRESHOLD_MS = 600

    const originalOnAudio = callbacks.onAudio
    callbacks = {
      ...callbacks,
      onAudio(base64Pcm: string) {
        // Reset silence timer on every audio chunk
        if (silenceTimer) {
          clearTimeout(silenceTimer)
          silenceTimer = null
        }
        silenceTimer = setTimeout(() => {
          if (currentMode === 'speaking') {
            currentMode = 'listening'
            callbacks.onTurnComplete()
          }
        }, SILENCE_THRESHOLD_MS)
        originalOnAudio(base64Pcm)
      },
    }

    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      } else {
        callbacks.onError(err)
      }
    })

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || ''
      console.log(`[elevenlabs] websocket closed — code: ${code}, reason: ${reasonStr}`)
      closed = true
      if (silenceTimer) clearTimeout(silenceTimer)
      if (pingInterval) clearInterval(pingInterval)
      if (!resolved) {
        resolved = true
        reject(new Error(`WebSocket closed before init: ${code} ${reasonStr}`))
      } else {
        callbacks.onClose()
      }
    })

    const session: ElevenLabsSession = {
      sendText(text: string) {
        if (closed) return
        ws.send(JSON.stringify({ type: 'user_message', text }))
      },

      sendContextualUpdate(text: string) {
        if (closed) return
        ws.send(JSON.stringify({ type: 'contextual_update', text }))
      },

      sendAudio(base64Pcm: string) {
        if (closed) return
        ws.send(JSON.stringify({ user_audio_chunk: base64Pcm }))
      },

      sendToolResponse(id: string, result: string, isError = false) {
        if (closed) return
        ws.send(JSON.stringify({
          type: 'client_tool_result',
          tool_call_id: id,
          result,
          is_error: isError,
        }))
      },

      close() {
        if (closed) return
        closed = true
        if (silenceTimer) clearTimeout(silenceTimer)
        if (pingInterval) clearInterval(pingInterval)
        ws.close()
      },
    }
  })
}
