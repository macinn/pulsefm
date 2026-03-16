import type {
  RadioState,
  SourceStatus,
  Station,
  CallMode,
  CallRouting,
} from "@/types/radio";
import { getApiUrl, getWsUrl } from "@/lib/config";

export interface RadioService {
  getState(): RadioState;
  subscribe(cb: (state: RadioState) => void): () => void;
  togglePlay(): void;
  setVolume(v: number): void;
  startCall(name: string, mode: CallMode): void;
  endCall(): void;
  sendCallerAudio(base64Pcm: string): void;
}

const MOCK_SOURCES: SourceStatus[] = [
  { type: "rss", label: "RSS Feeds", active: true, lastUpdate: Date.now() - 35000, itemCount: 23 },
  { type: "reddit", label: "Reddit", active: true, lastUpdate: Date.now() - 60000, itemCount: 12 },
];

const PULSE_STATION: Station = {
  id: "pulse-ai",
  name: "Pulse",
  tagline: "AI & Startups 24/7",
  niche: "AI, machine learning, startups, tech industry",
  color: "#E54D2E",
  listeners: 0,
  isLive: false,
  isDefault: true,
};

export function createInitialState(): RadioState {
  return {
    isLive: false,
    isPlaying: false,
    volume: 0.75,
    currentSegment: null,
    newsQueue: [],
    sources: MOCK_SOURCES,
    callerStatus: "idle",
    callerName: "",
    callerMode: "audio",
    callRouting: "none",
    currentStation: PULSE_STATION,
    callsOpen: false,
    newsImage: null,
  };
}

export class MockRadioService implements RadioService {
  private state: RadioState;
  private listeners: Set<(state: RadioState) => void> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.state = createInitialState();
  }

  getState(): RadioState {
    return this.state;
  }

  subscribe(cb: (state: RadioState) => void): () => void {
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.startTick();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopTick();
    };
  }

  togglePlay(): void {
    this.update({ isPlaying: !this.state.isPlaying });
  }

  setVolume(v: number): void {
    this.update({ volume: Math.max(0, Math.min(1, v)) });
  }

  startCall(name: string, mode: CallMode): void {
    this.update({ callerStatus: "connecting", callerName: name, callerMode: mode, callRouting: "none" });
    setTimeout(() => this.update({ callerStatus: "live", callRouting: "screener" }), 2000);
  }

  endCall(): void {
    this.update({ callerStatus: "ended", callRouting: "none" });
    setTimeout(() => this.update({ callerStatus: "idle", callerName: "", callerMode: "audio", callRouting: "none" }), 1500);
  }

  sendCallerAudio(_base64Pcm: string): void {}

  private update(partial: Partial<RadioState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb(this.state));
  }

  private startTick(): void {
    this.tickInterval = setInterval(() => {
      // Simulate source updates
      const sources = this.state.sources.map((s) => ({
        ...s,
        lastUpdate: Date.now() - Math.random() * 60000,
        itemCount: s.itemCount + Math.floor(Math.random() * 3),
      }));
      this.update({ sources });
    }, 10000);
  }

  private stopTick(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}

// PCM 24kHz 16-bit mono output from Gemini
const SAMPLE_RATE = 24000;

export class WebSocketRadioService implements RadioService {
  private state: RadioState;
  private listeners: Set<(state: RadioState) => void> = new Set();
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private nextPlayTime = 0;
  private scheduledSources: AudioBufferSourceNode[] = [];
  // Separate audio context for screener/call audio
  private callAudioCtx: AudioContext | null = null;
  private callGainNode: GainNode | null = null;
  private callNextPlayTime = 0;
  private callScheduledSources: AudioBufferSourceNode[] = [];
  private wsUrl: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(wsUrl?: string) {
    this.state = createInitialState();
    this.wsUrl = wsUrl ?? getWsUrl();
    // Connect immediately for status updates
    this.connectWs();
  }

  getState(): RadioState {
    return this.state;
  }

