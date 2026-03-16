const FALLBACK = "http://localhost:3001";

/** Returns the backend API base URL. Works on both server and client. */
export function getApiUrl(): string {
  if (typeof window !== "undefined" && (window as Record<string, unknown>).__PULSE_API_URL) {
    return (window as Record<string, unknown>).__PULSE_API_URL as string;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? FALLBACK;
}

/** Returns the WebSocket URL derived from the API URL. */
export function getWsUrl(path = "/ws/radio"): string {
  return `${getApiUrl().replace(/^http/, "ws")}${path}`;
}
