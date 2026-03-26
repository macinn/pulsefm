"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Radio,
  Square,
  Play,
  Users,
  Activity,
  RefreshCw,
  MessageSquare,
  AlertCircle,
  Mic,
  Wifi,
  WifiOff,
  Send,
  UserPlus,
  Zap,
  StickyNote,
  Hand,
  Music,
  Loader2,
  CheckCircle2,
  XCircle,
  Library,
  Headphones,
  Search,
  Clock,
  Pause,
  CalendarPlus,
  Trash2,
} from "lucide-react";
import {
  useTranscriptStream,
  type TranscriptEntry,
} from "@/hooks/use-transcript-stream";
import ScheduleTimeline from "@/components/admin/ScheduleTimeline";
import BlockEditor from "@/components/admin/BlockEditor";
import NewsPanel from "@/components/admin/NewsPanel";
import type { ScheduleBlock, TopicConfig, BlockConfig, BlockType } from "@/types/schedule";

import { getApiUrl } from "@/lib/config";

interface ServerStatus {
  presenting: boolean;
  listeners: number;
  activeBlockType?: string | null;
}

interface MusicLibraryEntry {
  filename: string;
  prompt: string;
  durationSeconds: number;
  createdAt: number;
  enhancedPrompt: string;
}

export default function AdminPage() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [injectText, setInjectText] = useState("");
  const [injectType, setInjectType] = useState<"breaking" | "co-anchor" | "soft">("breaking");
  const [sendingInject, setSendingInject] = useState(false);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicDuration, setMusicDuration] = useState(60);
  const [musicBpm, setMusicBpm] = useState(120);
  const [musicGenStatus, setMusicGenStatus] = useState<
    { status: "idle" } | { status: "generating"; prompt: string } | { status: "done"; filename: string; prompt: string; durationSeconds: number } | { status: "error"; error: string }
  >({ status: "idle" });
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [musicLibrary, setMusicLibrary] = useState<MusicLibraryEntry[]>([]);
  const [libPreviewFilename, setLibPreviewFilename] = useState<string | null>(null);
  const libAudioRef = useRef<HTMLAudioElement | null>(null);
  const [musicSearch, setMusicSearch] = useState("");
  const [editorBlock, setEditorBlock] = useState<ScheduleBlock | null | undefined>(undefined); // undefined=closed, null=new, ScheduleBlock=edit
  const [blockEditorInit, setBlockEditorInit] = useState<{ type?: BlockType; title?: string; startTime?: string; durationMinutes?: number; config?: BlockConfig } | undefined>(undefined);
  const [pendingBriefId, setPendingBriefId] = useState<string | null>(null);
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [opLocks, setOpLocks] = useState<Record<string, boolean>>({});
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const { entries, streaming, connected } = useTranscriptStream(
    undefined,
    true,
    useCallback((msg: Record<string, unknown>) => {
      if (msg.type === "schedule-update") {
        setScheduleRefreshKey((k) => k + 1);
      }
      if (typeof msg.serverTime === "number") {
        setClockOffset(msg.serverTime as number - Date.now());
      }
    }, []),
  );

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/radio/status`);
      const { presenting, listeners, activeBlockType, serverTime } = await res.json();
      setStatus({ presenting, listeners, activeBlockType });
      if (typeof serverTime === "number") {
        setClockOffset(serverTime - Date.now());
      }
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchMusicLibrary = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/radio/music/list`);
      const data = await res.json();
      if (Array.isArray(data)) setMusicLibrary(data);
    } catch { /* ignore */ }
  }, []);

  const fetchLocks = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/radio/locks`);
      const data = await res.json();
      setOpLocks(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    fetchLocks();
    const interval = setInterval(fetchLocks, 2000);
    return () => clearInterval(interval);
  }, [fetchLocks]);

  useEffect(() => { fetchMusicLibrary(); }, [fetchMusicLibrary]);

  useEffect(() => {
    if (musicGenStatus.status === "done") fetchMusicLibrary();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicGenStatus.status]);

  useEffect(() => {
    fetchStatus();
  }, [entries.length, fetchStatus]);

  useEffect(() => {
    if (autoScroll && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [entries, streaming, autoScroll]);

  async function action(endpoint: string, label: string) {
    setLoading(label);
    try {
      const res = await fetch(`${getApiUrl()}${endpoint}`, { method: "POST" });
      await res.json();
      await fetchStatus();
    } catch (err) {
      console.error(`[admin] ${label} failed:`, err);
    } finally {
      setLoading(null);
    }
  }

  const isOnline = status !== null;
  const isPresenting = status?.presenting ?? false;
  const nonInjectableBlocks = ['guest', 'music', 'rest'];
  const canInject = isPresenting && !nonInjectableBlocks.includes(status?.activeBlockType ?? '');

  // Poll music generation status while generating
  useEffect(() => {
    if (musicGenStatus.status !== "generating") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${getApiUrl()}/radio/music/status`);
        const data = await res.json();
        setMusicGenStatus(data);
        if (data.status !== "generating") clearInterval(interval);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [musicGenStatus.status]);

  async function handleGenerateMusic() {
    const prompt = musicPrompt.trim();
    if (!prompt) return;
    setMusicGenStatus({ status: "generating", prompt });
    try {
      await fetch(`${getApiUrl()}/radio/music/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, durationSeconds: musicDuration, bpm: musicBpm }),
      });
    } catch (err) {
      console.error("[admin] music generate failed:", err);
      setMusicGenStatus({ status: "error", error: String(err) });
    }
  }

  async function handlePlayTrack(filename: string) {
    try {
      await fetch(`${getApiUrl()}/radio/music/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
    } catch (err) {
      console.error("[admin] play track failed:", err);
    }
  }

  async function addTrackToTimeline(track: MusicLibraryEntry) {
    const date = new Date().toISOString().slice(0, 10);
    const durationMinutes = Math.max(1, Math.ceil(track.durationSeconds / 60));

    // Find the latest block end time to avoid overlap
    let startTime: string;
    try {
      const res = await fetch(`${getApiUrl()}/schedule/${date}`);
      const schedule = await res.json();
      const blocks: Array<{ startTime: string; durationMinutes: number }> = schedule?.blocks ?? [];
      if (blocks.length > 0) {
        // Find the latest end time among all blocks
        let latestEnd = 0;
        for (const b of blocks) {
          const [h, m] = b.startTime.split(":").map(Number);
          const endMin = h * 60 + m + b.durationMinutes;
          if (endMin > latestEnd) latestEnd = endMin;
        }
        // Also ensure we don't schedule in the past
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes() + 1;
        const start = Math.max(latestEnd, nowMin);
        const sh = Math.floor(start / 60) % 24;
        const sm = start % 60;
        startTime = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`;
      } else {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 1);
        startTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      }
    } catch {
      const now = new Date();
      now.setMinutes(now.getMinutes() + 1);
      startTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    }

    try {
      await fetch(`${getApiUrl()}/schedule/${date}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "music",
          title: track.prompt.slice(0, 50),
          startTime,
          durationMinutes,
          config: { playlist: [track.filename], label: track.prompt.slice(0, 50), loop: false },
        }),
      });
      setScheduleRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("[admin] add track to timeline failed:", err);
    }
  }

  async function handleBatchGenerate() {
    setBatchGenerating(true);
    try {
      const res = await fetch(`${getApiUrl()}/radio/music/generate-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 10 }),
      });
      if (!res.ok) {
        console.error("[admin] batch generate rejected:", await res.text());
        setBatchGenerating(false);
        return;
      }
      // Poll until done
      const poll = setInterval(async () => {
        try {
          const sr = await fetch(`${getApiUrl()}/radio/music/batch-status`);
          const data = await sr.json();
          if (!data.generating) {
            clearInterval(poll);
            setBatchGenerating(false);
            fetchMusicLibrary();
          }
        } catch { /* ignore */ }
      }, 5000);
    } catch (err) {
      console.error("[admin] batch generate failed:", err);
      setBatchGenerating(false);
    }
  }

  return (
    <div className="h-screen bg-base text-text font-body relative flex flex-col overflow-hidden">
      {/* Ambient background glow — station-colored */}
      <div className="pointer-events-none fixed inset-0">
        <div
          className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-120 h-120 rounded-full blur-[150px] animate-pulse-glow"
          style={{ backgroundColor: '#E54D2E0D' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full blur-[120px] animate-pulse-glow"
          style={{ backgroundColor: '#E54D2E08', animationDelay: "-2s" }}
        />
      </div>

      {/* Header */}
      <header className="relative z-20 shrink-0 glass border-b-0 border-t-0 border-x-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-on-air" strokeWidth={2.5} />
              <span className="font-accent text-xl tracking-tight">Pulse</span>
            </div>
            <div className="w-px h-5 bg-white/6" />
            <span className="font-heading text-[10px] font-bold tracking-[0.15em] uppercase text-text-muted">
              Control Room
            </span>

            {/* Live / Off Air badge */}
            {isPresenting ? (
              <div className="flex items-center gap-2 px-2.5 py-1 rounded-full border bg-on-air/15 border-on-air/30">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-on-air animate-pulse-live" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-on-air" />
                </span>
                <span className="font-heading text-[9px] font-bold tracking-[0.15em] uppercase text-on-air">
                  On Air
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-surface border border-border">
                <span className="w-1.5 h-1.5 rounded-full bg-text-dim" />
                <span className="font-heading text-[9px] font-bold tracking-[0.15em] uppercase text-text-dim">
                  Off Air
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Status pills */}
            <StatusPill
              icon={<Activity className="w-3 h-3" />}
              label={isOnline ? "Server" : "Offline"}
              active={isOnline}
            />
            <StatusPill
              icon={connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              label="WS"
              active={connected}
            />
            <StatusPill
              icon={<Users className="w-3 h-3" />}
              label={`${status?.listeners ?? 0}`}
              active
            />

            <div className="w-px h-5 bg-white/6" />

            {/* Controls */}
            <button
              onClick={() => action("/radio/start", "Start")}
              disabled={loading !== null || isPresenting}
              className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-live/15 text-live border border-live/20 
                hover:bg-live/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-heading font-bold tracking-wide uppercase"
            >
              <Play className="w-3 h-3" />
              Start
            </button>
            <button
              onClick={() => action("/radio/stop", "Stop")}
              disabled={loading !== null || !isPresenting}
              className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-on-air/15 text-on-air border border-on-air/20 
                hover:bg-on-air/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-heading font-bold tracking-wide uppercase"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
            <button
              onClick={fetchStatus}
              className="p-2 rounded-full glass hover:bg-white/5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-text-muted ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={isPresenting || resetting}
              className="p-2 rounded-full glass hover:bg-on-air/10 text-text-dim hover:text-on-air transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Reset all data"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Content — 3 column layout: Tools | News Desk | Live Feed */}
      <div className="relative z-10 flex-1 min-h-0 w-full max-w-[1600px] mx-auto px-4 sm:px-6 py-4 flex gap-4">

        {/* LEFT: Action Tools */}
        <div className="hidden lg:flex flex-col w-80 shrink-0 gap-4 min-h-0 overflow-y-auto no-scrollbar">
          {/* Inject Message Panel */}
          <Panel className="flex-1 min-h-0 flex flex-col">
              <PanelHeader
                icon={<Send className="w-3.5 h-3.5" />}
                title="Send to Pulse"
              />
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const text = injectText.trim();
                  if (!text || sendingInject) return;
                  setSendingInject(true);
                  try {
                    const res = await fetch(`${getApiUrl()}/radio/inject`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ type: injectType, text }),
                    });
                    if (res.ok) setInjectText("");
                  } catch (err) {
                    console.error("[admin] inject failed:", err);
                  } finally {
                    setSendingInject(false);
                  }
                }}
                className="space-y-2.5"
              >
                <div className="flex items-center gap-2">
                  <select
                    value={injectType}
                    onChange={(e) => setInjectType(e.target.value as "breaking" | "co-anchor" | "soft")}
                    disabled={!canInject}
                    className={`flex-1 appearance-none bg-surface border rounded-xl px-3 py-2 text-xs font-heading font-bold tracking-wide uppercase
                      focus:outline-none focus:ring-1 focus:ring-on-air/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer
                      ${injectType === "breaking"
                        ? "text-breaking border-breaking/25"
                        : injectType === "co-anchor"
                          ? "text-amber-400 border-amber-500/25"
                          : "text-live border-live/25"
                      }`}
                  >
                    <option value="breaking">Breaking</option>
                    <option value="co-anchor">Co-Anchor</option>
                    <option value="soft">Soft Note</option>
                  </select>
                  <div className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center border ${
                    injectType === "breaking"
                      ? "bg-breaking/15 text-breaking border-breaking/20"
                      : injectType === "co-anchor"
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                        : "bg-live/15 text-live border-live/20"
                  }`}>
                    {injectType === "breaking" ? <Zap className="w-3.5 h-3.5" /> : injectType === "co-anchor" ? <Hand className="w-3.5 h-3.5" /> : <StickyNote className="w-3.5 h-3.5" />}
                  </div>
                </div>

                <textarea
                  value={injectText}
                  onChange={(e) => setInjectText(e.target.value)}
                  placeholder={
                    injectType === "breaking"
                      ? "e.g. ElevenLabs just launched a new real-time voice cloning API"
                      : injectType === "co-anchor"
                        ? "e.g. I think there's another angle to this story worth exploring"
                        : "e.g. Send a shoutout to our listeners"
                  }
                  disabled={!canInject}
                  rows={8}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm text-text placeholder:text-text-dim 
                    focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 
                    disabled:opacity-30 disabled:cursor-not-allowed resize-none font-body"
                />

                <button
                  type="submit"
                  disabled={!injectText.trim() || !canInject || sendingInject}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl 
                    disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-heading font-bold tracking-wide uppercase
                    ${injectType === "breaking"
                      ? "bg-breaking/15 text-breaking border border-breaking/20 hover:bg-breaking/25"
                      : injectType === "co-anchor"
                        ? "bg-amber-500/15 text-amber-400 border border-amber-500/20 hover:bg-amber-500/25"
                        : "bg-live/15 text-live border border-live/20 hover:bg-live/25"
                    }`}
                >
                  <Send className="w-3 h-3" />
                  {sendingInject ? "Sending..." : injectType === "breaking" ? "Send Now" : injectType === "co-anchor" ? "Send Cue" : "Queue Note"}
                </button>
              </form>
            </Panel>

          {/* AI Music Generator Panel */}
          <Panel className="flex-1 min-h-0 flex flex-col">
              <PanelHeader
                icon={<Music className="w-3.5 h-3.5" />}
                title="AI Music Generator"
                badge={
                  musicGenStatus.status === "generating" ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-400 text-[10px] font-body normal-case tracking-normal font-normal">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      generating
                    </span>
                  ) : musicGenStatus.status === "done" ? (
                    <span className="inline-flex items-center gap-1.5 text-live text-[10px] font-body normal-case tracking-normal font-normal">
                      <CheckCircle2 className="w-3 h-3" />
                      ready
                    </span>
                  ) : null
                }
              />

              {musicGenStatus.status === "done" ? (
                <div className="space-y-2.5">
                  <div className="glass rounded-xl p-3">
                    <p className="text-sm font-medium text-live truncate">{musicGenStatus.prompt}</p>
                    <p className="text-[10px] text-text-dim mt-0.5">{musicGenStatus.durationSeconds}s — {musicGenStatus.filename}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (!previewAudioRef.current) {
                          previewAudioRef.current = new Audio(`${getApiUrl()}/radio/music/file/${musicGenStatus.filename}`);
                          previewAudioRef.current.onended = () => setPreviewPlaying(false);
                        }
                        if (previewPlaying) {
                          previewAudioRef.current.pause();
                          setPreviewPlaying(false);
                        } else {
                          previewAudioRef.current.play();
                          setPreviewPlaying(true);
                        }
                      }}
                      className="flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl
                        bg-surface text-text-muted border border-border hover:bg-white/5
                        transition-all text-xs font-heading font-bold tracking-wide uppercase flex-1"
                    >
                      {previewPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      {previewPlaying ? "Stop" : "Preview"}
                    </button>
                    <button
                      onClick={() => handlePlayTrack(musicGenStatus.filename)}
                      disabled={!isPresenting}
                      className="flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl 
                        bg-live/15 text-live border border-live/20 hover:bg-live/25
                        disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-heading font-bold tracking-wide uppercase flex-1"
                    >
                      <Mic className="w-3 h-3" />
                      On Air
                    </button>
                  </div>

                  <button
                    onClick={() => {
                      previewAudioRef.current?.pause();
                      previewAudioRef.current = null;
                      setPreviewPlaying(false);
                      setMusicGenStatus({ status: "idle" });
                      setMusicPrompt("");
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl 
                      bg-surface text-text-muted border border-border hover:bg-white/5
                      transition-all text-xs font-heading font-bold tracking-wide uppercase"
                  >
                    <Music className="w-3 h-3" />
                    New Track
                  </button>
                </div>
              ) : musicGenStatus.status === "generating" ? (
                <div className="space-y-2.5">
                  <div className="glass rounded-xl p-3">
                    <p className="text-sm text-amber-300 truncate">{musicGenStatus.prompt}</p>
                    <div className="mt-2 h-1 bg-surface rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400/50 rounded-full animate-pulse" style={{ width: "60%" }} />
                    </div>
                    <p className="text-[10px] text-text-dim mt-1.5">Generating with ElevenLabs Music API — this may take ~30 seconds</p>
                  </div>
                </div>
              ) : musicGenStatus.status === "error" ? (
                <div className="space-y-2.5">
                  <div className="glass rounded-xl p-3 border border-on-air/20">
                    <div className="flex items-center gap-2 text-on-air text-sm">
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">Generation failed</span>
                    </div>
                    <p className="text-[10px] text-text-dim mt-1 truncate">{musicGenStatus.error}</p>
                  </div>
                  <button
                    onClick={() => setMusicGenStatus({ status: "idle" })}
                    className="w-full flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl 
                      bg-surface text-text-muted border border-border hover:bg-white/5
                      transition-all text-xs font-heading font-bold tracking-wide uppercase"
                  >
                    Try Again
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <textarea
                    value={musicPrompt}
                    onChange={(e) => setMusicPrompt(e.target.value)}
                    placeholder='e.g. "Chill lo-fi hip hop with warm piano, vinyl crackle, and jazzy drums"'
                    rows={4}
                    className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm text-text placeholder:text-text-dim 
                      focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 resize-none font-body min-h-[60px]"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-text-dim font-heading tracking-wider uppercase mb-1 block">Duration (s)</label>
                      <input
                        type="number"
                        value={musicDuration}
                        onChange={(e) => setMusicDuration(Math.max(5, Math.min(120, Number(e.target.value))))}
                        min={5}
                        max={120}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm text-text 
                          focus:outline-none focus:border-border-strong font-body"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-text-dim font-heading tracking-wider uppercase mb-1 block">BPM</label>
                      <input
                        type="number"
                        value={musicBpm}
                        onChange={(e) => setMusicBpm(Math.max(40, Math.min(240, Number(e.target.value))))}
                        min={40}
                        max={240}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm text-text 
                          focus:outline-none focus:border-border-strong font-body"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleGenerateMusic}
                    disabled={!musicPrompt.trim()}
                    className="w-full flex items-center justify-center gap-2 px-4 py-1.5 rounded-xl 
                      bg-amber-500/15 text-amber-400 border border-amber-500/20 hover:bg-amber-500/25
                      disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-heading font-bold tracking-wide uppercase"
                  >
                    <Music className="w-3 h-3" />
                    Generate Track
                  </button>
                </div>
              )}
            </Panel>
        </div>

        {/* CENTER: News Desk — editorial workspace */}
        <div className="flex-1 min-h-0 min-w-0">
          <Panel className="h-full flex flex-col overflow-hidden">
            <NewsPanel
              isPresenting={isPresenting}
              canInject={canInject}
              lockedOps={opLocks}
              onInjectNews={async (type, text, imageUrl, imageUrls, turnPrompts) => {
                try {
                  await fetch(`${getApiUrl()}/radio/inject`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ type, text, imageUrl, turnPrompts }),
                  });
                  await fetchStatus();
                } catch (err) {
                  console.error("[admin] inject news failed:", err);
                }
              }}
              onCreateBlock={(brief) => {
                const now = new Date();
                const startTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                setBlockEditorInit({
                  type: "topic",
                  title: brief.headline,
                  startTime,
                  durationMinutes: 10,
                  config: {
                    description: `${brief.headline}. ${brief.summary}`,
                    imageUrls: brief.imageUrls,
                    turnPrompts: brief.turnPrompts,
                  } as TopicConfig,
                });
                setPendingBriefId(brief.briefId);
                setEditorBlock(null);
              }}
            />
          </Panel>
        </div>

        {/* RIGHT: Live Feed — monitoring */}
        <div className="hidden xl:flex flex-col w-72 shrink-0 gap-4 min-h-0">
          {/* Transcript */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-xs font-bold tracking-widest uppercase text-text-muted flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5" />
                Transcript
                {streaming && (
                  <span className="inline-flex items-center gap-1.5 text-on-air ml-1 normal-case tracking-normal font-body font-normal">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-on-air animate-pulse-live" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-on-air" />
                    </span>
                    live
                  </span>
                )}
              </h2>
              <label className="flex items-center gap-1.5 text-[9px] text-text-dim cursor-pointer select-none uppercase tracking-wider font-heading">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-border-strong bg-surface accent-on-air w-3 h-3"
                />
                Follow
              </label>
            </div>
            <div
              ref={transcriptRef}
              className="glass rounded-2xl p-3 flex-1 overflow-y-auto space-y-0.5 no-scrollbar"
            >
              {entries.length === 0 && !streaming && (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-text-dim">
                  <Radio className="w-6 h-6 opacity-30" />
                  <p className="text-[11px]">Start the radio to see transcript</p>
                </div>
              )}
              {entries.map((entry, i) => (
                <TranscriptLine key={`${entry.ts}-${i}`} entry={entry} />
              ))}
              {streaming && (
                <StreamingLine role={streaming.role} text={streaming.text} ts={streaming.startTs} />
              )}
            </div>
          </div>

          {/* Music Library */}
          <div className="shrink-0 flex flex-col" style={{ maxHeight: "40%" }}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-xs font-bold tracking-widest uppercase text-text-muted flex items-center gap-2">
                <Library className="w-3.5 h-3.5" />
                Music Library
                <span className="text-[10px] text-text-dim font-body normal-case tracking-normal font-normal">
                  {musicLibrary.length} track{musicLibrary.length !== 1 ? "s" : ""}
                </span>
              </h2>
              <button
                onClick={handleBatchGenerate}
                disabled={batchGenerating || !!opLocks['music-batch']}
                title="Generate 10 tracks"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-heading font-bold tracking-wider uppercase
                  bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20
                  disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {(batchGenerating || opLocks['music-batch']) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music className="w-3 h-3" />}
                {(batchGenerating || opLocks['music-batch']) ? "Generating..." : "Batch"}
              </button>
            </div>

            <div className="glass rounded-2xl flex-1 min-h-0 flex flex-col overflow-hidden">
              {/* Search */}
              <div className="p-3 pb-0">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim" />
                  <input
                    type="text"
                    value={musicSearch}
                    onChange={(e) => setMusicSearch(e.target.value)}
                    placeholder="Search tracks..."
                    className="w-full bg-surface border border-border rounded-lg pl-7 pr-3 py-1.5 text-xs text-text placeholder:text-text-dim
                      focus:outline-none focus:border-border-strong font-body"
                  />
                </div>
              </div>

              {/* Track list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5 no-scrollbar">
                {musicLibrary.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-text-dim">
                    <Music className="w-6 h-6 opacity-30" />
                    <p className="text-[11px]">No tracks yet</p>
                  </div>
                ) : (
                  musicLibrary
                    .filter((t) => !musicSearch || t.prompt.toLowerCase().includes(musicSearch.toLowerCase()))
                    .map((track) => {
                      const isActive = libPreviewFilename === track.filename;
                      return (
                        <div
                          key={track.filename}
                          className={`group rounded-xl p-2.5 transition-all cursor-default ${
                            isActive
                              ? "bg-amber-500/10 border border-amber-500/25"
                              : "hover:bg-white/[0.03] border border-transparent"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {/* Play/pause button */}
                            <button
                              onClick={() => {
                                if (isActive) {
                                  libAudioRef.current?.pause();
                                  libAudioRef.current = null;
                                  setLibPreviewFilename(null);
                                } else {
                                  libAudioRef.current?.pause();
                                  const audio = new Audio(`${getApiUrl()}/radio/music/file/${track.filename}`);
                                  audio.onended = () => setLibPreviewFilename(null);
                                  libAudioRef.current = audio;
                                  audio.play();
                                  setLibPreviewFilename(track.filename);
                                }
                              }}
                              className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                                isActive
                                  ? "bg-amber-500/20 text-amber-400"
                                  : "bg-white/[0.04] text-text-muted group-hover:bg-white/[0.08] group-hover:text-text"
                              }`}
                            >
                              {isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 ml-0.5" />}
                            </button>

                            {/* Track info */}
                            <div className="flex-1 min-w-0">
                              <p className={`text-[11px] font-medium leading-snug line-clamp-1 ${
                                isActive ? "text-amber-300" : "text-text"
                              }`}>
                                {track.prompt}
                              </p>
                              <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-text-dim">
                                <Clock className="w-2.5 h-2.5" />
                                {track.durationSeconds}s
                              </div>
                            </div>

                            {/* On Air */}
                            <button
                              onClick={() => handlePlayTrack(track.filename)}
                              disabled={!isPresenting}
                              title="Play on air"
                              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all
                                bg-live/10 text-live hover:bg-live/20
                                disabled:opacity-20 disabled:cursor-not-allowed"
                            >
                              <Mic className="w-2.5 h-2.5" />
                            </button>

                            {/* Add to Timeline */}
                            <button
                              onClick={() => addTrackToTimeline(track)}
                              title="Add to timeline"
                              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all
                                bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                            >
                              <CalendarPlus className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline dock */}
      <div className="relative z-20 shrink-0 glass-strong border-t border-border-strong">
        <ScheduleTimeline
          onEditBlock={(block) => setEditorBlock(block)}
          onAddBlock={() => setEditorBlock(null)}
          refreshKey={scheduleRefreshKey}
          isPresenting={isPresenting}
          lockedOps={opLocks}
          clockOffset={clockOffset}
        />
      </div>

      {/* Block Editor Modal */}
      {editorBlock !== undefined && (
        <BlockEditor
          date={new Date().toISOString().slice(0, 10)}
          block={editorBlock}
          readOnly={editorBlock !== null && editorBlock.status !== "pending"}
          initialValues={blockEditorInit}
          onClose={() => { setEditorBlock(undefined); setBlockEditorInit(undefined); setPendingBriefId(null); }}
          onSaved={() => {
            setScheduleRefreshKey((k) => k + 1);
            if (pendingBriefId) {
              fetch(`${getApiUrl()}/news/pulse-ai/briefs/${pendingBriefId}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ method: "block" }),
              }).catch((err) => console.error("[admin] mark brief sent failed:", err));
              setPendingBriefId(null);
            }
          }}
        />
      )}

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-base/70 backdrop-blur-sm" onClick={() => !resetting && setShowResetConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm glass-strong rounded-2xl p-6 animate-fade-in-up">
            <div className="text-center mb-5">
              <div className="w-12 h-12 rounded-full bg-on-air/10 flex items-center justify-center mx-auto mb-3">
                <Trash2 className="w-5 h-5 text-on-air" />
              </div>
              <h3 className="font-heading text-lg font-bold tracking-tight">Reset all data?</h3>
              <p className="font-body text-sm text-text-muted mt-2">
                This will delete all schedules, news briefs, candidates, embeddings, daily memory and operation locks. Music library will be preserved. This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
                className="flex-1 px-4 py-2.5 rounded-xl glass text-text-muted font-heading text-xs font-bold tracking-wider uppercase hover:bg-white/5 transition-all disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setResetting(true);
                  try {
                    const res = await fetch(`${getApiUrl()}/radio/reset`, { method: "POST" });
                    if (res.ok) {
                      setScheduleRefreshKey((k) => k + 1);
                      await fetchStatus();
                    }
                  } catch (err) {
                    console.error("[admin] reset failed:", err);
                  } finally {
                    setResetting(false);
                    setShowResetConfirm(false);
                  }
                }}
                disabled={resetting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-on-air text-white font-heading text-xs font-bold tracking-wider uppercase hover:brightness-110 transition-all disabled:opacity-60"
              >
                {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {resetting ? "Resetting..." : "Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ─── */

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`glass rounded-2xl p-4 ${className}`}>
      {children}
    </div>
  );
}