  subscribe(cb: (state: RadioState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  togglePlay(): void {
    if (this.state.isPlaying) {
      this.teardownAudio();
      this.update({ isPlaying: false });
    } else {
      this.initAudio();
      this.update({ isPlaying: true });
    }
  }

  setVolume(v: number): void {
    const volume = Math.max(0, Math.min(1, v));
    this.update({ volume });
    if (this.gainNode) {
      this.gainNode.gain.value = volume;
    }
  }

  startCall(name: string, mode: CallMode): void {
    this.update({ callerStatus: "connecting", callerName: name, callerMode: mode, callRouting: "none" });
    this.sendMessage({ type: "call-start", name, mode });
  }

  endCall(): void {
    this.sendMessage({ type: "call-end" });
    this.update({ callerStatus: "ended", callRouting: "none" });
    this.teardownCallAudio();
    setTimeout(() => this.update({ callerStatus: "idle", callerName: "", callerMode: "audio", callRouting: "none" }), 1500);
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendCallerAudio(base64Pcm: string): void {
    this.sendMessage({ type: "caller-audio", data: base64Pcm });
  }

  // Always-on WS for status + audio data
  private connectWs(): void {
    if (this.ws) return;
    if (typeof WebSocket === "undefined") return;

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log("[radio-ws] connected");
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "status") {
          this.update({ isLive: msg.presenting, callsOpen: msg.callsOpen ?? false });
          if (!msg.presenting && this.state.isPlaying) {
            this.teardownAudio();
            this.update({ isPlaying: false, callsOpen: false });
          }
        } else if (msg.type === "calls-open") {
          this.update({ callsOpen: true });
        } else if (msg.type === "calls-closed") {
          this.update({ callsOpen: false });
        } else if (msg.type === "audio-reset") {
          this.flushAudioQueue();
        } else if (msg.type === "audio") {
          if (this.state.isPlaying) this.playAudioChunk(msg.data);
        } else if (msg.type === "interrupted") {
          this.flushAudioQueue();
        } else if (msg.type === "stopped") {
          this.flushAudioQueue();
          this.teardownAudio();
          this.update({ isPlaying: false, isLive: false });
        } else if (msg.type === "call-accepted") {
          const routing = msg.mode === "live" ? "live" : "screener";
          this.update({ callerStatus: "live", callRouting: routing as CallRouting });
        } else if (msg.type === "call-rejected") {
          this.update({ callerStatus: "ended", callRouting: "none" });
          setTimeout(() => this.update({ callerStatus: "idle", callerName: "", callerMode: "audio", callRouting: "none" }), 1500);
        } else if (msg.type === "screener-audio") {
          // Play screener audio to the caller
          if (this.state.callerStatus === "live" && this.state.callRouting === "screener") {
            this.ensureCallAudio();
            this.playCallAudioChunk(msg.data);
          }
        } else if (msg.type === "news-image") {
          this.update({ newsImage: { url: msg.imageUrl, headline: msg.headline, imageUrls: msg.imageUrls } });
          // Auto-clear after 30 seconds
          setTimeout(() => this.update({ newsImage: null }), 30_000);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      console.log("[radio-ws] disconnected");
      this.ws = null;
      this.update({ isLive: false });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      console.error("[radio-ws] connection error");
      this.ws?.close();
      this.ws = null;
      this.update({ isLive: false });
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, 3000);
  }

  // Audio context — only created when user presses play
  private initAudio(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.state.volume;
    this.gainNode.connect(this.audioCtx.destination);
    this.nextPlayTime = 0;
  }

  private teardownAudio(): void {
    this.flushAudioQueue();
    this.audioCtx?.close();
    this.audioCtx = null;
    this.gainNode = null;
  }

  private playAudioChunk(base64: string): void {
    if (!this.audioCtx || !this.gainNode) return;

    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = this.audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    const now = this.audioCtx.currentTime;
    if (this.nextPlayTime < now) this.nextPlayTime = now;
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;

    this.scheduledSources.push(source);
    source.onended = () => {
      const idx = this.scheduledSources.indexOf(source);
      if (idx >= 0) this.scheduledSources.splice(idx, 1);
    };
  }

  private flushAudioQueue(): void {
    for (const s of this.scheduledSources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.scheduledSources = [];
    this.nextPlayTime = 0;
  }

  private ensureCallAudio(): void {
    if (this.callAudioCtx) return;
    this.callAudioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.callGainNode = this.callAudioCtx.createGain();
    this.callGainNode.gain.value = this.state.volume;
    this.callGainNode.connect(this.callAudioCtx.destination);
    this.callNextPlayTime = 0;
  }

  private playCallAudioChunk(base64: string): void {
    if (!this.callAudioCtx || !this.callGainNode) return;

    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = this.callAudioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.callAudioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.callGainNode);

    const now = this.callAudioCtx.currentTime;
    if (this.callNextPlayTime < now) this.callNextPlayTime = now;
    source.start(this.callNextPlayTime);
    this.callNextPlayTime += buffer.duration;

    this.callScheduledSources.push(source);
    source.onended = () => {
      const idx = this.callScheduledSources.indexOf(source);
      if (idx >= 0) this.callScheduledSources.splice(idx, 1);
    };
  }

  private teardownCallAudio(): void {
    for (const s of this.callScheduledSources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.callScheduledSources = [];
    this.callNextPlayTime = 0;
    this.callAudioCtx?.close();
    this.callAudioCtx = null;
    this.callGainNode = null;
  }

  private update(partial: Partial<RadioState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((cb) => cb(this.state));
  }
}
