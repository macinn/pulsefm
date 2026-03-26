"use client";

import { useState, useEffect } from "react";
import {
  X,
  Radio,
  UserPlus,
  Music,
  Coffee,
  Phone,
  ChevronDown,
  Zap,
  Trash2,
  Plus,
  AlertCircle,
} from "lucide-react";
import type {
  ScheduleBlock,
  BlockType,
  BlockConfig,
  TopicConfig,
  GuestBlockConfig,
  MusicConfig,
  BreakConfig,
  CallsConfig,
} from "@/types/schedule";
import * as scheduleService from "@/services/schedule-service";

const GUEST_VOICES = [
  { value: "EXAVITQu4vr4xnSDxMaL", label: "Sarah" },
  { value: "cgSgspJ2msm6clMCkdW9", label: "Jessica" },
  { value: "pFZP5JQG7iQjIQuC4Bku", label: "Lily" },
  { value: "CwhRBWXzGAHq8TQ4Fs17", label: "Roger" },
  { value: "cjVigY5qzO86Huf0OWal", label: "Eric" },
  { value: "JBFqnCBsd6RMkjVDRZzb", label: "George" },
];

const TYPE_OPTIONS: { value: BlockType; label: string; icon: typeof Radio }[] = [
  { value: "topic", label: "Topic", icon: Radio },
  { value: "guest", label: "Guest", icon: UserPlus },
  { value: "music", label: "Music", icon: Music },
  { value: "calls", label: "Calls", icon: Phone },
  { value: "break", label: "Break", icon: Coffee },
];

interface BlockEditorProps {
  date: string;
  block: ScheduleBlock | null; // null = create mode
  readOnly?: boolean;
  initialValues?: {
    type?: BlockType;
    title?: string;
    startTime?: string;
    durationMinutes?: number;
    config?: BlockConfig;
  };
  onClose: () => void;
  onSaved: () => void;
}

function defaultConfig(type: BlockType): BlockConfig {
  switch (type) {
    case "topic":
      return { description: "" } as TopicConfig;
    case "guest":
      return { name: "", expertise: "", topic: "", voice: "Aoede" } as GuestBlockConfig;
    case "music":
      return { playlist: [], label: "", loop: true } as MusicConfig;
    case "break":
      return { message: "" } as BreakConfig;
    case "calls":
      return { topic: "" } as CallsConfig;
  }
}

