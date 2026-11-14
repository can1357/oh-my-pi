/**
 * Resolved Supermemory runtime configuration.
 *
 * The API key, origin and namespace override come from `SUPERMEMORY_API_KEY` /
 * `SUPERMEMORY_BASE_URL` / `SUPERMEMORY_NAMESPACE` only, never from settings: project-local config
 * files merge into settings, so a cloned repository could otherwise point the user's bearer token
 * at another origin, swap in its own key and collect the user's transcripts, or read and write an
 * arbitrary namespace of the user's account (`supermemory.scoping` only picks `omp-global` or the
 * per-repository namespace). Tuning fields read the `supermemory.*` setting handles.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { clamp } from "@oh-my-pi/pi-utils";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../config/settings";
import {
	cfgSupermemoryAutoRecall,
	cfgSupermemoryRecallEveryTurn,
	cfgSupermemoryAutoRetain,
	cfgSupermemoryRecallLimit,
	cfgSupermemoryRetainEveryNTurns,
	cfgSupermemoryScoping,
	cfgSupermemorySearchMode,
	cfgSupermemoryThreshold,
} from "./settings";

const DEFAULT_BASE_URL = "https://api.supermemory.ai";

export type SupermemoryScoping = "global" | "per-project";
export type SupermemorySearchMode = "hybrid" | "memories";

export interface SupermemoryConfig {
	/** Validated API origin without a trailing slash; `null` when unset or rejected. */
	baseUrl: string | null;
	apiKey: string | null;
	/** `SUPERMEMORY_NAMESPACE`: overrides {@link scoping} when set; `null` when set but rejected. */
	namespace: string | null | undefined;
	scoping: SupermemoryScoping;
	autoRecall: boolean;
	/** Re-run automatic recall on every user turn instead of only the first. */
	recallEveryTurn: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	threshold: number;
	searchMode: SupermemorySearchMode;
}

export type ConfiguredSupermemoryConfig = SupermemoryConfig & {
	baseUrl: string;
	apiKey: string;
	namespace: string | undefined;
};

const NAMESPACE_PATTERN = /^[A-Za-z0-9_:-]{1,100}$/;

function validateNamespace(raw: string | undefined): string | null | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	return NAMESPACE_PATTERN.test(trimmed) ? trimmed : null;
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
		baseUrl: validateBaseUrl(Bun.env.SUPERMEMORY_BASE_URL?.trim() || DEFAULT_BASE_URL),
		apiKey: Bun.env.SUPERMEMORY_API_KEY?.trim() || null,
		namespace: validateNamespace(Bun.env.SUPERMEMORY_NAMESPACE),
		scoping: cfgSupermemoryScoping.get(settings),
		autoRecall: cfgSupermemoryAutoRecall.get(settings),
		recallEveryTurn: cfgSupermemoryRecallEveryTurn.get(settings),
		autoRetain: cfgSupermemoryAutoRetain.get(settings),
		retainEveryNTurns: Math.floor(clamp(cfgSupermemoryRetainEveryNTurns.get(settings), 1, 100)),
		recallLimit: Math.floor(clamp(cfgSupermemoryRecallLimit.get(settings), 1, 50)),
		threshold: clamp(cfgSupermemoryThreshold.get(settings), 0, 1),
		searchMode: cfgSupermemorySearchMode.get(settings),
	};
}

/** Whether there is an API key, an accepted base URL to send it to, and no rejected namespace override. */
export function isSupermemoryConfigured(config: SupermemoryConfig): config is ConfiguredSupermemoryConfig {
	return config.apiKey !== null && config.baseUrl !== null && config.namespace !== null;
}

/**
 * Namespace for `cwd`: `SUPERMEMORY_NAMESPACE` when set, else an opaque, stable one. Per-project
 * scoping hashes the primary repository root (so subdirectories and linked worktrees share one
 * namespace), falling back to `cwd` outside a repository; Supermemory never sees a local path.
 */
export function resolveSupermemoryNamespace(
	cwd: string,
	config: Pick<ConfiguredSupermemoryConfig, "namespace" | "scoping">,
): string {
	if (config.namespace) return config.namespace;
	if (config.scoping === "global") return "omp-global";
	const identity = resolveEquivalentPath(vcs.repo(cwd)?.primaryRoot() ?? cwd).replace(/\\/g, "/");
	const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
	return `omp-project-${digest.slice(0, 24)}`;
}
