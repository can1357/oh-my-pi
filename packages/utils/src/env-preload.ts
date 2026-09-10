import * as path from "node:path";
import { getProjectDir } from "./dirs";

const PROJECT_ENV_PRELOAD_TIMEOUT_MS = 5000;

interface PreloadedProjectEnv {
	readonly filePath: string;
	readonly content: string | undefined;
}

let preloadedProjectEnv: PreloadedProjectEnv | undefined;

/** Optional inputs for bounded project-dotenv preloading. */
export interface PreloadProjectEnvOptions {
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

/** Project dotenv bytes captured before modules synchronously initialize the environment. */
export function getPreloadedProjectEnv(filePath: string): { readonly content: string | undefined } | undefined {
	if (preloadedProjectEnv?.filePath === filePath) return preloadedProjectEnv;
	return undefined;
}

/**
 * Streams the project dotenv and hard-cancels the reader once the deadline
 * elapses, returning `undefined` on timeout.
 *
 * A plain `fs.readFile`/`Bun.file().text()` under a promise-level timeout only
 * settles its own wrapper: the stalled read stays pending on Bun's threadpool,
 * keeps the event loop referenced, and blocks process exit (short commands hang
 * ~5s, graceful shutdown hangs indefinitely) on a wedged drvfs/9p mount
 * (#11519). `ReadableStreamDefaultReader.cancel()` tears the underlying read
 * down, so the loop drains even when the mount never answers.
 */
async function readProjectEnvBounded(filePath: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const reader = Bun.file(filePath).stream().getReader();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void reader.cancel().catch(() => {});
		}, timeoutMs);
		try {
			const chunks: Uint8Array[] = [];
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(value);
			}
			return timedOut ? undefined : Buffer.concat(chunks).toString("utf8");
		} finally {
			clearTimeout(timer);
			void reader.cancel().catch(() => {});
		}
	} catch {
		// Missing, unreadable, and stalled (timeout-cancelled) dotenv files are all optional.
		return undefined;
	}
}

/** Preloads the launch project's optional dotenv under a finite, cancellable startup deadline. */
export async function preloadProjectEnv(options: PreloadProjectEnvOptions = {}): Promise<void> {
	const cwd = options.cwd ?? getProjectDir();
	const timeoutMs = options.timeoutMs ?? PROJECT_ENV_PRELOAD_TIMEOUT_MS;
	const filePath = path.join(cwd, ".env");
	preloadedProjectEnv = { filePath, content: await readProjectEnvBounded(filePath, timeoutMs) };
}
