export type SourceType = 'rss' | 'reddit' | 'gemini-search' | 'firecrawl'
export type ConfidenceLevel = 'confirmed' | 'developing' | 'rumor'

export interface NewsCandidate {
  id: string
  headline: string
  summary: string
  url: string
  source: SourceType
  sourceLabel: string
  detectedAt: number
  rawScore: number
  imageUrl?: string
  imageUrls?: string[]
  keyPoints?: string[]
  discussionTopics?: string[]
  /** Original article publication timestamp (when available) */
  publishedAt?: number
}

export type BriefAction = 'created' | 'sent' | 'researched' | 'enriched' | 'report-ready' | 'updated' | 'concluded'

export interface ActivityLogEntry {
  timestamp: number
  action: BriefAction
  detail?: string
}

export interface EnrichmentReport {
  broadcastSummary: string
  keyFindings: string[]
  analysisAngles: string[]
  relatedTopics: string[]
  editorialNotes: string
  turnPrompts: string[]
  sourcesReviewed: number
  sourcesWithContent: number
  needsFollowUp: boolean
  followUpReason?: string
  generatedAt: number
}

export interface EditorialBrief {
  id: string
  headline: string
  summary: string
  confidence: ConfidenceLevel
  priority: number // 0-100
  isBreaking: boolean
  sources: { label: string; type: SourceType; url: string }[]
  relatedCandidateIds: string[]
  generatedAt: number
  used: boolean
  imageUrl?: string
  imageUrls?: string[]
  needsResearch?: boolean
  report?: EnrichmentReport
  activityLog?: ActivityLogEntry[]
  lastUpdatedAt?: number
  sentAt?: number
  sentCount?: number
  /** How often (ms) this brief should be re-researched while developing. Assigned by EditorAgent. */
  recheckIntervalMs?: number
  /** Timestamp of the last research pass */
  lastResearchedAt?: number
}
