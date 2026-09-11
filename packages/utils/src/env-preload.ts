import * as path from "node:path";
import { getProjectDir } from "./dirs";

const PROJECT_ENV_PRELOAD_TIMEOUT_MS = 5000;

interface PreloadedProjectEnv {
	readonly content: string | undefined;
}

let preloadedProjectEnv = new Map<string, PreloadedProjectEnv>();

/** Optional inputs for bounded project-dotenv preloading. */
export interface PreloadProjectEnvOptions {
	readonly cwd?: string;
	readonly timeoutMs?: number;
	/** NODE_ENV used to select mode-specific dotenv files. */
	readonly nodeEnv?: string;
}

/** Project dotenv bytes captured before modules synchronously initialize the environment. */
export function getPreloadedProjectEnv(filePath: string): PreloadedProjectEnv | undefined {
	return preloadedProjectEnv.get(filePath);
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

function projectDotenvPaths(cwd: string, nodeEnv: string): string[] {
	const modeName = `.env.${nodeEnv || "development"}`;
	const names = [".env", modeName, ".env.local", `${modeName}.local`, ".env.development", ".env.development.local"];
	return [...new Set(names)].map(name => path.join(cwd, name));
}

/** Preloads every project dotenv path consulted by child-shell filtering under one finite startup deadline. */
export async function preloadProjectEnv(options: PreloadProjectEnvOptions = {}): Promise<void> {
	const cwd = options.cwd ?? getProjectDir();
	const timeoutMs = options.timeoutMs ?? PROJECT_ENV_PRELOAD_TIMEOUT_MS;
	const filePaths = projectDotenvPaths(cwd, options.nodeEnv ?? process.env.NODE_ENV ?? "development");
	const entries = await Promise.all(
		filePaths.map(async filePath => ({
			filePath,
			content: await readProjectEnvBounded(filePath, timeoutMs),
		})),
	);
	const next = new Map<string, PreloadedProjectEnv>();
	for (const { filePath, content } of entries) next.set(filePath, { content });
	preloadedProjectEnv = next;
}
