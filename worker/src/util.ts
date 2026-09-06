export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const now = () => Date.now();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Crockford base32, lowercase. 9 time chars + 7 random chars = 16 chars, time-sortable.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(): string {
  let t = Date.now();
  let s = "";
  for (let i = 0; i < 9; i++) {
    s = ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  for (const b of crypto.getRandomValues(new Uint8Array(7))) s += ALPHABET[b % 32];
  return s;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) throw new HttpError(400, "name must contain letters or digits");
  return s.slice(0, 64);
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
}
