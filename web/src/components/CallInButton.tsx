"use client";

import { useState, useEffect } from "react";
import { useRadio } from "./RadioProvider";
import { Phone, PhoneOff, AlertCircle } from "lucide-react";
import CallSetupModal from "./CallSetupModal";

export default function CallInButton() {
  const { state, service } = useRadio();
  const [showSetup, setShowSetup] = useState(false);
  const [rejectedMsg, setRejectedMsg] = useState<string | null>(null);

  const isInCall = state.callerStatus === "connecting" || state.callerStatus === "live";
  const visible = state.isLive && (isInCall || state.callsOpen);

  useEffect(() => {
    if (state.callRejectedReason) {
      setRejectedMsg(state.callRejectedReason);
      const t = setTimeout(() => setRejectedMsg(null), 4000);
      return () => clearTimeout(t);
    }
  }, [state.callRejectedReason]);

  useEffect(() => {
    if (!state.callsOpen && !isInCall) {
      setShowSetup(false);
    }
  }, [state.callsOpen, isInCall]);

  function handleCallStart(name: string) {
    if (!state.callsOpen) {
      setShowSetup(false);
      return;
    }
    setShowSetup(false);
    service.startCall(name, "audio");
  }

  return (
    <>
      {visible && (
        isInCall ? (
          <button
            onClick={() => service.endCall()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-on-air text-white font-heading text-[11px] font-bold tracking-wider uppercase transition-all duration-300 active:scale-95 hover:brightness-110"
          >
            <PhoneOff className="w-3.5 h-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">Hang up</span>
          </button>
        ) : (
          <button
            onClick={() => setShowSetup(true)}
            disabled={state.callerStatus === "ended"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass text-text-muted hover:text-text hover:border-text-muted font-heading text-[11px] font-bold tracking-wider uppercase transition-all duration-300 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Phone className="w-3.5 h-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">Call in</span>
          </button>
        )
      )}

      {/* Modal rendered outside the callsOpen guard so it survives state changes */}
      {showSetup && (
        <CallSetupModal
          onStart={handleCallStart}
          onClose={() => setShowSetup(false)}
        />
      )}

      {/* Rejection toast */}
      {rejectedMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl glass-strong border border-on-air/30 text-on-air animate-fade-in-up">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="font-heading text-xs font-bold tracking-wide">{rejectedMsg}</span>
        </div>
      )}
    </>
  );
}
