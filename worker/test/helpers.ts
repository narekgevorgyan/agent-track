import { exports } from "cloudflare:workers";

export const TOKEN = "test-token";

export function req(path: string, init: RequestInit = {}, token: string | null = TOKEN) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return exports.default.fetch(new Request(`https://track.test${path}`, { ...init, headers }));
}

export async function api<T = any>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const r = await req(path, { method, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export function patch<T = any>(path: string, body: unknown) {
  return api<T>(path, body, "PATCH");
}
