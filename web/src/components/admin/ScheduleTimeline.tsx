"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Radio,
  UserPlus,
  Music,
  Coffee,
  Phone,
  Play,
  Trash2,
  Pencil,
  Plus,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Locate,
  Wand2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type {
  ScheduleBlock,
  DaySchedule,
  BlockType,
  BlockStatus,
} from "@/types/schedule";
import * as scheduleService from "@/services/schedule-service";

const DEFAULT_PX_PER_MIN = 4;
const MIN_PX_PER_MIN = 1;
const MAX_PX_PER_MIN = 12;
const TOTAL_MINUTES = 24 * 60;
const RULER_H = 28;
const TRACK_H = 72;

const MAX_DURATION: Record<BlockType, number> = {
  topic: 15,
  guest: 15,
  music: 300,
  break: 300,
  calls: 30,
};
const MIN_DURATION = 1;

const BLOCK_ICONS: Record<BlockType, typeof Radio> = {
  topic: Radio,
  guest: UserPlus,
  music: Music,
  break: Coffee,
  calls: Phone,
};

const BLOCK_STYLES: Record<
  BlockType,
  { bg: string; border: string; accent: string; text: string }
> = {
  topic: {
    bg: "rgba(229,77,46,0.12)",
    border: "rgba(229,77,46,0.25)",
    accent: "#E54D2E",
    text: "text-on-air",
  },
  guest: {
    bg: "rgba(139,92,246,0.12)",
    border: "rgba(139,92,246,0.25)",
    accent: "#8B5CF6",
    text: "text-violet-400",
  },
  music: {
    bg: "rgba(48,164,108,0.12)",
    border: "rgba(48,164,108,0.25)",
    accent: "#30A46C",
    text: "text-live",
  },
  break: {
    bg: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.06)",
    accent: "#57534E",
    text: "text-text-dim",
  },
  calls: {
    bg: "rgba(56,189,248,0.12)",
    border: "rgba(56,189,248,0.25)",
    accent: "#38BDF8",
    text: "text-sky-400",
  },
};

const STATUS_OPACITY: Record<BlockStatus, number> = {
  pending: 1,
  active: 1,
  completed: 0.35,
  skipped: 0.2,
};

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function shiftDate(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00");
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
}

