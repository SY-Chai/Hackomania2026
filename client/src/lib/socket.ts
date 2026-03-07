const SOCKET_SERVER_URL = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL;

export function resolveSocketServerUrl() {
  if (SOCKET_SERVER_URL) return SOCKET_SERVER_URL;
  if (typeof window === "undefined") return "http://localhost:3001";
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  return `${protocol}://${window.location.hostname}:3001`;
}