function PanelHeader({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: React.ReactNode }) {
  return (
    <h2 className="font-heading text-xs font-bold tracking-widest uppercase text-text-muted flex items-center gap-2 mb-3">
      {icon}
      {title}
      {badge}
    </h2>
  );
}

function TypeToggle({
  active,
  onClick,
  disabled,
  icon,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  color: "breaking" | "live" | "amber";
}) {
  const colors = {
    breaking: active
      ? "bg-breaking/15 text-breaking border-breaking/30"
      : "bg-surface text-text-dim border-border hover:text-breaking/70 hover:border-breaking/15",
    live: active
      ? "bg-live/15 text-live border-live/30"
      : "bg-surface text-text-dim border-border hover:text-live/70 hover:border-live/15",
    amber: active
      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
      : "bg-surface text-text-dim border-border hover:text-amber-400/70 hover:border-amber-500/15",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-heading font-bold tracking-wide uppercase 
        transition-all disabled:opacity-30 disabled:cursor-not-allowed ${colors[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}

function AdminInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text placeholder:text-text-dim 
        focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 
        disabled:opacity-30 disabled:cursor-not-allowed font-body"
    />
  );
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString();

  if (entry.role === "system") {
    return (
      <div className="flex items-start gap-2.5 text-xs text-breaking/70 py-1.5 px-2 rounded-lg">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          <span className="text-text-dim mr-2">{time}</span>
          {entry.text}
        </span>
      </div>
    );
  }

  const isPulse = entry.role === "pulse";
  const isGuest = entry.role === "guest";
  const isProducer = entry.role === "producer";
  const isCohost = entry.role === "cohost";

  return (
    <div className={`flex items-start gap-2.5 text-sm py-1.5 px-2 rounded-lg transition-colors hover:bg-white/2 ${
      isPulse ? "text-text" : isGuest ? "text-violet-300" : isProducer ? "text-amber-300" : isCohost ? "text-emerald-300" : "text-blue-300"
    }`}>
      <RoleAvatar role={entry.role} />
      <div className="min-w-0">
        <span className="text-text-dim text-[10px] mr-2 font-heading tracking-wider uppercase">
          {time}
        </span>
        <span className="leading-relaxed">{entry.text}</span>
      </div>
    </div>
  );
}

function StreamingLine({ role, text, ts }: { role: "pulse" | "caller" | "guest" | "cohost" | "producer"; text: string; ts: number }) {
  const time = new Date(ts).toLocaleTimeString();

  return (
    <div className={`flex items-start gap-2.5 text-sm py-1.5 px-2 rounded-lg ${
      role === "pulse" ? "text-text" : role === "guest" ? "text-violet-300" : role === "producer" ? "text-amber-300" : role === "cohost" ? "text-emerald-300" : "text-blue-300"
    }`}>
      <RoleAvatar role={role} />
      <div className="min-w-0">
        <span className="text-text-dim text-[10px] mr-2 font-heading tracking-wider uppercase">
          {time}
        </span>
        <span className="leading-relaxed">{text}</span>
        <span className="inline-block w-1.5 h-4 ml-0.5 bg-on-air animate-pulse rounded-sm opacity-60" />
      </div>
    </div>
  );
}

function RoleAvatar({ role }: { role: "pulse" | "caller" | "guest" | "cohost" | "producer" }) {
  if (role === "guest") {
    return (
      <div className="mt-0.5 shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-violet-500/15 text-violet-400 border border-violet-500/20">
        <UserPlus className="w-3 h-3" />
      </div>
    );
  }
  if (role === "cohost") {
    return (
      <div className="mt-0.5 shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
        <Mic className="w-3 h-3" />
      </div>
    );
  }
  if (role === "producer") {
    return (
      <div className="mt-0.5 shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-amber-500/15 text-amber-400 border border-amber-500/20">
        <Hand className="w-3 h-3" />
      </div>
    );
  }
  const isPulse = role === "pulse";
  return (
    <div className={`mt-0.5 shrink-0 w-6 h-6 rounded-full flex items-center justify-center border ${
      isPulse
        ? "bg-on-air/15 text-on-air border-on-air/20"
        : "bg-blue-500/15 text-blue-400 border-blue-500/20"
    }`}>
      {isPulse ? <Radio className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
    </div>
  );
}

function StatusPill({
  icon,
  label,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-heading font-bold tracking-wider uppercase transition-colors ${
      active
        ? "bg-live/10 text-live border-live/20"
        : "bg-surface text-text-dim border-border"
    }`}>
      {icon}
      {label}
    </div>
  );
}
