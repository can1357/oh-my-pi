import type { FetchImpl } from "@oh-my-pi/pi-utils";

/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

/**
 * Antigravity / Cloud Code Assist user agent. Lives in its own file so discovery
 * and usage code can read it without pulling the heavy google-gemini-cli provider
 * (and its @google/genai → google-auth-library dependency chain) into the startup
 * parse graph.
 *
 * Format captured from the real 2.8.0 `antigravity/hub` client:
 * `antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`.
 * The backend gates newer models (e.g. gemini-3.7-flash) on the client version,
 * so the version tracks the latest Antigravity release via the update manifest
 * (see {@link ensureAntigravityVersion}) with `DEFAULT_ANTIGRAVITY_VERSION` as
 * the offline fallback. os_type/arch are pinned to the darwin/arm64 reference
 * client the version and manifest are captured from, independent of the host
 * platform. Overrides: PI_AI_ANTIGRAVITY_VERSION / _CL / _OS / _ARCH.
 */
export const DEFAULT_ANTIGRAVITY_VERSION = "2.19.1";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
	"https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;
/** Failed manifest lookups are not retried before this delay, so request paths never stall per call. */
const ANTIGRAVITY_VERSION_RETRY_MS = 10 * 60_000;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;
let antigravityVersionFailedAt: number | undefined;

/** Current Antigravity client version: env override → manifest-discovered → pinned fallback. */
export function getAntigravityVersion(): string {
	return process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/**
 * Extracts the client version from an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
export function parseAntigravityManifestVersion(yamlText: string): string | null {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (!match) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
	}
	return null;
}

/**
 * Resolves the latest Antigravity release from the official update manifest.
 * Success is cached for the process lifetime; failures are silent (the pinned
 * fallback stays valid) and suppress further lookups for
 * `ANTIGRAVITY_VERSION_RETRY_MS`. Skipped entirely when PI_AI_ANTIGRAVITY_VERSION is set.
 *
 * The lookup is shared by concurrent callers, so it is bounded only by its own
 * timeout; `signal` ends this caller's wait without cancelling the lookup.
 */
export function ensureAntigravityVersion(fetcher: FetchImpl = fetch, signal?: AbortSignal): Promise<void> {
	if (process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion) return Promise.resolve();
	if (!antigravityVersionFetch) {
		if (
			antigravityVersionFailedAt !== undefined &&
			Date.now() - antigravityVersionFailedAt < ANTIGRAVITY_VERSION_RETRY_MS
		) {
			return Promise.resolve();
		}
		antigravityVersionFetch = (async () => {
			try {
				const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
					headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
					signal: AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS),
				});
				if (response.ok) {
					discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
				}
			} catch {
				// Silent: the pinned fallback remains valid when version discovery fails.
			} finally {
				antigravityVersionFetch = null;
				if (!discoveredAntigravityVersion) antigravityVersionFailedAt = Date.now();
			}
		})();
	}
	const lookup = antigravityVersionFetch;
	if (!signal) return lookup;
	if (signal.aborted) return Promise.resolve();
	const { promise: aborted, resolve } = Promise.withResolvers<void>();
	const onAbort = () => resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([lookup, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Antigravity `User-Agent` header value; rebuilt when the discovered version changes. */
export function getAntigravityUserAgent(): string {
	const version = getAntigravityVersion();
	// The backend does not validate `cl` (verified live: stale, zero, and absent
	// cl all pass model gating on daily-cloudcode-pa; only the version gates).
	// The update manifest carries no changelist, so the captured value stays.
	const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
	const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
	const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
	return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/**
 * Per-wire-id Antigravity Cloud Code Assist request constants, captured from the
 * real `antigravity/hub` client against `daily-cloudcode-pa`. `modelEnum` is the
 * opaque `labels.model_enum` token the client tags each request with — optional
 * because Anthropic-backed wire ids (e.g. `claude-sonnet-4-6`,
 * `claude-opus-4-6-thinking`) are accepted without one; the label is purely
 * telemetry. `maxOutputTokens` is the fixed `generationConfig.maxOutputTokens`
 * the backend enforces regardless of the thinking budget (Claude caps at
 * 64000, Gemini accepts the discovered cap). Keyed by the routed upstream wire
 * id (post effort-routing), not the collapsed logical id. Checkpoint-only ids
 * (e.g. `gemini-3.1-flash-lite`) are intentionally absent — this provider only
 * emits agent requests.
 */
export interface AntigravityModelWireProfile {
	modelEnum?: string;
	maxOutputTokens: number;
}
export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>> = {
	"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
	"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
	"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
	"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
	"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
	// Claude on `daily-cloudcode-pa` rejects `maxOutputTokens > 64000` with a
	// 400 (`Request contains an invalid argument`). The model_enum label is
	// untracked for these ids; the backend does not require it.
	"claude-sonnet-4-6": { maxOutputTokens: 64000 },
	"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
};
export function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined {
	return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}
