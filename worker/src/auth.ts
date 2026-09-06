const enc = new TextEncoder();

/** Length-independent constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  return diff === 0;
}

/** Bearer header check. `allowQuery` lets EventSource (which cannot set headers) pass `?token=`. */
export function isAuthorized(request: Request, token: string | undefined, allowQuery = false): boolean {
  if (!token) return false;
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && timingSafeEqual(m[1].trim(), token)) return true;
  if (allowQuery) {
    const q = new URL(request.url).searchParams.get("token");
    if (q && timingSafeEqual(q, token)) return true;
  }
  return false;
}

/** Absent Origin (curl, agents) is fine; a present Origin must be our own. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}
