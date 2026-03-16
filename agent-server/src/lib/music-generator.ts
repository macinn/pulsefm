import { GoogleGenAI, Type } from '@google/genai'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) console.warn('[music-gen] GEMINI_API_KEY not set — music generation disabled')

// Lyria requires AI Studio, but GOOGLE_GENAI_USE_VERTEXAI=true forces Vertex globally.
// The SDK has no per-instance override, so we toggle the env var during construction.
function createAIStudioClient() {
  const saved = process.env.GOOGLE_GENAI_USE_VERTEXAI
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI
  const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY!, apiVersion: 'v1alpha' as string })
  if (saved !== undefined) process.env.GOOGLE_GENAI_USE_VERTEXAI = saved
  return client
}
// AI Studio client — used exclusively for Lyria music generation
const ai = createAIStudioClient()

// Vertex AI client at 'global' location — gemini-3.1-flash-lite-preview is only available there.
// Uses same apiKey+env-var pattern as other agents, but temporarily overrides location to 'global'.
function createVertexGlobalClient() {
  const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
  process.env.GOOGLE_CLOUD_LOCATION = 'global'
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! })
  if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
  else delete process.env.GOOGLE_CLOUD_LOCATION
  return client
}
const vertexAi = createVertexGlobalClient()

// Lyria output format per current docs: 48kHz stereo PCM16
const LYRIA_SAMPLE_RATE = 48000
const LYRIA_CHANNELS = 2

// Target format — must match what MusicPlayer expects (24kHz mono 16-bit)
const OUTPUT_SAMPLE_RATE = 24000
const OUTPUT_CHANNELS = 1
const OUTPUT_BIT_DEPTH = 16

export interface GenerateMusicOptions {
  prompt: string
  durationSeconds?: number
  bpm?: number
  temperature?: number
}

export interface MusicLibraryEntry {
  filename: string
  prompt: string
  durationSeconds: number
  createdAt: number
  enhancedPrompt: string
}

export interface GenerateMusicResult {
  filename: string
  durationSeconds: number
  prompt: string
  enhancedPrompt?: string
}

interface EnhancedMusicSpec {
  prompt: string
  bpm?: number
  temperature?: number
  density?: number
  brightness?: number
}

const PROMPT_ENHANCER_SYSTEM = `You are a music production expert who writes prompts for Google's Lyria RealTime generative music API.
Given a user description and optional hints, produce an enhanced spec.

Your job is to craft a vivid description of the STYLE, FEEL, and GENRE of the music — not a shopping list of instruments.
Focus on: genre/subgenre, era/decade feel, mood, energy, rhythm patterns, sonic texture, atmosphere.
Only mention instruments when they are essential to defining the style (e.g. "acoustic guitar-driven" or "heavy synth bass").

COPYRIGHT RULE — CRITICAL:
If the user references a copyrighted song, artist, or album (e.g. "something like Bohemian Rhapsody" or "a Drake-style beat"), you MUST:
1. Identify the musical characteristics of that reference (genre, tempo, mood, texture, era).
2. Write a prompt that captures those characteristics WITHOUT naming the song, artist, or any copyrighted work.
3. Never include artist names, song titles, album names, or band names in the output prompt.

Lyria parameters:
- prompt: a single, rich text description of the desired music focusing on style, mood, genre, energy and feel.
- bpm: 60-200. Pick an appropriate value for the genre if not specified.
- temperature: 0.0-3.0 creativity. Default 1.0.
- density: 0.0-1.0 note density.
- brightness: 0.0-1.0 tonal brightness.

Rules: expand vague terms into vivid style descriptions, honour user hints when given.`

const ENHANCED_SPEC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    prompt: { type: Type.STRING },
    bpm: { type: Type.NUMBER },
    temperature: { type: Type.NUMBER },
    density: { type: Type.NUMBER },
    brightness: { type: Type.NUMBER },
  },
  required: ['prompt'],
}

async function enhancePromptWithLLM(
  rawPrompt: string,
  hints: { bpm?: number; temperature?: number },
): Promise<EnhancedMusicSpec> {

  const userMessage = `User prompt: "${rawPrompt}"\nHints: ${JSON.stringify(hints)}`

  const response = await vertexAi.models.generateContent({
    model: 'gemini-3.1-flash-lite-preview',
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: PROMPT_ENHANCER_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: ENHANCED_SPEC_SCHEMA,
    },
  })

  const spec = JSON.parse(response.text ?? '{}') as EnhancedMusicSpec

  if (!spec.prompt) {
    spec.prompt = rawPrompt
  }

  return spec
}

