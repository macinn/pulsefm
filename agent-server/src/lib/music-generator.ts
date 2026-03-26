import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { GoogleGenAI, Type } from '@google/genai'
import { execFile } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
if (!ELEVENLABS_API_KEY) console.warn('[music-gen] ELEVENLABS_API_KEY not set — music generation disabled')

const elevenlabs = new ElevenLabsClient()

// Vertex AI client at 'global' location for prompt enhancement (gemini-3.1-flash-lite-preview)
function createVertexGlobalClient() {
  const savedLocation = process.env.GOOGLE_CLOUD_LOCATION
  process.env.GOOGLE_CLOUD_LOCATION = 'global'
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! })
  if (savedLocation !== undefined) process.env.GOOGLE_CLOUD_LOCATION = savedLocation
  else delete process.env.GOOGLE_CLOUD_LOCATION
  return client
}
const vertexAi = createVertexGlobalClient()

export interface GenerateMusicOptions {
  prompt: string
  durationSeconds?: number
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

const PROMPT_ENHANCER_SYSTEM = `You are a music production expert who writes prompts for an AI music generation API.
Given a user description, produce a single rich text prompt.

Your job is to craft a vivid description of the STYLE, FEEL, and GENRE of the music.
Focus on: genre/subgenre, era/decade feel, mood, energy, rhythm patterns, sonic texture, atmosphere.
Only mention instruments when they are essential to defining the style (e.g. "acoustic guitar-driven" or "heavy synth bass").

COPYRIGHT RULE — CRITICAL:
If the user references a copyrighted song, artist, or album, you MUST:
1. Identify the musical characteristics of that reference (genre, tempo, mood, texture, era).
2. Write a prompt that captures those characteristics WITHOUT naming the song, artist, or any copyrighted work.
3. Never include artist names, song titles, album names, or band names in the output prompt.

Rules: expand vague terms into vivid style descriptions. Keep the result under 200 words.`

const ENHANCED_SPEC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    prompt: { type: Type.STRING },
  },
  required: ['prompt'],
}

async function enhancePromptWithLLM(rawPrompt: string): Promise<string> {
  const response = await vertexAi.models.generateContent({
    model: 'gemini-3.1-flash-lite-preview',
    contents: [{ role: 'user', parts: [{ text: `User prompt: "${rawPrompt}"` }] }],
    config: {
      systemInstruction: PROMPT_ENHANCER_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: ENHANCED_SPEC_SCHEMA,
    },
  })

  const spec = JSON.parse(response.text ?? '{}') as { prompt?: string }
  return spec.prompt || rawPrompt
}

// Convert MP3 to WAV (24kHz mono 16-bit) using ffmpeg
function mp3ToWav(mp3Path: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', mp3Path,
      '-ar', '24000', '-ac', '1', '-sample_fmt', 's16',
      wavPath,
    ], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr || err.message}`))
      } else {
        resolve()
      }
    })
  })
}

export class MusicGenerator {
  private mediaDir: string
  private db: Database.Database

  constructor(mediaDir: string, db: Database.Database) {
    this.mediaDir = mediaDir
    this.db = db
    if (!existsSync(mediaDir)) {
      mkdirSync(mediaDir, { recursive: true })
    }
  }

  private appendToLibrary(entry: MusicLibraryEntry): void {
    this.db.prepare('INSERT OR REPLACE INTO music_library (filename, prompt, duration_seconds, created_at, enhanced_prompt) VALUES (?, ?, ?, ?, ?)')
      .run(entry.filename, entry.prompt, entry.durationSeconds, entry.createdAt, entry.enhancedPrompt)
  }

  listTracks(): MusicLibraryEntry[] {
    const rows = this.db.prepare('SELECT filename, prompt, duration_seconds, created_at, enhanced_prompt FROM music_library ORDER BY created_at DESC').all() as {
      filename: string; prompt: string; duration_seconds: number; created_at: number; enhanced_prompt: string
    }[]
    return rows.map((r) => ({
      filename: r.filename,
      prompt: r.prompt,
      durationSeconds: r.duration_seconds,
      createdAt: r.created_at,
      enhancedPrompt: r.enhanced_prompt,
    }))
  }

  async generate(options: GenerateMusicOptions): Promise<GenerateMusicResult> {
    if (!ELEVENLABS_API_KEY) throw new Error('Music generation unavailable — ELEVENLABS_API_KEY not configured')

    // ElevenLabs Music: 3s–600s range
    const duration = Math.min(Math.max(options.durationSeconds ?? 60, 3), 600)

    // Enhance prompt via LLM
    let enhancedPrompt: string
    try {
      enhancedPrompt = await enhancePromptWithLLM(options.prompt)
      console.log(`[music-gen] enhanced prompt: ${enhancedPrompt}`)
    } catch (err) {
      console.warn('[music-gen] prompt enhancement failed, using raw prompt:', err)
      enhancedPrompt = options.prompt
    }

    console.log(`[music-gen] starting: "${options.prompt}" (${duration}s)`)

    // Call ElevenLabs Music API
    const audioStream = await elevenlabs.music.compose({
      prompt: enhancedPrompt,
      musicLengthMs: duration * 1000,
      forceInstrumental: true,
    })

    // Collect MP3 stream into a temp file
    const slug = options.prompt
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/-+$/, '')
      .toLowerCase()
    const timestamp = Date.now()
    const mp3Path = path.join(this.mediaDir, `_tmp-${timestamp}.mp3`)
    const wavFilename = `ai-${slug}-${timestamp}.wav`
    const wavPath = path.join(this.mediaDir, wavFilename)

    // Write MP3 stream to disk
    const chunks: Buffer[] = []
    const collector = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk))
        cb()
      },
    })

    await pipeline(audioStream, collector)
    writeFileSync(mp3Path, Buffer.concat(chunks))
    console.log(`[music-gen] MP3 received (${Math.round(Buffer.concat(chunks).length / 1024)}KB), converting to WAV...`)

    // Convert MP3 → WAV 24kHz mono
    try {
      await mp3ToWav(mp3Path, wavPath)
    } finally {
      try { unlinkSync(mp3Path) } catch { /* temp cleanup */ }
    }

    console.log(`[music-gen] saved: ${wavFilename} (${duration}s)`)

    this.appendToLibrary({
      filename: wavFilename,
      prompt: options.prompt,
      durationSeconds: duration,
      createdAt: timestamp,
      enhancedPrompt,
    })

    return {
      filename: wavFilename,
      durationSeconds: duration,
      prompt: options.prompt,
      enhancedPrompt,
    }
  }
}
