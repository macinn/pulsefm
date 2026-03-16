"use client";

import { createContext, useContext, useEffect, useState, useRef } from "react";
import type { RadioState } from "@/types/radio";
import { WebSocketRadioService, createInitialState, type RadioService } from "@/services/radio-service";

interface RadioContextValue {
  state: RadioState;
  service: RadioService;
}

const RadioContext = createContext<RadioContextValue | null>(null);

export function RadioProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<RadioService | null>(null);
  if (typeof window !== "undefined" && !serviceRef.current) {
    serviceRef.current = new WebSocketRadioService();
  }
  const [state, setState] = useState<RadioState>(() =>
    serviceRef.current?.getState() ?? createInitialState(),
  );

  useEffect(() => {
    if (!serviceRef.current) return;
    return serviceRef.current.subscribe(setState);
  }, []);

  return (
    <RadioContext.Provider value={{ state, service: serviceRef.current! }}>
      {children}
    </RadioContext.Provider>
  );
}

export function useRadio(): RadioContextValue {
  const ctx = useContext(RadioContext);
  if (!ctx) throw new Error("useRadio must be used within RadioProvider");
  return ctx;
}
