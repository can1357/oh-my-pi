import { filterChildShellEnv } from "@oh-my-pi/pi-utils/env";
import { preloadProjectEnv } from "@oh-my-pi/pi-utils/env-preload";

// After the bounded preload captures a stalled `<cwd>/.env`, a child-shell env
// build must reuse that snapshot instead of synchronously reopening the file.
// Falls off the end without process.exit so the parent observes whether the
// synchronous reread left the event loop referenced.
const cwd = process.argv[2];
const startedAt = Date.now();
await preloadProjectEnv({ cwd, timeoutMs: 300 });
filterChildShellEnv({ FOO: "bar" }, cwd);
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt }));
