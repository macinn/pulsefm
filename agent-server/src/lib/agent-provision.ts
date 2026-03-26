const API_BASE = 'https://api.elevenlabs.io/v1'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is required')

export interface AgentDefinition {
  name: string
  prompt: string
  firstMessage?: string
  language?: string
  voiceId?: string
  clientTools?: ClientToolDef[]
}

export interface ClientToolDef {
  name: string
  description: string
  expectsResponse: boolean
  parameters?: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
}

export interface ProvisionedAgents {
  presenter: string
  cohost: string
  guest: string
  screener: string
  producer: string
}

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY!,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ElevenLabs API ${method} ${path} failed: ${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

interface ListAgentsResponse {
  agents: { agent_id: string; name: string }[]
}

interface CreateAgentResponse {
  agent_id: string
}

async function findAgentByName(name: string): Promise<string | null> {
  const data = await apiRequest<ListAgentsResponse>('GET', `/convai/agents?search=${encodeURIComponent(name)}&page_size=20`)
  const match = data.agents?.find((a) => a.name === name)
  return match?.agent_id ?? null
}

function buildCreateBody(def: AgentDefinition) {
  const tools = (def.clientTools ?? []).map((t) => ({
    type: 'client' as const,
    name: t.name,
    description: t.description,
    expects_response: t.expectsResponse,
    ...(t.parameters ? { parameters: t.parameters } : {}),
  }))

  return {
    name: def.name,
    conversation_config: {
      agent: {
        prompt: {
          prompt: def.prompt,
          llm: 'gpt-4o-mini',
          temperature: 0.7,
          tools,
        },
        first_message: def.firstMessage ?? '',
        language: def.language ?? 'en',
      },
      tts: {
        ...(def.voiceId ? { voice_id: def.voiceId } : {}),
        agent_output_audio_format: 'pcm_24000',
      },
      conversation: {
        max_duration_seconds: 7200,
        client_events: [
          'conversation_initiation_metadata',
          'audio',
          'agent_response',
          'agent_response_correction',
          'agent_chat_response_part',
          'user_transcript',
          'interruption',
          'ping',
          'client_tool_call',
        ],
      },
      turn: {
        turn_timeout: 30,
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: true },
            first_message: true,
            language: true,
          },
          tts: {
            voice_id: true,
          },
        },
      },
    },
  }
}

async function ensureAgent(def: AgentDefinition): Promise<string> {
  // Check if agent already exists
  const existing = await findAgentByName(def.name)
  if (existing) {
    console.log(`[provision] found existing agent "${def.name}" → ${existing}, updating config...`)
    const body = buildCreateBody(def)
    await apiRequest('PATCH', `/convai/agents/${existing}`, body)
    return existing
  }

  // Create new agent
  const body = buildCreateBody(def)
  const result = await apiRequest<CreateAgentResponse>('POST', '/convai/agents/create', body)
  console.log(`[provision] created agent "${def.name}" → ${result.agent_id}`)
  return result.agent_id
}

// Agent definitions for each role
const PRESENTER_DEF: AgentDefinition = {
  name: 'Pulse – Presenter',
  prompt: 'You are a radio presenter. Your system prompt will be overridden at connection time.',
  firstMessage: '',
  language: 'en',
  voiceId: 'onwK4e9ZLuTAKqWW03F9', // Daniel – Steady Broadcaster (British, formal)
  clientTools: [
    {
      name: 'generate_music',
      description:
        'Generate an original AI music track. ONLY use when a LISTENER during a live call explicitly asks. ' +
        'NEVER on your own initiative. Describe musical characteristics instead of naming copyrighted works.',
      expectsResponse: true,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed music style description (genre, mood, instruments, tempo)',
          },
          durationSeconds: {
            type: 'number',
            description: 'Duration in seconds (3-600). Defaults to 60.',
          },
        },
        required: ['prompt'],
      },
    },
  ],
}

const COHOST_DEF: AgentDefinition = {
  name: 'Pulse – Co-host Nova',
  prompt: 'You are a radio co-host. Your system prompt will be overridden at connection time.',
  firstMessage: '',
  language: 'en',
  voiceId: 'pFZP5JQG7iQjIQuC4Bku', // Lily – Velvety British Actress
}

const GUEST_DEF: AgentDefinition = {
  name: 'Pulse – Guest Expert',
  prompt: 'You are a guest expert. Your system prompt will be overridden at connection time.',
  firstMessage: '',
  language: 'en',
  voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah – Mature, Confident (default fallback)
}

const SCREENER_DEF: AgentDefinition = {
  name: 'Pulse – Screener',
  prompt: 'You are a radio station operator. Your system prompt will be overridden at connection time.',
  firstMessage: '',
  language: 'en',
  voiceId: 'cgSgspJ2msm6clMCkdW9', // Jessica – Playful, Bright
  clientTools: [
    {
      name: 'relay_message',
      description:
        'Relay a listener message to the host. Call this tool EVERY TIME the caller shares something worth passing along: ' +
        'a greeting, shoutout, question, news tip, song request, or any message for the host.',
      expectsResponse: true,
      parameters: {
        type: 'object',
        properties: {
          callerName: {
            type: 'string',
            description: 'The name the caller gave, or "a listener" if unknown.',
          },
          type: {
            type: 'string',
            description: 'Category: greeting, shoutout, question, news_tip, song_request, or message.',
          },
          content: {
            type: 'string',
            description: 'The actual message, question, or request from the caller.',
          },
        },
        required: ['callerName', 'type', 'content'],
      },
    },
  ],
}

const PRODUCER_DEF: AgentDefinition = {
  name: 'Pulse – Producer',
  prompt: 'You are a radio co-presenter. Your system prompt will be overridden at connection time.',
  firstMessage: '',
  language: 'en',
  voiceId: 'cjVigY5qzO86Huf0OWal', // Eric – Smooth, Trustworthy
}

let cachedAgents: ProvisionedAgents | null = null

export async function provisionAgents(): Promise<ProvisionedAgents> {
  if (cachedAgents) return cachedAgents

  console.log('[provision] ensuring ElevenLabs agents exist...')

  const [presenter, cohost, guest, screener, producer] = await Promise.all([
    ensureAgent(PRESENTER_DEF),
    ensureAgent(COHOST_DEF),
    ensureAgent(GUEST_DEF),
    ensureAgent(SCREENER_DEF),
    ensureAgent(PRODUCER_DEF),
  ])

  cachedAgents = { presenter, cohost, guest, screener, producer }
  console.log('[provision] all agents ready:', cachedAgents)
  return cachedAgents
}

export function getAgentIds(): ProvisionedAgents {
  if (!cachedAgents) throw new Error('Agents not provisioned yet — call provisionAgents() first')
  return cachedAgents
}
