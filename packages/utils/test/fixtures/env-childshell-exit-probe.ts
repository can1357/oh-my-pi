import { filterChildShellEnv } from "@oh-my-pi/pi-utils/env";
import { preloadProjectEnv } from "@oh-my-pi/pi-utils/env-preload";

// After bounded preload captures `<cwd>`'s project dotenv set, a child-shell
// env build must reuse every snapshot instead of synchronously reopening files
// that timed out.
const cwd = process.argv[2];
const startedAt = Date.now();
await preloadProjectEnv({ cwd, timeoutMs: 300 });
filterChildShellEnv({ FOO: "bar" }, cwd);
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt }));
