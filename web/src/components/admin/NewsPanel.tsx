"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Newspaper,
  Search,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Flame,
  ExternalLink,
  Zap,
  Clock,
  ChevronDown,
  ChevronUp,
  Rss,
  Globe,
  Database,
  Image as ImageIcon,
  Sparkles,
  Send,
  CalendarPlus,
  Hand,
  StickyNote,
  History,
  Ban,
  RefreshCw,
  ArrowUpCircle,
  BookOpenCheck,
} from "lucide-react";
import { getApiUrl } from "@/lib/config";

const STATION_ID = "pulse-ai";

type ConfidenceLevel = "confirmed" | "developing" | "rumor";
type SourceType = "rss" | "reddit" | "gemini-search" | "firecrawl";
type BriefAction = "created" | "sent" | "researched" | "enriched" | "report-ready" | "updated" | "concluded";

interface BriefSource {
  label: string;
  type: SourceType;
  url: string;
}

interface ActivityLogEntry {
  timestamp: number;
  action: BriefAction;
  detail?: string;
}

interface EnrichmentReport {
  broadcastSummary: string;
  keyFindings: string[];
  analysisAngles: string[];
  relatedTopics: string[];
  editorialNotes: string;
  turnPrompts: string[];
  sourcesReviewed: number;
  sourcesWithContent: number;
  needsFollowUp: boolean;
  followUpReason?: string;
  generatedAt: number;
}

interface EditorialBrief {
  id: string;
  headline: string;
  summary: string;
  confidence: ConfidenceLevel;
  priority: number;
  isBreaking: boolean;
  sources: BriefSource[];
  relatedCandidateIds: string[];
  generatedAt: number;
  used: boolean;
  imageUrl?: string;
  imageUrls?: string[];
  needsResearch?: boolean;
  report?: EnrichmentReport;
  activityLog?: ActivityLogEntry[];
  lastUpdatedAt?: number;
  sentAt?: number;
  sentCount?: number;
}

const CONFIDENCE_STYLES: Record<
  ConfidenceLevel,
  { icon: typeof CheckCircle2; label: string; color: string; bg: string; border: string }
> = {
  confirmed: {
    icon: CheckCircle2,
    label: "Confirmed",
    color: "text-live",
    bg: "bg-live/10",
    border: "border-live/20",
  },
  developing: {
    icon: Clock,
    label: "Developing",
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
  },
  rumor: {
    icon: HelpCircle,
    label: "Rumor",
    color: "text-text-dim",
    bg: "bg-white/5",
    border: "border-white/10",
  },
};

const SOURCE_ICON: Record<SourceType, typeof Rss> = {
  rss: Rss,
  reddit: Globe,
  "gemini-search": Search,
  firecrawl: Flame,
};

type InjectType = 'breaking' | 'co-anchor' | 'soft';

interface NewsPanelProps {
  onInjectNews: (type: InjectType, text: string, imageUrl?: string, imageUrls?: string[], turnPrompts?: string[]) => void;
  onCreateBlock?: (brief: { briefId: string; headline: string; summary: string; imageUrls?: string[]; turnPrompts?: string[] }) => void;
  isPresenting: boolean;
  canInject?: boolean;
  lockedOps?: Record<string, boolean>;
}

