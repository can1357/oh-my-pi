/** Cursor sand InferenceService base endpoint. */

import { providerEntry, seedModels } from "../compat/providers";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
/** Catalog API tag used by live Grok Bot discovery. */
export const GROKBOT_API = "grokbot-sand" as const;
/**
 * Stable, non-secret identity for caller-provided Grok Bot headers. HTTP header
 * names are case-insensitive, so canonicalize them through Headers before hashing.
 */
export function fingerprintGrokbotCustomHeaders(headers?: Readonly<Record<string, string>>): string {
	if (!headers || Object.keys(headers).length === 0) return "";
	const canonicalHeaders = [...new Headers(headers).entries()].sort(([left], [right]) => left.localeCompare(right));
	return Bun.hash(canonicalHeaders.map(([name, value]) => `${name}\0${value}`).join("\0")).toString(36);
}

const grokbotDefaultModel = providerEntry("grokbot")?.defaultModel;
if (!grokbotDefaultModel) throw new Error("Grok Bot provider has no default model");

/** KDL-owned provider default used by login verification and offline selection. */
export const GROKBOT_DEFAULT_MODEL_ID = grokbotDefaultModel;

/** KDL-owned identities verified to accept agent tools. */
export const GROKBOT_TOOL_CAPABLE_MODEL_IDS: readonly string[] = Object.freeze(
	seedModels<"grokbot-sand">("grokbot")
		.filter(model => model.supportsTools)
		.map(model => model.id),
);

/** Verification order: routed provider default, then remaining tool-capable seeds. */
export const GROKBOT_INFERENCE_PROBE_MODEL_IDS: readonly string[] = Object.freeze([
	GROKBOT_DEFAULT_MODEL_ID,
	...GROKBOT_TOOL_CAPABLE_MODEL_IDS.filter(id => id !== GROKBOT_DEFAULT_MODEL_ID),
]);

/** Normalize the configured sand endpoint exactly as runtime discovery does. */
export function resolveGrokbotBackend(baseUrl?: string): string {
	return (baseUrl ?? GROKBOT_BACKEND).replace(/\/+$/, "");
}
