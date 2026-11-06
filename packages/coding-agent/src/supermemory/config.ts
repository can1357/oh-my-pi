/**
 * Resolved Supermemory runtime configuration.
 *
 * Every field reads a `supermemory.*` setting handle; `SUPERMEMORY_API_KEY` and
 * `SUPERMEMORY_BASE_URL` win over the settings layers through the registry.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../config/settings";
import {
	cfgSupermemoryApiKey,
	cfgSupermemoryAutoRecall,
	cfgSupermemoryAutoRetain,
	cfgSupermemoryBaseUrl,
	cfgSupermemoryRecallLimit,
	cfgSupermemoryRetainEveryNTurns,
	cfgSupermemoryScoping,
	cfgSupermemorySearchMode,
	cfgSupermemoryThreshold,
} from "./settings";

export type SupermemoryScoping = "global" | "per-project";
export type SupermemorySearchMode = "hybrid" | "memories";

export interface SupermemoryConfig {
	/** Validated API origin without a trailing slash; `null` when unset or rejected. */
	baseUrl: string | null;
	apiKey: string | null;
	scoping: SupermemoryScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	threshold: number;
	searchMode: SupermemorySearchMode;
}

export type ConfiguredSupermemoryConfig = SupermemoryConfig & { baseUrl: string; apiKey: string };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * The API key travels as a bearer token, so only a plain `https:` origin, or `http:` on a
 * literal loopback host, is accepted; userinfo, query and fragment are rejected. Anything
 * else is treated as unconfigured (`backend.start` warns without echoing the URL).
 */
function validateBaseUrl(raw: string | undefined): string | null {
	const trimmed = raw?.trim();
	if (!trimmed || !URL.canParse(trimmed)) return null;
	const url = new URL(trimmed);
	if (url.username || url.password || url.search || url.hash) return null;
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
	return url.toString().replace(/\/+$/, "");
}

export function loadSupermemoryConfig(settings: Settings): SupermemoryConfig {
	return {
		baseUrl: validateBaseUrl(cfgSupermemoryBaseUrl.get(settings)),
		apiKey: cfgSupermemoryApiKey.get(settings)?.trim() || null,
		scoping: cfgSupermemoryScoping.get(settings),
		autoRecall: cfgSupermemoryAutoRecall.get(settings),
		autoRetain: cfgSupermemoryAutoRetain.get(settings),
		retainEveryNTurns: Math.floor(clamp(cfgSupermemoryRetainEveryNTurns.get(settings), 1, 100)),
		recallLimit: Math.floor(clamp(cfgSupermemoryRecallLimit.get(settings), 1, 50)),
		threshold: clamp(cfgSupermemoryThreshold.get(settings), 0, 1),
		searchMode: cfgSupermemorySearchMode.get(settings),
	};
}

/** Whether there is an API key and an accepted base URL to send it to. */
export function isSupermemoryConfigured(config: SupermemoryConfig): config is ConfiguredSupermemoryConfig {
	return config.apiKey !== null && config.baseUrl !== null;
}

/**
 * Opaque, stable container tag for `cwd`. Per-project scoping hashes the primary
 * repository root (so subdirectories and linked worktrees share one container),
 * falling back to `cwd` outside a repository; Supermemory never sees a local path.
 */
export function resolveSupermemoryContainerTag(cwd: string, scoping: SupermemoryScoping): string {
	if (scoping === "global") return "omp-global";
	const identity = resolveEquivalentPath(vcs.repo(cwd)?.primaryRoot() ?? cwd).replace(/\\/g, "/");
	const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
	return `omp-project-${digest.slice(0, 24)}`;
}
