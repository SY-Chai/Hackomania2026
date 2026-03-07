export function resolveSocketServerUrl() {
  return process.env.NEXT_PUBLIC_SOCKET_SERVER_URL ?? "http://localhost:3001";
}
