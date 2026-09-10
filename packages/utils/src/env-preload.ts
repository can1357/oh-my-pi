import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTimeout } from "./async";
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
	readonly readFile?: (filePath: string) => Promise<string>;
}

/** Project dotenv bytes captured before modules synchronously initialize the environment. */
export function getPreloadedProjectEnv(filePath: string): { readonly content: string | undefined } | undefined {
	if (preloadedProjectEnv?.filePath === filePath) return preloadedProjectEnv;
	return undefined;
}
/** Preloads the launch project's optional dotenv under a finite startup deadline. */
export async function preloadProjectEnv(options: PreloadProjectEnvOptions = {}): Promise<void> {
	const cwd = options.cwd ?? getProjectDir();
	const timeoutMs = options.timeoutMs ?? PROJECT_ENV_PRELOAD_TIMEOUT_MS;
	const filePath = path.join(cwd, ".env");
	const read = options.readFile ? options.readFile(filePath) : fs.readFile(filePath, "utf8");
	let content: string | undefined;
	try {
		content = await withTimeout(read, timeoutMs, "Project dotenv preload timed out");
	} catch {
		// Missing, unreadable, and stalled project dotenv files are all optional.
	}
	preloadedProjectEnv = { filePath, content };
}