function nowHHmm(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 5);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function currentHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function BlockEditor({ date, block, readOnly, initialValues, onClose, onSaved }: BlockEditorProps) {
  const isEditing = block !== null;

  const [type, setType] = useState<BlockType>(block?.type ?? initialValues?.type ?? "topic");
  const [title, setTitle] = useState(block?.title ?? initialValues?.title ?? "");
  const [startTime, setStartTime] = useState(block?.startTime ?? initialValues?.startTime ?? nowHHmm());
  const [startNow, setStartNow] = useState(false);
  const [duration, setDuration] = useState(block?.durationMinutes ?? initialValues?.durationMinutes ?? 5);
  const [config, setConfig] = useState<BlockConfig>(block?.config ?? initialValues?.config ?? defaultConfig("topic"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<string[]>([]);

  // Fetch available tracks for music blocks
  useEffect(() => {
    scheduleService.fetchTracks().then(setTracks).catch(() => {});
  }, []);

  // Reset config when type changes (only in create mode), carrying over shared text
  function handleTypeChange(newType: BlockType) {
    setType(newType);
    if (!isEditing) {
      const sharedText = (config as Record<string, unknown>).description as string
        ?? (config as Record<string, unknown>).topic as string
        ?? '';
      const newConfig = defaultConfig(newType);
      if (sharedText) {
        if (newType === 'topic') (newConfig as TopicConfig).description = sharedText;
        else if (newType === 'guest') (newConfig as GuestBlockConfig).topic = sharedText;
      }
      setConfig(newConfig);
    }
  }

  function updateConfig<K extends keyof BlockConfig>(key: string, value: unknown) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startTime) return;

    setSaving(true);
    setError(null);
    try {
      const effectiveStartTime = startNow ? currentHHmm() : startTime;
      if (isEditing) {
        await scheduleService.updateBlock(date, block.id, {
          title: title.trim(),
          startTime: effectiveStartTime,
          durationMinutes: duration,
          config,
        });
      } else {
        const created = await scheduleService.addBlock(date, {
          type,
          title: title.trim(),
          startTime: effectiveStartTime,
          durationMinutes: duration,
          config,
        });
        if (startNow) {
          try {
            await scheduleService.executeBlock(date, created.id);
          } catch {
            // Execute fails if radio is off — block is still created
          }
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save block';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl p-5 w-full max-w-md mx-4 border border-border-strong shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading text-sm font-bold tracking-widest uppercase text-text-muted">
            {readOnly ? "Block Details" : isEditing ? "Edit Block" : "New Block"}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5 text-text-dim transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={readOnly ? (e: React.FormEvent) => e.preventDefault() : handleSubmit} className="space-y-4 min-w-0">
          <fieldset disabled={readOnly} className={readOnly ? "space-y-4 opacity-60 min-w-0" : "space-y-4 min-w-0"}>
          {/* Type selector (only in create mode) */}
          {!isEditing && (
            <div className="grid grid-cols-4 gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const active = type === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleTypeChange(opt.value)}
                    className={`flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-xl border text-[10px] font-heading font-bold tracking-wider uppercase transition-all ${
                      active
                        ? "bg-on-air/10 text-on-air border-on-air/25"
                        : "bg-surface text-text-dim border-border hover:bg-white/3"
                    }`}
                  >
                    <opt.icon className="w-4 h-4" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Title */}
          <EditorInput value={title} onChange={setTitle} placeholder="Block title" />

          {/* Time & Duration */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1.5">
                Start Time
              </label>
              <div className="flex gap-2">
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => { setStartTime(e.target.value); setStartNow(false); }}
                  onFocus={() => setStartNow(false)}
                  className={`flex-1 min-w-0 bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text 
                    focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 font-body
                    scheme-dark ${startNow ? 'opacity-40' : ''}`}
                />
                {!isEditing && (
                  <button
                    type="button"
                    onClick={() => setStartNow(!startNow)}
                    className={`flex items-center gap-1 px-2.5 rounded-xl border text-[10px] font-heading font-bold tracking-wider uppercase whitespace-nowrap transition-all ${
                      startNow
                        ? 'bg-on-air/15 text-on-air border-on-air/25'
                        : 'bg-surface text-text-dim border-border hover:bg-white/3'
                    }`}
                  >
                    <Zap className="w-3 h-3" />
                    Now
                  </button>
                )}
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1.5">
                Duration (min)
              </label>
              <input
                type="number"
                min={1}
                max={120}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text 
                  focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 font-body"
              />
            </div>
          </div>

          {/* Type-specific config */}
          {type === "topic" && (
            <TopicFields
              config={config as TopicConfig}
              onChange={updateConfig}
            />
          )}
          {type === "guest" && (
            <GuestFields
              config={config as GuestBlockConfig}
              onChange={updateConfig}
            />
          )}
          {type === "music" && (
            <MusicFields
              config={config as MusicConfig}
              onChange={updateConfig}
              tracks={tracks}
            />
          )}
          {type === "break" && (
            <BreakFields
              config={config as BreakConfig}
              onChange={updateConfig}
            />
          )}
          {type === "calls" && (
            <CallsFields
              config={config as CallsConfig}
              onChange={updateConfig}
            />
          )}
          </fieldset>

          {readOnly && block && (
            <div className="flex items-center gap-2">
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-heading font-bold tracking-wider uppercase ${
                block.status === "active" ? "bg-live/15 text-live" :
                block.status === "completed" ? "bg-white/8 text-text-dim" :
                "bg-breaking/15 text-breaking"
              }`}>{block.status}</span>
            </div>
          )}

          {/* Submit */}
          {!readOnly && (
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl 
                bg-on-air/15 text-on-air border border-on-air/20 hover:bg-on-air/25
                disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm font-heading font-bold tracking-wide uppercase"
            >
              {saving ? "Saving..." : isEditing ? "Update Block" : "Add Block"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

/* ─── Config sub-forms ─── */

function TopicFields({ config, onChange }: { config: TopicConfig; onChange: (key: string, val: unknown) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[10px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1.5">
          Description
        </label>
        <textarea
          value={config.description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder="What should Pulse cover?"
          rows={3}
          className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text placeholder:text-text-dim 
            focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 resize-none font-body"
        />
      </div>
    </div>
  );
}

function GuestFields({ config, onChange }: { config: GuestBlockConfig; onChange: (key: string, val: unknown) => void }) {
  return (
    <div className="space-y-2.5">
      <EditorInput value={config.name} onChange={(v) => onChange("name", v)} placeholder="Guest name" />
      <EditorInput value={config.expertise} onChange={(v) => onChange("expertise", v)} placeholder="Expertise" />
      <EditorInput value={config.topic} onChange={(v) => onChange("topic", v)} placeholder="Discussion topic" />
      <div className="relative">
        <select
          value={config.voice}
          onChange={(e) => onChange("voice", e.target.value)}
          className="w-full appearance-none bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text 
            focus:outline-none focus:border-border-strong font-body pr-8"
        >
          {GUEST_VOICES.map((v) => (
            <option key={v.value} value={v.value}>
              Voice: {v.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim pointer-events-none" />
      </div>
    </div>
  );
}

function MusicFields({ config, onChange, tracks }: { config: MusicConfig; onChange: (key: string, val: unknown) => void; tracks: string[] }) {
  // Normalize: migrate legacy trackFile to playlist
  const playlist = config.playlist?.length ? config.playlist : config.trackFile ? [config.trackFile] : [];

  function setPlaylist(newPlaylist: string[]) {
    onChange("playlist", newPlaylist);
  }

  function addTrack(filename: string) {
    if (!filename) return;
    setPlaylist([...playlist, filename]);
  }

  function removeTrack(index: number) {
    setPlaylist(playlist.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2.5">
      <EditorInput value={config.label} onChange={(v) => onChange("label", v)} placeholder="Label (e.g. Transition jingle)" />

      {/* Playlist */}
      <div>
        <label className="block text-[10px] font-heading font-bold tracking-wider uppercase text-text-dim mb-1.5">
          Playlist ({playlist.length} track{playlist.length !== 1 ? "s" : ""})
        </label>

        {playlist.length > 0 && (
          <div className="space-y-1 mb-2">
            {playlist.map((filename, i) => (
              <div key={`${filename}-${i}`} className="flex min-w-0 items-center gap-2 bg-surface rounded-lg px-2.5 py-1.5 border border-border">
                <Music className="w-3 h-3 text-text-dim shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs text-text" title={filename}>{filename}</span>
                <button
                  type="button"
                  onClick={() => removeTrack(i)}
                  className="shrink-0 p-0.5 rounded hover:bg-white/10 text-text-dim hover:text-on-air transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add track */}
        {tracks.length > 0 ? (
          <div className="relative">
            <select
              value=""
              onChange={(e) => addTrack(e.target.value)}
              className="w-full appearance-none bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text-dim
                focus:outline-none focus:border-border-strong font-body pr-8"
            >
              <option value="">Add a track...</option>
              {tracks.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <Plus className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim pointer-events-none" />
          </div>
        ) : (
          <p className="text-[10px] text-text-dim">No tracks available — generate music first</p>
        )}
      </div>

      {/* Loop toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={config.loop !== false}
          onChange={(e) => onChange("loop", e.target.checked)}
          className="rounded border-border-strong bg-surface accent-on-air w-3.5 h-3.5"
        />
        <span className="text-xs text-text-muted">Loop playlist when it finishes</span>
      </label>
    </div>
  );
}

function BreakFields({ config, onChange }: { config: BreakConfig; onChange: (key: string, val: unknown) => void }) {
  return (
    <EditorInput
      value={config.message ?? ""}
      onChange={(v) => onChange("message", v)}
      placeholder="Break message (optional)"
    />
  );
}

function CallsFields({ config, onChange }: { config: CallsConfig; onChange: (key: string, val: unknown) => void }) {
  return (
    <EditorInput
      value={config.topic ?? ""}
      onChange={(v) => onChange("topic", v)}
      placeholder="Call-in topic (optional, e.g. AI predictions for 2026)"
    />
  );
}

/* ─── Shared components ─── */

function EditorInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-sm text-text placeholder:text-text-dim 
        focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-on-air/10 font-body"
    />
  );
}
