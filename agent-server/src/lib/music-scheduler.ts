import type { MusicGenerator } from './music-generator.js'

const RADIO_STYLES = [
  'Chill lo-fi hip hop with warm vinyl crackle, soft piano chords, jazzy Rhodes, and relaxed boom-bap drums. Perfect background music for a tech podcast.',
  'Upbeat synthwave with retro 80s arpeggios, punchy bass, shimmering pads, and driving electronic drums. High energy futuristic vibes.',
  'Ambient electronic with evolving pads, subtle glitch textures, ethereal vocals, and gentle beats. Atmospheric and contemplative.',
  'Funky electro-pop with slap bass, wah guitar, crisp snares, and groovy synth stabs. Energetic and danceable.',
  'Cinematic orchestral with tension-building strings, epic brass hits, pulsing percussion, and a dramatic crescendo. Breaking news feel.',
  'Jazzy neo-soul with smooth saxophone, warm organ chords, fingerstyle bass, and brushed drums. Sophisticated and smooth.',
  'Indie electronic with plucky synths, acoustic guitar samples, hand claps, and a breezy mid-tempo rhythm. Fresh and modern.',
  'Deep house with a groovy four-on-the-floor kick, warm bass, chopped vocal samples, and subtle hi-hat patterns. Smooth and hypnotic.',
  'Chillhop with mellow guitar loops, dusty vinyl textures, laid-back boom-bap drums, and soft Rhodes keys. Relaxing but engaging.',
  'Epic trailer music with pounding taiko drums, soaring strings, powerful brass fanfare, and a building rhythm. Triumphant and bold.',
  'Tropical house with steel drums, marimba melodies, airy pads, light percussion, and a sunny mid-tempo groove. Warm and inviting.',
  'Minimal techno with a hypnotic pulse, subtle acid squelch, crisp hi-hats, and deep sub-bass. Clean and focused.',
  'Acoustic folk with fingerpicked guitar, soft harmonica, gentle tambourine, and a warm campfire vibe. Natural and intimate.',
  'Retro disco funk with wah-wah guitar, punchy horns, driving bass, and four-on-the-floor groove. Feel-good party energy.',
  'Dreamy shoegaze with layers of reverbed guitars, ethereal vocals, slow tempo, and washy cymbals. Beautifully hazy.',
  'Hip hop boom bap with heavy bass, crisp snares, scratchy vinyl samples, and a confident swagger. Old school energy.',
  'Cyberpunk dark synth with aggressive bass, distorted leads, mechanical rhythms, and dystopian atmosphere. Intense and edgy.',
  'Bossa nova with nylon guitar, soft brush drums, gentle bass, and a relaxed swaying rhythm. Elegant and warm.',
  'Progressive electronic with evolving textures, complex rhythms, sweeping filters, and cinematic builds. Intelligent and engaging.',
  'Chiptune with classic 8-bit arpeggios, square wave melodies, energetic tempo, and retro game vibes. Nostalgic and playful.',
]

interface MusicSchedulerOptions {
  tracksPerBatch: number
  durationSeconds: number
}

const DEFAULTS: MusicSchedulerOptions = {
  tracksPerBatch: 10,
  durationSeconds: 60,
}

export class MusicScheduler {
  private generator: MusicGenerator
  private opts: MusicSchedulerOptions
  private generating = false
  private dailyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(generator: MusicGenerator, opts?: Partial<MusicSchedulerOptions>) {
    this.generator = generator
    this.opts = { ...DEFAULTS, ...opts }
  }

  isGenerating(): boolean {
    return this.generating
  }

  startDaily(): void {
    if (this.dailyTimer) return
    this.scheduleDailyRun()
    console.log('[music-scheduler] daily generation scheduled')
  }

  stopDaily(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer)
      this.dailyTimer = null
    }
    console.log('[music-scheduler] daily generation stopped')
  }

  private static readonly INTERVAL_HOURS = 72

  private scheduleDailyRun(): void {
    const now = new Date()
    const next = new Date(now)
    next.setHours(3, 0, 0, 0) // Run at 3 AM
    if (next <= now) next.setDate(next.getDate() + 1)

    // Find the next 3 AM that falls on a 72-hour cycle from epoch
    const msPerCycle = MusicScheduler.INTERVAL_HOURS * 3600_000
    const epoch3am = new Date('2026-01-01T03:00:00').getTime()
    while ((next.getTime() - epoch3am) % msPerCycle !== 0) {
      next.setDate(next.getDate() + 1)
    }

    const delay = next.getTime() - now.getTime()

    this.dailyTimer = setTimeout(() => {
      this.generateBatch().catch((err) =>
        console.error('[music-scheduler] batch failed:', err),
      )
      this.scheduleDailyRun()
    }, delay)

    console.log(`[music-scheduler] next run at ${next.toISOString()} (in ${Math.round(delay / 3600000)}h)`)
  }

  async generateBatch(count?: number): Promise<{ generated: number; errors: number; tracks: string[] }> {
    if (this.generating) {
      console.warn('[music-scheduler] batch already in progress')
      return { generated: 0, errors: 0, tracks: [] }
    }

    this.generating = true
    const total = count ?? this.opts.tracksPerBatch
    const tracks: string[] = []
    let errors = 0

    // Shuffle and pick styles
    const shuffled = [...RADIO_STYLES].sort(() => Math.random() - 0.5)
    const selected = shuffled.slice(0, total)

    console.log(`[music-scheduler] starting batch: ${total} tracks`)

    for (let i = 0; i < selected.length; i++) {
      const prompt = selected[i]
      try {
        console.log(`[music-scheduler] generating ${i + 1}/${total}: "${prompt.slice(0, 60)}..."`)
        const result = await this.generator.generate({
          prompt,
          durationSeconds: this.opts.durationSeconds,
        })
        tracks.push(result.filename)
        console.log(`[music-scheduler] ${i + 1}/${total} done: ${result.filename}`)
      } catch (err) {
        errors++
        console.error(`[music-scheduler] ${i + 1}/${total} failed:`, err)
      }

      // Small delay between generations to be gentle on the API
      if (i < selected.length - 1) {
        await new Promise((r) => setTimeout(r, 5000))
      }
    }

    this.generating = false
    console.log(`[music-scheduler] batch complete: ${tracks.length} generated, ${errors} errors`)
    return { generated: tracks.length, errors, tracks }
  }
}
