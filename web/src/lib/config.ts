const FALLBACK = "http://localhost:3001";

/** Returns the backend API base URL. Works on both server and client. */
export function getApiUrl(): string {
  if (typeof window !== "undefined" && "__PULSE_API_URL" in window) {
    return (window as unknown as Record<string, string>).__PULSE_API_URL;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? FALLBACK;
}

/** Returns the WebSocket URL derived from the API URL. */
export function getWsUrl(path = "/ws/radio"): string {
  return `${getApiUrl().replace(/^http/, "ws")}${path}`;
}
