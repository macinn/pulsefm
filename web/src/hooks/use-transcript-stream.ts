"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

export interface TranscriptEntry {
  ts: number;
  role: "pulse" | "caller" | "guest" | "producer" | "system";
  text: string;
}

interface StreamingTurn {
  role: "pulse" | "caller" | "guest" | "producer";
  text: string;
  startTs: number;
}

export interface TranscriptStreamState {
  /** Completed transcript entries (full turns) */
  entries: TranscriptEntry[];
  /** Currently streaming turn (still being spoken) */
  streaming: StreamingTurn | null;
  /** Whether the WebSocket is connected */
  connected: boolean;
}

const MAX_ENTRIES = 500;

import { getWsUrl } from "@/lib/config";

/**
 * Reusable hook that connects to the Pulse radio WebSocket and streams
 * transcript data in real time. Works for both admin and listener UIs.
 */
export function useTranscriptStream(
  wsUrl?: string,
  enabled = true,
  onRawMessage?: (msg: Record<string, unknown>) => void,
): TranscriptStreamState {
  const resolvedUrl = useMemo(
    () => wsUrl ?? getWsUrl(),
    [wsUrl],
  );

  const [state, setState] = useState<TranscriptStreamState>({
    entries: [],
    streaming: null,
    connected: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef<StreamingTurn | null>(null);
  const onRawMessageRef = useRef(onRawMessage);
  onRawMessageRef.current = onRawMessage;

  const pushEntry = useCallback((entry: TranscriptEntry) => {
    setState((prev) => {
      const entries = [...prev.entries, entry];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      return { ...prev, entries, streaming: null };
    });
    streamingRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      wsRef.current?.close();
      wsRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));
      return;
    }

    const ws = new WebSocket(resolvedUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setState((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        onRawMessageRef.current?.(msg);

        switch (msg.type) {
          case "transcript": {
            const chunk: string = msg.text;
            const role: "pulse" | "guest" | "producer" =
              msg.role === "guest"
                ? "guest"
                : msg.role === "producer"
                  ? "producer"
                  : "pulse";
            if (!streamingRef.current || streamingRef.current.role !== role) {
              // Flush previous streaming turn if role changed
              if (streamingRef.current?.text.trim()) {
                pushEntry({
                  ts: streamingRef.current.startTs,
                  role: streamingRef.current.role,
                  text: streamingRef.current.text.trim(),
                });
              }
              streamingRef.current = {
                role,
                text: chunk,
                startTs: Date.now(),
              };
            } else {
              streamingRef.current.text += chunk;
            }
            setState((prev) => ({
              ...prev,
              streaming: streamingRef.current
                ? { ...streamingRef.current }
                : null,
            }));
            break;
          }

          case "turn-complete": {
            if (streamingRef.current?.text.trim()) {
              pushEntry({
                ts: streamingRef.current.startTs,
                role: streamingRef.current.role,
                text: streamingRef.current.text.trim(),
              });
            } else {
              streamingRef.current = null;
              setState((prev) => ({ ...prev, streaming: null }));
            }
            break;
          }

          case "interrupted": {
            if (streamingRef.current?.text.trim()) {
              pushEntry({
                ts: streamingRef.current.startTs,
                role: streamingRef.current.role,
                text: streamingRef.current.text.trim() + " [interrupted]",
              });
            } else {
              streamingRef.current = null;
              setState((prev) => ({ ...prev, streaming: null }));
            }
            break;
          }

          case "stopped": {
            streamingRef.current = null;
            pushEntry({
              ts: Date.now(),
              role: "system",
              text: "Radio stopped",
            });
            break;
          }

          case "transcript-history": {
            const history: TranscriptEntry[] = msg.entries ?? [];
            if (history.length > 0) {
              setState((prev) => {
                const merged = [...history, ...prev.entries];
                if (merged.length > MAX_ENTRIES) merged.splice(0, merged.length - MAX_ENTRIES);
                return { ...prev, entries: merged };
              });
            }
            break;
          }
        }
      } catch {
        // Ignore malformed
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [resolvedUrl, enabled, pushEntry]);

  return state;
}
