import { connectElevenLabs, type ElevenLabsSession } from './elevenlabs-live.js'
import { getAgentIds } from './agent-provision.js'

export interface GuestConfig {
  name: string
  expertise: string
  topic: string
  voiceId?: string
}

export interface GuestCallbacks {
  onAudio(base64Pcm: string): void
  onTranscript(text: string): void
  onTurnComplete(): void
  onInterrupted(): void
  onError(err: unknown): void
  onClose(): void
}

export interface GuestSession {
  config: GuestConfig
  respondTo(hostText: string): void
  close(): void
}

function buildGuestInstruction(config: GuestConfig): string {
  return `You are ${config.name}, an expert on ${config.expertise}. You are a live guest on "Pulse", a 24/7 AI radio station hosted by Pulse.

The topic of today's segment is: ${config.topic}

Your style:
- Be conversational and engaging, like a real podcast guest
- Share deep expertise, concrete examples, and unique insights
- Respond to the host's questions and build on the conversation naturally
- Keep each response SHORT — 1 to 2 paragraphs max, then pause so the host can follow up
- You're live on air — be natural, dynamic, and passionate about your field
- Never introduce yourself unless asked — the host will introduce you
- Address the host naturally (don't call them by name every sentence)

Wait for the host to speak first. Then respond to what they say.`
}

export async function createGuestSession(
  config: GuestConfig,
  callbacks: GuestCallbacks
): Promise<GuestSession> {
  let transcriptBuffer = ''

  const session: ElevenLabsSession = await connectElevenLabs(
    {
      agentId: getAgentIds().guest,
      overrides: {
        prompt: buildGuestInstruction(config),
        ...(config.voiceId ? { voiceId: config.voiceId } : {}),
      },
    },
    {
      onAudio(base64Pcm) {
        callbacks.onAudio(base64Pcm)
      },
      onOutputTranscript(text) {
        transcriptBuffer += text
        callbacks.onTranscript(text)
      },
      onInputTranscript() {},
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
      onError: callbacks.onError,
      onClose: callbacks.onClose,
    },
  )

  return {
    config,
    respondTo(hostText: string) {
      session.sendContextualUpdate(`The host just said: "${hostText}"`)
      session.sendText('Respond to the host.')
    },
    close() {
      session.close()
    },
  }
}