export default function NewsPanel({ onInjectNews, onCreateBlock, isPresenting, canInject, lockedOps }: NewsPanelProps) {
  const [briefs, setBriefs] = useState<EditorialBrief[]>([]);
  const [scanning, setScanning] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [scanResult, setScanResult] = useState<{ found: number; errors?: string[]; researched?: number } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "sent" | "breaking">("all");
  const [researchingId, setResearchingId] = useState<string | null>(null);

  const fetchBriefs = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/news/${STATION_ID}/briefs`);
      if (res.ok) {
        const data: EditorialBrief[] = await res.json();
        setBriefs(data.sort((a, b) => b.priority - a.priority));
      }
    } catch (err) {
      console.error("[news] fetch briefs failed:", err);
    }
  }, []);

  useEffect(() => {
    fetchBriefs();
    // Poll every 5s to pick up background enrichment/research updates
    const interval = setInterval(fetchBriefs, 5000);
    return () => clearInterval(interval);
  }, [fetchBriefs]);

  async function handleScanAndProcess() {
    setScanning(true);
    setScanResult(null);
    try {
      const scanRes = await fetch(`${getApiUrl()}/news/${STATION_ID}/scan`, { method: "POST" });
      const scanData = await scanRes.json();
      setScanResult(scanData);

      setScanning(false);
      setProcessing(true);

      const processRes = await fetch(`${getApiUrl()}/news/${STATION_ID}/process`, { method: "POST" });
      const processData = await processRes.json();
      setScanResult((prev) => prev ? { ...prev, researched: processData.researched } : prev);
      await fetchBriefs();
    } catch (err) {
      console.error("[news] scan+process failed:", err);
    } finally {
      setScanning(false);
      setProcessing(false);
    }
  }

  async function sendBrief(briefId: string, method: string) {
    try {
      const res = await fetch(`${getApiUrl()}/news/${STATION_ID}/briefs/${briefId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method }),
      });
      if (res.ok) {
        const updated: EditorialBrief = await res.json();
        setBriefs((prev) => prev.map((b) => (b.id === briefId ? updated : b)));
      }
    } catch (err) {
      console.error("[news] send brief failed:", err);
    }
  }

  async function concludeBrief(briefId: string) {
    try {
      const res = await fetch(`${getApiUrl()}/news/${STATION_ID}/briefs/${briefId}/conclude`, { method: "POST" });
      if (res.ok) {
        const updated: EditorialBrief = await res.json();
        setBriefs((prev) => prev.map((b) => (b.id === briefId ? updated : b)));
      }
    } catch (err) {
      console.error("[news] conclude brief failed:", err);
    }
  }

  async function handleResearch(briefId: string) {
    setResearchingId(briefId);
    try {
      const res = await fetch(`${getApiUrl()}/news/${STATION_ID}/briefs/${briefId}/research`, { method: "POST" });
      if (res.ok) {
        const enriched: EditorialBrief = await res.json();
        setBriefs((prev) => prev.map((b) => (b.id === briefId ? enriched : b)));
      }
    } catch (err) {
      console.error("[news] research failed:", err);
    } finally {
      setResearchingId(null);
    }
  }

  const filtered = briefs.filter((b) => {
    const isConcluded = b.activityLog?.some((e) => e.action === "concluded");
    if (filter === "active") return !isConcluded && !b.sentAt;
    if (filter === "sent") return !!b.sentAt && !isConcluded;
    if (filter === "breaking") return b.isBreaking && !isConcluded;
    return true;
  });

  const activeCount = briefs.filter((b) => !b.sentAt && !b.activityLog?.some((e) => e.action === "concluded")).length;
  const sentCount = briefs.filter((b) => !!b.sentAt && !b.activityLog?.some((e) => e.action === "concluded")).length;
  const breakingCount = briefs.filter((b) => b.isBreaking && !b.activityLog?.some((e) => e.action === "concluded")).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading text-xs font-bold tracking-widest uppercase text-text-muted flex items-center gap-2">
          <Newspaper className="w-3.5 h-3.5" />
          News Desk
          {activeCount > 0 && (
            <span className="text-[10px] font-body normal-case tracking-normal font-normal text-amber-400">
              {activeCount} active
            </span>
          )}
          {breakingCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-body normal-case tracking-normal font-normal text-on-air">
              <Flame className="w-2.5 h-2.5" />
              {breakingCount} breaking
            </span>
          )}
        </h2>
      </div>

      {/* Scan button + filters */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={handleScanAndProcess}
          disabled={scanning || processing || !!lockedOps?.scan || !!lockedOps?.process}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl 
            bg-violet-500/15 text-violet-400 border border-violet-500/20 hover:bg-violet-500/25
            disabled:opacity-40 disabled:cursor-not-allowed transition-all text-[10px] font-heading font-bold tracking-wide uppercase"
        >
          {scanning || processing || lockedOps?.scan || lockedOps?.process ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Search className="w-3 h-3" />
          )}
          {scanning || lockedOps?.scan ? "Scanning..." : processing || lockedOps?.process ? "Processing..." : "Scan News"}
        </button>

        <div className="flex-1" />

        {/* Filter pills */}
        <FilterPill active={filter === "all"} onClick={() => setFilter("all")} label="All" count={briefs.length} />
        <FilterPill active={filter === "active"} onClick={() => setFilter("active")} label="Active" count={activeCount} />
        <FilterPill active={filter === "sent"} onClick={() => setFilter("sent")} label="Sent" count={sentCount} />
        <FilterPill active={filter === "breaking"} onClick={() => setFilter("breaking")} label="Breaking" count={breakingCount} />
      </div>

      {/* Scan result banner */}
      {scanResult && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/15 text-[10px] text-violet-300">
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          Found {scanResult.found} candidates
          {scanResult.researched != null && scanResult.researched > 0 && (
            <span className="flex items-center gap-1 text-cyan-400">
              <Sparkles className="w-3 h-3" />
              {scanResult.researched} auto-researched
            </span>
          )}
          {scanResult.errors && scanResult.errors.length > 0 && (
            <span className="flex items-center gap-1 text-on-air">
              <AlertTriangle className="w-3 h-3" />
              {scanResult.errors.length} error{scanResult.errors.length !== 1 ? "s" : ""}
            </span>
          )}
          <button onClick={() => setScanResult(null)} className="ml-auto text-text-dim hover:text-text">&times;</button>
        </div>
      )}

      {/* Briefs list */}
      <div className="flex-1 overflow-y-auto space-y-2 no-scrollbar">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-text-dim">
            <Newspaper className="w-6 h-6 opacity-30" />
            <p className="text-[11px]">
              {briefs.length === 0
                ? "No news yet — click Scan News to fetch"
                : "No briefs match this filter"}
            </p>
          </div>
        ) : (
          filtered.map((brief) => (
            <BriefCard
              key={brief.id}
              brief={brief}
              expanded={expandedId === brief.id}
              onToggle={() => setExpandedId((prev) => (prev === brief.id ? null : brief.id))}
              onInject={(type: InjectType) => {
                onInjectNews(
                  type,
                  formatBriefForAir(brief),
                  brief.imageUrl,
                  brief.imageUrls,
                  brief.report?.turnPrompts
                );
                sendBrief(brief.id, type);
              }}
              onCreateBlock={() => {
                onCreateBlock?.({
                  briefId: brief.id,
                  headline: brief.headline,
                  summary: formatBriefForAir(brief),
                  imageUrls: brief.imageUrls ?? (brief.imageUrl ? [brief.imageUrl] : undefined),
                  turnPrompts: brief.report?.turnPrompts,
                });
              }}
              onConclude={() => concludeBrief(brief.id)}
              onResearch={() => handleResearch(brief.id)}
              isResearching={researchingId === brief.id}
              isPresenting={isPresenting}
              canInject={canInject ?? isPresenting}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Helpers ─── */

function formatBriefForAir(brief: EditorialBrief): string {
  const r = brief.report;
  if (!r || !r.broadcastSummary) {
    return `BREAKING NEWS: ${brief.headline}. ${brief.summary}`;
  }
  const parts = [`HEADLINE: ${brief.headline}`];
  parts.push(`\nCONTEXT: ${r.broadcastSummary}`);
  if (r.keyFindings.length > 0) {
    parts.push(`\nKEY DETAILS:\n${r.keyFindings.map((f) => `- ${f}`).join("\n")}`);
  }
  if (r.analysisAngles.length > 0) {
    parts.push(`\nANALYSIS ANGLES:\n${r.analysisAngles.map((a) => `- ${a}`).join("\n")}`);
  }
  if (r.relatedTopics.length > 0) {
    parts.push(`\nRELATED TOPICS: ${r.relatedTopics.join("; ")}`);
  }
  if (r.editorialNotes) {
    parts.push(`\nEDITORIAL NOTES: ${r.editorialNotes}`);
  }
  return parts.join("\n");
}

/* ─── Sub-components ─── */

function FilterPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded-lg text-[9px] font-heading font-bold tracking-wider uppercase transition-all ${
        active
          ? "bg-white/10 text-text border border-white/15"
          : "text-text-dim hover:text-text-muted border border-transparent"
      }`}
    >
      {label}
      {count > 0 && (
        <span className="ml-1 opacity-60">{count}</span>
      )}
    </button>
  );
}

function BriefCard({
  brief,
  expanded,
  onToggle,
  onInject,
  onCreateBlock,
  onConclude,
  onResearch,
  isResearching,
  isPresenting,
  canInject,
}: {
  brief: EditorialBrief;
  expanded: boolean;
  onToggle: () => void;
  onInject: (type: InjectType) => void;
  onCreateBlock: () => void;
  onConclude: () => void;
  onResearch: () => void;
  isResearching: boolean;
  isPresenting: boolean;
  canInject: boolean;
}) {
  const [injectType, setInjectType] = useState<InjectType>('breaking');
  const [showLog, setShowLog] = useState(false);
  const conf = CONFIDENCE_STYLES[brief.confidence];
  const ConfIcon = conf.icon;
  const timeAgo = getTimeAgo(brief.generatedAt);

  const isConcluded = brief.activityLog?.some((e) => e.action === "concluded") ?? false;
  const hasReport = !!brief.report?.broadcastSummary;
  const isEnriched = hasReport || (brief.activityLog?.some((e) => e.action === "enriched" || e.action === "researched") ?? false);
  const isSent = !!brief.sentAt;
  const wasUpdatedAfterSend = isSent && brief.lastUpdatedAt && brief.lastUpdatedAt > (brief.sentAt ?? 0);

  // Determine card visual state
  let cardBorder = "border-border bg-surface/80 hover:bg-surface";
  let headlineColor = "text-text";
  let statusBadge: React.ReactNode = null;

  if (isConcluded) {
    cardBorder = "opacity-30 border-border bg-surface/40";
    headlineColor = "text-text-dim";
    statusBadge = (
      <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-white/5 text-text-dim text-[9px] font-heading font-bold tracking-wider uppercase border border-white/10">
        <Ban className="w-2.5 h-2.5" />
        Concluded
      </span>
    );
  } else if (wasUpdatedAfterSend) {
    cardBorder = "border-cyan-500/25 bg-cyan-500/[0.04]";
    headlineColor = "text-text";
    statusBadge = (
      <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-cyan-500/15 text-cyan-400 text-[9px] font-heading font-bold tracking-wider uppercase border border-cyan-500/20">
        <RefreshCw className="w-2.5 h-2.5" />
        Updated {getTimeAgo(brief.lastUpdatedAt!)}
      </span>
    );
  } else if (isSent) {
    cardBorder = "opacity-50 border-live/15 bg-live/[0.02]";
    headlineColor = "text-text-muted";
    statusBadge = (
      <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-live/10 text-live text-[9px] font-heading font-bold tracking-wider uppercase border border-live/20">
        <Send className="w-2.5 h-2.5" />
        Sent{(brief.sentCount ?? 0) > 1 ? ` x${brief.sentCount}` : ""} {getTimeAgo(brief.sentAt!)}
      </span>
    );
  } else if (brief.isBreaking) {
    cardBorder = "border-on-air/25 bg-on-air/[0.04]";
  }

  return (
    <div className={`rounded-xl border transition-all ${cardBorder}`}>
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2.5 p-3 text-left"
      >
        {/* Priority indicator */}
        <div
          className={`shrink-0 w-1 rounded-full self-stretch ${
            isConcluded
              ? "bg-text-dim/20"
              : brief.priority >= 80
                ? "bg-on-air"
                : brief.priority >= 50
                  ? "bg-amber-400"
                  : "bg-text-dim/30"
          }`}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            {brief.isBreaking && !isConcluded && (
              <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-on-air/15 text-on-air text-[9px] font-heading font-bold tracking-wider uppercase">
                <Flame className="w-2.5 h-2.5" />
                Breaking
              </span>
            )}
            <span className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md ${conf.bg} ${conf.color} text-[9px] font-heading font-bold tracking-wider uppercase border ${conf.border}`}>
              <ConfIcon className="w-2.5 h-2.5" />
              {conf.label}
            </span>
            {statusBadge}
            {isEnriched && (
              <span className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9px] font-heading font-bold tracking-wider uppercase border ${
                hasReport
                  ? "bg-live/10 text-live border-live/15"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/15"
              }`} title={hasReport ? "Full report ready for broadcast" : "Enriched with full article data"}>
                <BookOpenCheck className="w-2.5 h-2.5" />
                {hasReport ? "Report" : "Enriched"}
              </span>
            )}
            <span className="text-[9px] text-text-dim ml-auto shrink-0">{timeAgo}</span>
          </div>
          <p className={`text-xs font-medium leading-snug ${headlineColor} line-clamp-2`}>
            {brief.headline}
          </p>
          {/* Compact source chips — always visible */}
          {brief.sources.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1">
              {brief.sources.map((src, i) => {
                const SrcIcon = SOURCE_ICON[src.type] ?? Globe;
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-0.5 text-[9px] text-text-dim"
                    title={src.url}
                  >
                    <SrcIcon className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate max-w-[120px]">{src.label}</span>
                  </span>
                );
              })}
              {(brief.imageUrls?.length ?? (brief.imageUrl ? 1 : 0)) > 0 && (
                <span className="flex items-center gap-0.5 ml-auto shrink-0">
                  <ImageIcon className="w-2.5 h-2.5 text-text-dim/50" />
                  {(brief.imageUrls?.length ?? 1) > 1 && (
                    <span className="text-[8px] text-text-dim/50">{brief.imageUrls!.length}</span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 self-center text-text-dim">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-2.5">
          {/* Images */}
          {(brief.imageUrls?.length ?? 0) > 0 ? (
            <div className={`ml-3.5 flex gap-1.5 overflow-x-auto no-scrollbar ${(brief.imageUrls?.length ?? 0) > 1 ? 'pb-1' : ''}`}>
              {brief.imageUrls!.map((url, i) => (
                <div key={i} className="relative shrink-0 rounded-lg overflow-hidden bg-black/20 border border-white/5">
                  <img
                    src={url}
                    alt={`${brief.headline} (${i + 1})`}
                    className={`${(brief.imageUrls?.length ?? 0) > 1 ? 'w-36 h-24' : 'w-full h-32'} object-cover`}
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
              ))}
              {(brief.imageUrls?.length ?? 0) > 1 && (
                <div className="absolute top-1.5 right-1.5">
                  <span className="text-[9px] text-white/60 bg-black/40 px-1 py-0.5 rounded">
                    {brief.imageUrls!.length} imgs
                  </span>
                </div>
              )}
            </div>
          ) : brief.imageUrl ? (
            <div className="relative ml-3.5 rounded-lg overflow-hidden bg-black/20 border border-white/5">
              <img
                src={brief.imageUrl}
                alt={brief.headline}
                className="w-full h-32 object-cover"
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="absolute top-1.5 right-1.5">
                <ImageIcon className="w-3 h-3 text-white/50" />
              </div>
            </div>
          ) : null}

          {/* Report or Summary */}
          {brief.report?.broadcastSummary ? (
            <ReportView report={brief.report} />
          ) : (
            <p className="text-[11px] text-text-muted leading-relaxed pl-3.5">
              {brief.summary}
            </p>
          )}

          {/* Sources */}
          {brief.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-3.5">
              {brief.sources.map((src, i) => {
                const SrcIcon = SOURCE_ICON[src.type] ?? Globe;
                const hasUrl = src.url && src.url.startsWith('http');
                if (hasUrl) {
                  return (
                    <a
                      key={i}
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/5 text-[9px] text-text-dim hover:text-text transition-colors"
                    >
                      <SrcIcon className="w-2.5 h-2.5" />
                      {src.label}
                      <ExternalLink className="w-2 h-2" />
                    </a>
                  );
                }
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/5 text-[9px] text-text-dim"
                  >
                    <SrcIcon className="w-2.5 h-2.5" />
                    {src.label}
                  </span>
                );
              })}
            </div>
          )}

          {/* Activity Log */}
          {brief.activityLog && brief.activityLog.length > 0 && (
            <div className="pl-3.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowLog((v) => !v);
                }}
                className="flex items-center gap-1 text-[9px] text-text-dim hover:text-text-muted transition-colors mb-1"
              >
                <History className="w-2.5 h-2.5" />
                Activity Log ({brief.activityLog.length})
                {showLog ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
              </button>
              {showLog && (
                <div className="space-y-0.5 mt-1 border-l border-white/5 pl-2 ml-0.5">
                  {[...brief.activityLog].reverse().map((entry, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[9px] text-text-dim/80">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ACTION_DOT_COLOR[entry.action] ?? 'bg-text-dim/30'}`} />
                      <span className="font-medium">{ACTION_LABELS[entry.action]}</span>
                      {entry.detail && <span className="truncate opacity-60">— {entry.detail}</span>}
                      <span className="ml-auto shrink-0 opacity-50">{getTimeAgo(entry.timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {!isConcluded && (
            <div className="flex items-center gap-2 pl-3.5 flex-wrap">
              <div className="flex items-center">
                <select
                  value={injectType}
                  onChange={(e) => setInjectType(e.target.value as InjectType)}
                  className={`appearance-none bg-surface border rounded-l-xl px-2 py-1.5 text-[10px] font-heading font-bold tracking-wide uppercase
                    focus:outline-none focus:ring-1 focus:ring-on-air/10 cursor-pointer transition-all
                    ${injectType === 'breaking'
                      ? 'text-on-air border-on-air/20'
                      : injectType === 'co-anchor'
                        ? 'text-amber-400 border-amber-500/20'
                        : 'text-live border-live/20'
                    }`}
                >
                  <option value="breaking">Breaking</option>
                  <option value="co-anchor">Co-Anchor</option>
                  <option value="soft">Soft Note</option>
                </select>
                <button
                  onClick={() => onInject(injectType)}
                  disabled={!isPresenting}
                  title={isPresenting && !canInject ? 'Requires an active topic block' : undefined}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-r-xl border border-l-0
                    disabled:opacity-30 disabled:cursor-not-allowed transition-all text-[10px] font-heading font-bold tracking-wide uppercase
                    ${injectType === 'breaking'
                      ? 'bg-on-air/15 text-on-air border-on-air/20 hover:bg-on-air/25'
                      : injectType === 'co-anchor'
                        ? 'bg-amber-500/15 text-amber-400 border-amber-500/20 hover:bg-amber-500/25'
                        : 'bg-live/15 text-live border-live/20 hover:bg-live/25'
                    }`}
                >
                  {injectType === 'breaking' ? <Zap className="w-3 h-3" /> 
                    : injectType === 'co-anchor' ? <Hand className="w-3 h-3" /> 
                    : <StickyNote className="w-3 h-3" />}
                  {isSent ? 'Re-Send' : 'Send'}
                </button>
              </div>
              <button
                onClick={onCreateBlock}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl 
                  bg-cyan-500/15 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/25
                  transition-all text-[10px] font-heading font-bold tracking-wide uppercase"
              >
                <CalendarPlus className="w-3 h-3" />
                Block
              </button>
              <button
                onClick={onResearch}
                disabled={isResearching}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl 
                  bg-violet-500/15 text-violet-400 border border-violet-500/20 hover:bg-violet-500/25
                  disabled:opacity-40 disabled:cursor-not-allowed transition-all text-[10px] font-heading font-bold tracking-wide uppercase"
              >
                {isResearching ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                {isResearching ? "Researching..." : "More Info"}
              </button>
              {isSent && (
                <button
                  onClick={onConclude}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl 
                    bg-white/5 text-text-dim border border-white/10 hover:bg-white/10
                    transition-all text-[10px] font-heading font-bold tracking-wide uppercase"
                >
                  <Ban className="w-3 h-3" />
                  Conclude
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<BriefAction, string> = {
  created: "Created",
  sent: "Sent to air",
  researched: "Researched",
  enriched: "Enriched",
  "report-ready": "Report ready",
  updated: "Updated",
  concluded: "Concluded",
};

const ACTION_DOT_COLOR: Record<BriefAction, string> = {
  created: "bg-violet-400",
  sent: "bg-live",
  researched: "bg-cyan-400",
  enriched: "bg-amber-400",
  "report-ready": "bg-live",
  updated: "bg-blue-400",
  concluded: "bg-text-dim/50",
};

function getTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ReportView({ report }: { report: EnrichmentReport }) {
  return (
    <div className="pl-3.5 space-y-2">
      {/* Broadcast Summary */}
      <p className="text-[11px] text-text-muted leading-relaxed">
        {report.broadcastSummary}
      </p>

      {/* Key Findings */}
      {report.keyFindings.length > 0 && (
        <div>
          <h4 className="text-[9px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1">Key Findings</h4>
          <ul className="space-y-0.5">
            {report.keyFindings.map((f, i) => (
              <li key={i} className="text-[10px] text-text-muted leading-snug flex gap-1.5">
                <span className="shrink-0 text-live/60 mt-0.5">&#8226;</span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Analysis Angles */}
      {report.analysisAngles.length > 0 && (
        <div>
          <h4 className="text-[9px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1">Analysis Angles</h4>
          <ul className="space-y-0.5">
            {report.analysisAngles.map((a, i) => (
              <li key={i} className="text-[10px] text-text-muted leading-snug flex gap-1.5">
                <span className="shrink-0 text-amber-400/60 mt-0.5">&#8226;</span>
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related Topics */}
      {report.relatedTopics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {report.relatedTopics.map((t, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded-md bg-white/5 text-[9px] text-text-dim border border-white/5">
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Editorial Notes */}
      {report.editorialNotes && (
        <p className="text-[10px] text-text-dim italic leading-snug border-l-2 border-amber-400/20 pl-2">
          {report.editorialNotes}
        </p>
      )}

      {/* Source coverage + follow-up indicator */}
      <div className="flex items-center gap-2 text-[9px] text-text-dim/60">
        <span>{report.sourcesWithContent}/{report.sourcesReviewed} sources had content</span>
        {report.needsFollowUp && (
          <span className="inline-flex items-center gap-0.5 text-amber-400/80">
            <Clock className="w-2.5 h-2.5" />
            Needs follow-up
          </span>
        )}
      </div>
    </div>
  );
}
