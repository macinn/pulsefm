import { connectElevenLabs, type ElevenLabsSession } from './elevenlabs-live.js'
import { getAgentIds } from './agent-provision.js'

const SCREENER_INSTRUCTION = `You are a friendly radio station operator for "Pulse", a 24/7 AI radio station about AI, startups, and technology.

A listener is calling the station. The host is currently busy on air and can't take calls right now.

Your job:
- Greet the caller warmly and let them know the host isn't taking live calls at the moment
- Ask what they'd like to share: a greeting, a shoutout, a message, a question, a news tip, a song request, or anything they want to say
- Ask for their name if they haven't given it
- Listen to their message and acknowledge it
- ALWAYS use the relay_message tool to record what the caller shares — greetings, shoutouts, questions, tips, song requests, anything. Do NOT skip this step.
- After relaying, confirm that you've noted it down and will pass it to the host
- Keep the conversation short and warm — like a real radio station operator
- If they want to stay on the line, gently let them know you'll relay their message and they can listen on air
- Keep each response SHORT — 2-3 sentences max
- Speak in english
- You are NOT the host. You are the station operator answering calls.

Start by greeting the caller.`

export interface RelayedMessage {
  callerName: string
  type: string
  content: string
}

export interface ScreenerCallbacks {
  onAudio(base64Pcm: string): void
  onTranscript(text: string): void
  onTurnComplete(fullText: string): void
  onRelayMessage(msg: RelayedMessage): void
  onInterrupted(): void
  onError(err: unknown): void
  onClose(): void
}

export interface ScreenerSession {
  sendCallerAudio(base64Pcm: string): void
  getRelayedMessages(): RelayedMessage[]
  close(): void
}

export async function createScreenerSession(
  callbacks: ScreenerCallbacks
): Promise<ScreenerSession> {
  let transcriptBuffer = ''
  const relayedMessages: RelayedMessage[] = []

  const session: ElevenLabsSession = await connectElevenLabs(
    {
      agentId: getAgentIds().screener,
      overrides: { prompt: SCREENER_INSTRUCTION },
    },
    {
      onAudio(base64Pcm) {
        callbacks.onAudio(base64Pcm)
      },
      onOutputTranscript(text) {
        transcriptBuffer += text
        callbacks.onTranscript(text)
      },
      onInputTranscript(text) {
        console.log('[screener-caller]', text)
      },
      onTurnComplete() {
        const completed = transcriptBuffer.trim()
        transcriptBuffer = ''
        callbacks.onTurnComplete(completed)
      },
      onInterrupted() {
        transcriptBuffer = ''
        callbacks.onInterrupted()
      },
      onToolCall(name, id, args) {
        if (name === 'relay_message') {
          const msg: RelayedMessage = {
            callerName: (args.callerName as string) || 'a listener',
            type: (args.type as string) || 'message',
            content: (args.content as string) || '',
          }
          relayedMessages.push(msg)
          console.log(`[screener] relayed ${msg.type} from ${msg.callerName}: ${msg.content.slice(0, 80)}`)
          callbacks.onRelayMessage(msg)
          session.sendToolResponse(id, JSON.stringify({ status: 'noted', message: 'Message recorded. Confirm to the caller.' }))
        } else {
          session.sendToolResponse(id, JSON.stringify({ error: 'unknown tool' }))
        }
      },
      onError: callbacks.onError,
      onClose: callbacks.onClose,
    },
  )

  // Screener starts the conversation by greeting the caller
  session.sendText('A listener is calling. Greet them warmly.')

  return {
    sendCallerAudio(base64Pcm: string) {
      session.sendAudio(base64Pcm)
    },
    getRelayedMessages() {
      return [...relayedMessages]
    },
    close() {
      session.close()
    },
  }
}
