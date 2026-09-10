import * as path from "node:path";
import { getPreloadedProjectEnv, preloadProjectEnv } from "@oh-my-pi/pi-utils/env-preload";

// Reads `<cwd>/.env` under a short deadline, prints the outcome, then falls off
// the end of the module WITHOUT process.exit — so the parent test observes
// whether a stalled read left the event loop referenced (process cannot exit).
const cwd = process.argv[2];
const startedAt = Date.now();
await preloadProjectEnv({ cwd, timeoutMs: 300 });
const content = getPreloadedProjectEnv(path.join(cwd, ".env"))?.content;
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, content: content ?? null }));