export class MusicGenerator {
  private mediaDir: string

  constructor(mediaDir: string) {
    this.mediaDir = mediaDir
    if (!existsSync(mediaDir)) {
      mkdirSync(mediaDir, { recursive: true })
    }
  }

  private get libraryPath(): string {
    return path.join(this.mediaDir, 'music-library.json')
  }

  private readLibrary(): MusicLibraryEntry[] {
    try {
      if (!existsSync(this.libraryPath)) return []
      return JSON.parse(readFileSync(this.libraryPath, 'utf-8')) as MusicLibraryEntry[]
    } catch {
      return []
    }
  }

  private appendToLibrary(entry: MusicLibraryEntry): void {
    const lib = this.readLibrary()
    lib.push(entry)
    writeFileSync(this.libraryPath, JSON.stringify(lib, null, 2))
  }

  listTracks(): MusicLibraryEntry[] {
    return this.readLibrary().reverse()
  }

  async generate(options: GenerateMusicOptions): Promise<GenerateMusicResult> {
    if (!GEMINI_API_KEY) throw new Error('Music generation unavailable — GEMINI_API_KEY not configured')

    const duration = Math.min(Math.max(options.durationSeconds ?? 60, 60), 120)
    const hintBpm = Math.min(Math.max(options.bpm ?? 120, 60), 200)
    const hintTemperature = options.temperature ?? 1.0

    // Enhance the prompt with an LLM before calling Lyria
    let spec: EnhancedMusicSpec
    try {
      spec = await enhancePromptWithLLM(options.prompt, { bpm: options.bpm, temperature: options.temperature })
      console.log(`[music-gen] enhanced spec: ${JSON.stringify(spec)}`)
    } catch (err) {
      console.warn('[music-gen] prompt enhancement failed, using raw prompt:', err)
      spec = {
        prompt: options.prompt,
        bpm: hintBpm,
        temperature: hintTemperature,
      }
    }

    const bpm = Math.min(Math.max(spec.bpm ?? hintBpm, 60), 200)
    const temperature = spec.temperature ?? hintTemperature

    const chunks: Buffer[] = []
    let totalBytes = 0
    const bytesPerSecond = LYRIA_SAMPLE_RATE * LYRIA_CHANNELS * (OUTPUT_BIT_DEPTH / 8)
    const targetBytes = bytesPerSecond * duration

    console.log(`[music-gen] starting: "${options.prompt}" (${duration}s, ${bpm}bpm)`)

    return new Promise<GenerateMusicResult>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let session: any = null
      let resolved = false
      let safetyTimer: ReturnType<typeof setTimeout> | null = null
      let setupComplete = false
      let setupResolve: (() => void) | null = null
      const setupPromise = new Promise<void>((resolveSetup) => {
        setupResolve = resolveSetup
      })

      const finalize = () => {
        if (resolved) return
        resolved = true
        if (safetyTimer) clearTimeout(safetyTimer)
        try { session?.close?.() } catch { /* ignore */ }

        if (chunks.length === 0) {
          reject(new Error('No audio data received from Lyria'))
          return
        }

        const rawPcm = Buffer.concat(chunks)
        const converted = stereo48kToMono24k(rawPcm)
        const wav = pcmToWav(converted, OUTPUT_SAMPLE_RATE, OUTPUT_CHANNELS, OUTPUT_BIT_DEPTH)

        const slug = options.prompt
          .slice(0, 40)
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/-+$/, '')
          .toLowerCase()
        const filename = `ai-${slug}-${Date.now()}.wav`
        const filePath = path.join(this.mediaDir, filename)
        writeFileSync(filePath, wav)

        const actualDuration = converted.length / (OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * (OUTPUT_BIT_DEPTH / 8))
        const clampedDuration = Math.max(actualDuration, 60)
        console.log(`[music-gen] saved: ${filename} (${actualDuration.toFixed(1)}s, reported as ${Math.round(clampedDuration)}s)`)

        this.appendToLibrary({
          filename,
          prompt: options.prompt,
          durationSeconds: Math.round(clampedDuration),
          createdAt: Date.now(),
          enhancedPrompt: spec.prompt,
        })

        resolve({
          filename,
          durationSeconds: Math.round(clampedDuration),
          prompt: options.prompt,
          enhancedPrompt: spec.prompt,
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ai.live as any).music.connect({
        model: 'models/lyria-realtime-exp',
        callbacks: {
          onopen: () => {
            console.log('[music-gen] session opened')
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onmessage: (message: any) => {
            if (message.setupComplete && !setupComplete) {
              setupComplete = true
              console.log('[music-gen] setup complete')
              setupResolve?.()
              return
            }

            // Log first message structure for debugging
            if (chunks.length === 0 && totalBytes === 0) {
              console.log('[music-gen] first message keys:', Object.keys(message))
              if (message.serverContent) {
                console.log('[music-gen] serverContent keys:', Object.keys(message.serverContent))
              }
              if (message.filteredPrompt) {
                console.log('[music-gen] filtered prompt:', message.filteredPrompt)
              }
            }
            if (message.serverContent?.audioChunks) {
              for (const chunk of message.serverContent.audioChunks) {
                const buf = Buffer.from(chunk.data, 'base64')
                chunks.push(buf)
                totalBytes += buf.length
                if (totalBytes >= targetBytes) {
                  finalize()
                }
              }
            }
            // Also check for audio data at the top level (like Gemini Live does)
            if (message.data) {
              const buf = Buffer.from(message.data, 'base64')
              chunks.push(buf)
              totalBytes += buf.length
              if (totalBytes >= targetBytes) {
                finalize()
              }
            }
          },
          onerror: (error: unknown) => {
            console.error('[music-gen] error:', error)
            if (!resolved) {
              if (chunks.length > 0) {
                finalize()
              } else {
                resolved = true
                reject(error)
              }
            }
          },
          onclose: () => {
            console.log(`[music-gen] stream closed (chunks received: ${chunks.length}, bytes: ${totalBytes})`)
            if (!resolved && chunks.length > 0) {
              finalize()
            }
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }).then(async (s: any) => {
        session = s
        console.log('[music-gen] connected, waiting for setupComplete...')

        await setupPromise
        console.log('[music-gen] setup complete, setting prompts...')

        await session.setWeightedPrompts({
          weightedPrompts: [
            { text: spec.prompt, weight: 1.0 },
          ],
        })
        console.log('[music-gen] prompts set, configuring...')

        const musicConfig: Record<string, unknown> = { bpm, temperature }
        if (spec.density !== undefined) musicConfig.density = spec.density
        if (spec.brightness !== undefined) musicConfig.brightness = spec.brightness

        await session.setMusicGenerationConfig({
          musicGenerationConfig: musicConfig,
        })
        console.log('[music-gen] config set, calling play()...')

        await session.play()
        console.log('[music-gen] play() called, waiting for audio data...')

        // Safety timeout in case we never hit targetBytes
        safetyTimer = setTimeout(() => {
          finalize()
        }, (duration + 10) * 1000)
      }).catch((err: unknown) => {
        if (!resolved) {
          resolved = true
          reject(err)
        }
      })
    })
  }
}

/**
 * Convert stereo 48kHz 16-bit PCM to mono 24kHz 16-bit PCM.
 */
function stereo48kToMono24k(input: Buffer): Buffer {
  const bytesPerSample = 2
  const inputFrameSize = bytesPerSample * LYRIA_CHANNELS // 4 bytes per frame (stereo)
  const inputFrames = Math.floor(input.length / inputFrameSize)

  const ratio = LYRIA_SAMPLE_RATE / OUTPUT_SAMPLE_RATE
  const outputFrames = Math.floor(inputFrames / ratio)
  const output = Buffer.alloc(outputFrames * bytesPerSample)

  for (let i = 0; i < outputFrames; i++) {
    const srcPos = Math.floor(i * ratio)
    const byteOffset = srcPos * inputFrameSize

    if (byteOffset + 3 < input.length) {
      const left = input.readInt16LE(byteOffset)
      const right = input.readInt16LE(byteOffset + 2)
      const mono = Math.round((left + right) / 2)
      output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * bytesPerSample)
    }
  }

  return output
}

/**
 * Wrap raw PCM data in a standard WAV file header.
 */
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * (bitDepth / 8)
  const blockAlign = channels * (bitDepth / 8)

  header.write('RIFF', 0)
  header.writeUInt32LE(pcm.length + 36, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          // fmt chunk size
  header.writeUInt16LE(1, 20)           // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}
