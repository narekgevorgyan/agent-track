import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: never }).TEST_MIGRATIONS);