function getCurrentMinutesFrac(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function snapTo5Min(min: number): number {
  return Math.round(min / 5) * 5;
}

function minToTime(min: number): string {
  const clamped = Math.max(0, Math.min(TOTAL_MINUTES - 1, min));
  const h = Math.floor(clamped / 60);
  const m = Math.round(clamped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

interface ScheduleTimelineProps {
  onEditBlock: (block: ScheduleBlock | null) => void;
  onAddBlock: () => void;
  refreshKey?: number;
  isPresenting: boolean;
  lockedOps?: Record<string, boolean>;
}

export default function ScheduleTimeline({
  onEditBlock,
  onAddBlock,
  refreshKey,
  isPresenting,
  lockedOps,
}: ScheduleTimelineProps) {
  const [date, setDate] = useState(todayDate);
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [pxPerMin, setPxPerMin] = useState(DEFAULT_PX_PER_MIN);
  const [nowMin, setNowMin] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoScroll = useRef(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragLeft, setDragLeft] = useState(0);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const dragLeftRef = useRef(0);
  const dragMeta = useRef({ mouseX: 0, blockLeft: 0, moved: false });
  const [resizeBlockId, setResizeBlockId] = useState<string | null>(null);
  const [resizeWidth, setResizeWidth] = useState(0);
  const resizeWidthRef = useRef(0);
  const resizeMeta = useRef({ mouseX: 0, origWidth: 0, blockType: "topic" as BlockType, moved: false });
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  const isToday = date === todayDate();
  const totalWidth = TOTAL_MINUTES * pxPerMin;

  // Fetch schedule
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    scheduleService
      .fetchSchedule(date)
      .then((s) => {
        if (!cancelled) {
          setSchedule(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSchedule({ date, blocks: [] });
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [date, refreshKey]);

  // Smooth playhead: update every second (set initial value on mount to avoid hydration mismatch)
  useEffect(() => {
    setNowMin(getCurrentMinutesFrac());
    const i = setInterval(() => setNowMin(getCurrentMinutesFrac()), 1000);
    return () => clearInterval(i);
  }, []);

  const blocks = useMemo(
    () =>
      (schedule?.blocks ?? []).sort((a, b) =>
        a.startTime.localeCompare(b.startTime)
      ),
    [schedule]
  );

  // Auto-scroll to playhead or first block on load
  useEffect(() => {
    if (didAutoScroll.current || !scrollRef.current || !schedule) return;
    didAutoScroll.current = true;
    const target = isToday
      ? nowMin * pxPerMin
      : blocks.length > 0
        ? timeToMin(blocks[0].startTime) * pxPerMin
        : 8 * 60 * pxPerMin;
    const containerW = scrollRef.current.clientWidth;
    scrollRef.current.scrollTo({
      left: target - containerW / 3,
      behavior: "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  // Auto-follow playhead
  useEffect(() => {
    if (!autoFollow || !isToday || !scrollRef.current) return;
    const el = scrollRef.current;
    const phX = nowMin * pxPerMin;
    const visibleLeft = el.scrollLeft;
    const visibleRight = el.scrollLeft + el.clientWidth;
    const margin = el.clientWidth * 0.15;
    if (phX < visibleLeft + margin || phX > visibleRight - margin) {
      el.scrollTo({ left: phX - el.clientWidth / 3, behavior: "smooth" });
    }
  }, [nowMin, autoFollow, isToday, pxPerMin]);

  // WS block updates
  const applyBlockUpdate = useCallback((block: ScheduleBlock) => {
    setSchedule((prev) => {
      if (!prev) return prev;
      const idx = prev.blocks.findIndex((b) => b.id === block.id);
      if (idx === -1)
        return {
          ...prev,
          blocks: [...prev.blocks, block].sort((a, b) =>
            a.startTime.localeCompare(b.startTime)
          ),
        };
      const updated = [...prev.blocks];
      updated[idx] = block;
      return { ...prev, blocks: updated };
    });
  }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__scheduleUpdate =
      applyBlockUpdate;
    return () => {
      delete (window as unknown as Record<string, unknown>).__scheduleUpdate;
    };
  });

  // Actions
  async function handleExecute(blockId: string) {
    try {
      await scheduleService.executeBlock(date, blockId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to execute block';
      showToast(msg);
    }
  }

  async function handleDelete(blockId: string) {
    try {
      await scheduleService.deleteBlock(date, blockId);
      setSchedule((p) =>
        p ? { ...p, blocks: p.blocks.filter((b) => b.id !== blockId) } : p
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete block';
      showToast(msg);
    }
  }

  // Drag-and-drop for pending blocks
  function startDrag(e: React.PointerEvent, block: ScheduleBlock) {
    if (block.status !== "pending") return;
    if ((e.target as HTMLElement).closest("[data-block-actions]")) return;
    e.preventDefault();
    const left = timeToMin(block.startTime) * pxPerMin;
    dragMeta.current = { mouseX: e.clientX, blockLeft: left, moved: false };
    dragLeftRef.current = left;
    setDragBlockId(block.id);
    setDragLeft(left);
  }

  useEffect(() => {
    if (!dragBlockId) return;
    function onMove(e: PointerEvent) {
      const m = dragMeta.current;
      if (!scrollRef.current) return;
      const dx = e.clientX - m.mouseX;
      if (Math.abs(dx) > 4) m.moved = true;
      const minLeft = isToday ? Math.ceil(getCurrentMinutesFrac()) * pxPerMin : 0;
      const newLeft = Math.max(minLeft, Math.min(totalWidth - 28, m.blockLeft + dx));
      dragLeftRef.current = newLeft;
      setDragLeft(newLeft);
      const rect = scrollRef.current.getBoundingClientRect();
      if (e.clientX < rect.left + 60) {
        scrollRef.current.scrollLeft -= 8;
        m.blockLeft -= 8;
      } else if (e.clientX > rect.right - 60) {
        scrollRef.current.scrollLeft += 8;
        m.blockLeft += 8;
      }
    }
    function onUp() {
      const m = dragMeta.current;
      if (m.moved) {
        const finalLeft = dragLeftRef.current;
        const minMin = isToday ? Math.ceil(getCurrentMinutesFrac()) : 0;
        const newMin = Math.max(minMin, snapTo5Min(finalLeft / pxPerMin));
        const newTime = minToTime(newMin);
        scheduleService
          .updateBlock(date, dragBlockId!, { startTime: newTime })
          .then((u) => applyBlockUpdate(u))
          .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to move block'));
      }
      setDragBlockId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragBlockId, pxPerMin, totalWidth, date, applyBlockUpdate]);

  // Resize for pending blocks
  function startResize(e: React.PointerEvent, block: ScheduleBlock) {
    if (block.status !== "pending") return;
    e.preventDefault();
    e.stopPropagation();
    const curWidth = block.durationMinutes * pxPerMin;
    resizeMeta.current = { mouseX: e.clientX, origWidth: curWidth, blockType: block.type, moved: false };
    resizeWidthRef.current = curWidth;
    setResizeBlockId(block.id);
    setResizeWidth(curWidth);
  }

  useEffect(() => {
    if (!resizeBlockId) return;
    function onMove(e: PointerEvent) {
      const m = resizeMeta.current;
      if (!scrollRef.current) return;
      const dx = e.clientX - m.mouseX;
      if (Math.abs(dx) > 2) m.moved = true;
      const maxW = MAX_DURATION[m.blockType] * pxPerMin;
      const minW = MIN_DURATION * pxPerMin;
      const newW = Math.max(minW, Math.min(maxW, m.origWidth + dx));
      resizeWidthRef.current = newW;
      setResizeWidth(newW);
      const rect = scrollRef.current.getBoundingClientRect();
      if (e.clientX > rect.right - 60) {
        scrollRef.current.scrollLeft += 8;
      }
    }
    function onUp() {
      const m = resizeMeta.current;
      if (m.moved) {
        const newMin = Math.max(MIN_DURATION, snapTo5Min(resizeWidthRef.current / pxPerMin) || 1);
        scheduleService
          .updateBlock(date, resizeBlockId!, { durationMinutes: newMin })
          .then((u) => applyBlockUpdate(u))
          .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to resize block'));
      }
      setResizeBlockId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeBlockId, pxPerMin, date, applyBlockUpdate]);

  function zoom(delta: number) {
    setPxPerMin((p) => {
      const next = Math.min(
        MAX_PX_PER_MIN,
        Math.max(MIN_PX_PER_MIN, p + delta)
      );
      if (scrollRef.current) {
        const center =
          scrollRef.current.scrollLeft + scrollRef.current.clientWidth / 2;
        const ratio = center / (TOTAL_MINUTES * p);
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollLeft =
              ratio * TOTAL_MINUTES * next - scrollRef.current.clientWidth / 2;
          }
        });
      }
      return next;
    });
  }

  async function handleAutoGenerate() {
    if (autoGenerating) return;
    setAutoGenerating(true);
    try {
      const result = await scheduleService.autoGenerate(date, { scanFirst: true });
      if (result.blocksCreated > 0) {
        const s = await scheduleService.fetchSchedule(date);
        setSchedule(s);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Auto-generate failed');
    } finally {
      setAutoGenerating(false);
    }
  }

  const selectedBlock = useMemo(
    () => blocks.find((b) => b.id === selectedBlockId) ?? null,
    [blocks, selectedBlockId]
  );

  const playheadX = nowMin * pxPerMin;

  // Pre-compute hour markers + ticks (memoized by zoom)
  const rulerMarkers = useMemo(() => {
    const els: React.ReactNode[] = [];
    for (let h = 0; h <= 24; h++) {
      const x = h * 60 * pxPerMin;
      els.push(
        <div
          key={`h-${h}`}
          className="absolute top-0"
          style={{ left: x, height: RULER_H }}
        >
          <div className="w-px h-full bg-white/8" />
          {h < 24 && (
            <span className="absolute top-1 left-1.5 text-[9px] font-heading text-text-dim select-none whitespace-nowrap">
              {formatHour(h)}
            </span>
          )}
        </div>
      );
    }
    for (let i = 0; i < 24 * 4; i++) {
      const min = i * 15;
      if (min % 60 === 0) continue;
      els.push(
        <div
          key={`t-${i}`}
          className="absolute w-px bg-white/4"
          style={{ left: min * pxPerMin, top: RULER_H - 8, height: 8 }}
        />
      );
    }
    return els;
  }, [pxPerMin]);

  const gridLines = useMemo(
    () =>
      Array.from({ length: 25 }, (_, h) => (
        <div
          key={`g-${h}`}
          className="absolute top-0 w-px bg-white/3"
          style={{ left: h * 60 * pxPerMin, height: TRACK_H }}
        />
      )),
    [pxPerMin]
  );

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-heading text-[10px] font-bold tracking-widest uppercase text-text-muted">
            Timeline
          </span>
          {isToday && (
            <span className="flex items-center gap-1.5 text-[10px] font-heading font-bold tracking-wider uppercase text-on-air">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-on-air animate-pulse-live" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-on-air" />
              </span>
              Live
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setDate((d) => shiftDate(d, -1));
              didAutoScroll.current = false;
            }}
            className="p-1 rounded hover:bg-white/5 text-text-dim transition-colors"
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
          <button
            onClick={() => {
              setDate(todayDate());
              didAutoScroll.current = false;
            }}
            className="px-2 py-0.5 rounded hover:bg-white/5 text-[10px] font-heading font-bold tracking-wider uppercase text-text-muted"
          >
            {formatDate(date)}
          </button>
          <button
            onClick={() => {
              setDate((d) => shiftDate(d, 1));
              didAutoScroll.current = false;
            }}
            className="p-1 rounded hover:bg-white/5 text-text-dim transition-colors"
          >
            <ChevronRight className="w-3 h-3" />
          </button>

          <div className="w-px h-4 bg-border mx-1" />

          <button
            onClick={() => zoom(-1)}
            disabled={pxPerMin <= MIN_PX_PER_MIN}
            className="p-1 rounded hover:bg-white/5 text-text-dim disabled:opacity-20 transition-colors"
          >
            <ZoomOut className="w-3 h-3" />
          </button>
          <span className="text-[9px] text-text-dim font-heading w-6 text-center">
            {pxPerMin}x
          </span>
          <button
            onClick={() => zoom(1)}
            disabled={pxPerMin >= MAX_PX_PER_MIN}
            className="p-1 rounded hover:bg-white/5 text-text-dim disabled:opacity-20 transition-colors"
          >
            <ZoomIn className="w-3 h-3" />
          </button>

          {isToday && (
            <button
              onClick={() => {
                const next = !autoFollow;
                setAutoFollow(next);
                if (next && scrollRef.current) {
                  scrollRef.current.scrollTo({
                    left: nowMin * pxPerMin - scrollRef.current.clientWidth / 3,
                    behavior: "smooth",
                  });
                }
              }}
              className={`p-1 rounded transition-colors ${autoFollow ? "text-on-air bg-on-air/10" : "text-text-dim hover:bg-white/5"}`}
              title={autoFollow ? "Auto-follow: on" : "Auto-follow: off"}
            >
              <Locate className="w-3 h-3" />
            </button>
          )}

          <div className="w-px h-4 bg-border mx-1" />

          <button
            onClick={onAddBlock}
            disabled={!!lockedOps?.['auto-generate']}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-on-air/10 text-on-air border border-on-air/20 hover:bg-on-air/20 disabled:opacity-50 disabled:cursor-not-allowed text-[10px] font-heading font-bold tracking-wide uppercase transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>

          <button
            onClick={handleAutoGenerate}
            disabled={autoGenerating || !!lockedOps?.['auto-generate']}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 disabled:opacity-50 text-[10px] font-heading font-bold tracking-wide uppercase transition-colors"
            title="Auto-generate schedule (scans for news first)"
          >
            {(autoGenerating || lockedOps?.['auto-generate']) ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Wand2 className="w-3 h-3" />
            )}
            {(autoGenerating || lockedOps?.['auto-generate']) ? "Generating..." : "Auto"}
          </button>
        </div>
      </div>

      {/* Selected block detail strip */}
      {selectedBlock && (() => {
        const sb = selectedBlock;
        const sStyle = BLOCK_STYLES[sb.type];
        const SIcon = BLOCK_ICONS[sb.type];
        return (
          <div className="flex items-center gap-3 px-4 py-1.5 border-t border-white/4 bg-white/2">
            <SIcon className={`w-3.5 h-3.5 shrink-0 ${sStyle.text}`} />
            <span className="text-[11px] font-medium text-text truncate max-w-48">{sb.title}</span>
            <span className="text-[10px] text-text-dim">{sb.startTime} &middot; {sb.durationMinutes}m</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-heading font-bold uppercase tracking-wider ${
              sb.status === "active" ? "bg-live/15 text-live" :
              sb.status === "completed" ? "bg-white/5 text-text-dim" :
              sb.status === "skipped" ? "bg-breaking/15 text-breaking" :
              "bg-white/5 text-text-muted"
            }`}>{sb.status}</span>
            <div className="ml-auto flex items-center gap-1">
              {sb.status === "pending" && (
                <>
                  {isPresenting && (
                    <button onClick={() => handleExecute(sb.id)} title="Play now" className="p-1.5 rounded hover:bg-white/10 text-live transition-colors">
                      <Play className="w-3 h-3" />
                    </button>
                  )}
                  <button onClick={() => onEditBlock(sb)} title="Edit" className="p-1.5 rounded hover:bg-white/10 text-text-muted transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button onClick={() => { handleDelete(sb.id); setSelectedBlockId(null); }} title="Delete" className="p-1.5 rounded hover:bg-white/10 text-on-air/60 transition-colors">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
              {sb.status !== "pending" && (
                <button onClick={() => onEditBlock(sb)} title="View details" className="p-1.5 rounded hover:bg-white/10 text-text-muted transition-colors">
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Scrollable timeline */}
      <div className="relative">
      <div
        ref={scrollRef}
        className="overflow-x-auto no-scrollbar relative cursor-default"
        style={{ height: RULER_H + TRACK_H }}
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-timeline-bg]")) {
            setSelectedBlockId(null);
          }
        }}
      >
        <div
          className="relative"
          style={{ width: totalWidth, height: RULER_H + TRACK_H }}
        >
          {/* Time ruler */}
          <div
            className="absolute top-0 left-0 right-0 border-b border-white/4"
            style={{ height: RULER_H }}
          >
            {rulerMarkers}
          </div>

          {/* Track area */}
          <div
            className="absolute left-0 right-0"
            style={{ top: RULER_H, height: TRACK_H }}
          >
            {gridLines}

            {blocks.map((block) => {
              const baseLeft = timeToMin(block.startTime) * pxPerMin;
              const baseWidth = block.durationMinutes * pxPerMin;
              const style = BLOCK_STYLES[block.type];
              const Icon = BLOCK_ICONS[block.type];
              const isPending = block.status === "pending";
              const isActive = block.status === "active";
              const opacity = STATUS_OPACITY[block.status];
              const isDragging = dragBlockId === block.id;
              const isResizing = resizeBlockId === block.id;
              const isSelected = selectedBlockId === block.id;
              const blockLeft = isDragging ? dragLeft : baseLeft;
              const width = isResizing ? resizeWidth : baseWidth;

              let progress = 0;
              if (isActive && isToday) {
                const startMin = timeToMin(block.startTime);
                progress = Math.min(
                  1,
                  Math.max(0, (nowMin - startMin) / block.durationMinutes)
                );
              }

              const dragTime = isDragging
                ? minToTime(snapTo5Min(dragLeft / pxPerMin))
                : null;
              const resizeDur = isResizing
                ? Math.max(MIN_DURATION, snapTo5Min(resizeWidth / pxPerMin) || 1)
                : null;

              return (
                <div
                  key={block.id}
                  className={`group absolute rounded-md overflow-visible ${
                    isDragging
                      ? "z-30 cursor-grabbing select-none"
                      : isResizing
                        ? "z-30 select-none"
                        : isPending
                          ? "cursor-grab hover:brightness-125 active:cursor-grabbing transition-all"
                          : "cursor-default transition-all"
                  }`}
                  style={{
                    left: blockLeft,
                    width,
                    top: isDragging ? 4 : 8,
                    height: isDragging ? TRACK_H - 8 : TRACK_H - 16,
                    background: style.bg,
                    borderWidth: 1,
                    borderColor: isDragging ? style.accent : isSelected ? style.accent : style.border,
                    opacity: isDragging ? 0.95 : opacity,
                    boxShadow: isDragging
                      ? `0 4px 24px ${style.accent}55, 0 0 0 1px ${style.accent}40`
                      : isResizing
                        ? `0 4px 24px ${style.accent}55, 0 0 0 1px ${style.accent}40`
                        : isSelected
                          ? `0 0 0 1px ${style.accent}55, 0 0 8px ${style.accent}22`
                          : isActive
                          ? `0 0 12px ${style.accent}33, 0 0 4px ${style.accent}22`
                          : undefined,
                    transform: isDragging ? "scale(1.03)" : undefined,
                    transformOrigin: "center center",
                  }}
                  onClick={() => {
                    if (dragMeta.current.moved || resizeMeta.current.moved) {
                      dragMeta.current.moved = false;
                      resizeMeta.current.moved = false;
                      return;
                    }
                    setSelectedBlockId((prev) => prev === block.id ? null : block.id);
                  }}
                  onDoubleClick={() => onEditBlock(block)}
                  onPointerDown={(e) => isPending && !resizeBlockId && startDrag(e, block)}
                >
                  {/* Drag time tooltip */}
                  {isDragging && dragTime && (
                    <div
                      className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-surface-light border border-border-strong text-[10px] font-heading font-bold text-on-air whitespace-nowrap shadow-lg pointer-events-none z-40"
                    >
                      {dragTime}
                    </div>
                  )}
                  {/* Resize duration tooltip */}
                  {isResizing && resizeDur !== null && (
                    <div
                      className="absolute -top-7 right-0 translate-x-1/2 px-2 py-0.5 rounded bg-surface-light border border-border-strong text-[10px] font-heading font-bold text-on-air whitespace-nowrap shadow-lg pointer-events-none z-40"
                    >
                      {resizeDur}m
                    </div>
                  )}
                  {/* Left accent stripe */}
                  <div
                    className="absolute left-0 top-0 bottom-0 w-0.75"
                    style={{ background: style.accent }}
                  />

                  {/* Progress overlay */}
                  {isActive && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        background: `${style.accent}15`,
                        width: `${progress * 100}%`,
                      }}
                    />
                  )}

                  {/* Content */}
                  <div className="relative h-full flex items-center gap-1.5 pl-3 pr-2 min-w-0 overflow-hidden">
                    {width >= 20 && (
                      <Icon
                        className={`w-3 h-3 shrink-0 ${style.text} ${isActive ? "animate-pulse" : ""}`}
                      />
                    )}
                    {width >= 40 && (
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-medium text-text truncate leading-tight">
                          {block.title}
                        </p>
                        <p className="text-[8px] text-text-dim leading-tight">
                          {block.startTime} &middot; {block.durationMinutes}m
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Hover actions */}
                  {block.status === "pending" && !isDragging && !isResizing && (
                    <div data-block-actions className="absolute top-0.5 right-0.5 hidden group-hover:flex items-center gap-0.5 bg-base/90 rounded p-0.5 backdrop-blur-sm">
                      {isPresenting && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecute(block.id);
                          }}
                          title="Play now"
                          className="p-1 rounded hover:bg-white/10 text-live"
                        >
                          <Play className="w-2.5 h-2.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditBlock(block);
                        }}
                        title="Edit"
                        className="p-1 rounded hover:bg-white/10 text-text-dim"
                      >
                        <Pencil className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(block.id);
                        }}
                        title="Delete"
                        className="p-1 rounded hover:bg-white/10 text-on-air/60"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  )}

                  {/* Resize handle (right edge) */}
                  {isPending && !isDragging && (
                    <div
                      className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize group/handle ${
                        isResizing ? "z-40" : ""
                      }`}
                      onPointerDown={(e) => startResize(e, block)}
                    >
                      <div className={`absolute right-0 top-1/2 -translate-y-1/2 w-0.5 rounded-full transition-all ${
                        isResizing
                          ? "h-5 bg-on-air"
                          : "h-3 bg-white/15 group-hover/handle:h-5 group-hover/handle:bg-white/30"
                      }`} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Playhead */}
          {isToday && (
            <>
              <div
                className="absolute z-20 pointer-events-none"
                style={{ left: playheadX - 5, top: RULER_H - 6 }}
              >
                <svg width="10" height="6" viewBox="0 0 10 6">
                  <polygon
                    points="0,0 10,0 5,6"
                    fill="var(--color-on-air)"
                  />
                </svg>
              </div>
              <div
                className="absolute z-20 w-px pointer-events-none"
                style={{
                  left: playheadX,
                  top: RULER_H,
                  height: TRACK_H,
                  background: "var(--color-on-air)",
                  boxShadow:
                    "0 0 8px var(--color-on-air), 0 0 2px var(--color-on-air)",
                }}
              />
            </>
          )}

          {/* Empty state — see overlay below */}
        </div>
      </div>

      {/* Empty state overlay — positioned over the scroll container, always visible */}
      {!loading && blocks.length === 0 && (
        <div
          className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
        >
          <button
            onClick={onAddBlock}
            className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-on-air/10 text-on-air border border-on-air/20 hover:bg-on-air/20 text-xs font-heading font-bold tracking-wide uppercase transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add first block
          </button>
        </div>
      )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs text-red-300 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="ml-1 p-0.5 rounded hover:bg-white/10 text-red-400">
            <span className="sr-only">Dismiss</span>&times;
          </button>
        </div>
      )}
    </div>
  );
}