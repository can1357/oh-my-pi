/**
 * Redis-Backed Sessions
 *
 * Store session JSONL in Redis (or Valkey) instead of the local filesystem.
 * Useful when the agent runs in an ephemeral container, behind a load
 * balancer, or anywhere a shared session store beats per-host disk state.
 *
 * The storage substrate is the only thing that changes — every other SDK
 * surface (extensions, hooks, custom tools, slash commands, branching,
 * `SessionManager.list`, …) continues to work unmodified.
 *
 * Tool artifacts and image blobs are out of scope: `ArtifactManager` /
 * `BlobStore` keep writing to `~/.omp/agent/...`. Reach for an object store
 * (S3, R2, GCS) if you need those off-host too.
 */

import { createAgentSession, RedisSessionStorage, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { RedisClient } from "bun";

// `bun:redis` picks up `REDIS_URL` / `VALKEY_URL` from the environment, or
// you can pass an explicit `redis://`/`rediss://` URL.
const redis = new RedisClient();
await redis.ping();

// `create()` warms an in-memory mirror with every existing key under the
// prefix so SessionManager's synchronous lookups (resume, recent sessions,
// list) work without per-call network round-trips.
const storage = await RedisSessionStorage.create({
	client: redis,
	prefix: "omp:sessions:", // optional, this is the default
});

const sessionDir = "/sessions/my-project";

// 1) Fresh persistent session, JSONL backed by Redis.
const { session } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd(), sessionDir, storage),
});
console.log("New Redis session:", session.sessionFile);

// 2) Continue the most recent session for this `sessionDir`.
const { session: continued } = await createAgentSession({
	sessionManager: await SessionManager.continueRecent(process.cwd(), sessionDir, storage),
});
console.log("Resumed:", continued.sessionFile);

// 3) List every Redis-backed session under this directory key prefix.
const sessions = await SessionManager.list(process.cwd(), sessionDir, storage);
console.log(`Found ${sessions.length} sessions under ${sessionDir}`);

// On graceful shutdown, drain any background writes the writer queued and
// close the Redis connection so containerized hosts can exit cleanly.
await storage.drain();
redis.close();
