import { describe, it, expect } from "vitest";
import { req } from "./helpers";

describe("health", () => {
  it("GET /api/health is public", async () => {
    const r = await req("/api/health", {}, null);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, version: "0.1.0" });
  });
});
