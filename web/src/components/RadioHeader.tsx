"use client";

import { useRadio } from "./RadioProvider";
import { Radio, Settings } from "lucide-react";
import { VolumeControl } from "./RadioPlayer";
import CallInButton from "./CallInButton";
import Link from "next/link";

export default function RadioHeader() {
  const { state } = useRadio();
  const station = state.currentStation;

  return (
    <header className="relative z-20 glass border-b-0 border-t-0 border-x-0">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio
              className="w-4 h-4"
              style={{ color: station.color }}
              strokeWidth={2.5}
            />
            <span className="font-accent text-xl tracking-tight">
              {station.name}
            </span>
          </div>

          {/* ON AIR / OFF AIR badge */}
          {state.isLive ? (
            <div
              className="flex items-center gap-2 px-2.5 py-1 rounded-full border"
              style={{
                backgroundColor: station.color + "15",
                borderColor: station.color + "30",
              }}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span
                  className="absolute inline-flex h-full w-full rounded-full animate-pulse-live"
                  style={{ backgroundColor: station.color }}
                />
                <span
                  className="relative inline-flex h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: station.color }}
                />
              </span>
              <span
                className="font-heading text-[9px] font-bold tracking-[0.15em] uppercase"
                style={{ color: station.color }}
              >
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
          <VolumeControl />
          <div className="w-px h-5 bg-white/6" />
          <CallInButton />
          <div className="w-px h-5 bg-white/6" />
          <Link
            href="/admin"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border font-heading text-[10px] font-bold tracking-[0.12em] uppercase transition-all duration-200 hover:scale-105"
            style={{
              borderColor: station.color + "40",
              color: station.color,
              backgroundColor: station.color + "10",
            }}
          >
            <Settings className="w-3.5 h-3.5" />
            Studio
          </Link>
        </div>
      </div>
    </header>
  );
}
