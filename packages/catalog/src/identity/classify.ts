/**
 * Model-id classification: parse a model id into its family (gemini / anthropic /
 * openai), kind/variant, and version. This is the shared layer both catalog
 * policy rules (`model-thinking.ts`) and downstream consumers build on —
 * classification lives here, the rules that consume it stay with their domain.
 */

export type SemVer = {
	major: number;
	minor: number;
	patch: number;
};

export type GeminiKind = "pro" | "flash";
export type AnthropicKind = "opus" | "sonnet" | "fable" | "mythos";
export type OpenAIVariant = "base" | "codex" | "codex-max" | "codex-mini" | "codex-spark" | "mini" | "max" | "nano";
export type GlmVariant = "base" | "air" | "turbo" | "flash" | "flashx" | "preview";

export interface GeminiModel {
	family: "gemini";
	kind: GeminiKind;
	version: SemVer;
}

export interface AnthropicModel {
	family: "anthropic";
	kind: AnthropicKind;
	version: SemVer;
}

export interface OpenAIModel {
	family: "openai";
	variant: OpenAIVariant;
	version: SemVer;
}

export interface GlmModel {
	family: "glm";
	/** Suffix variant (`-air`, `-turbo`, `-flash`, `-flashx`, `-preview`); `base` when none. */
	variant: GlmVariant;
	/** Vision SKU — the `v` that attaches directly to the version (`glm-4v`, `glm-4.5v`). */
	vision: boolean;
	version: SemVer;
}

export interface UnknownModel {
	family: "unknown";
	id: string;
}

export type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;

/** Strip a provider namespace prefix (`openai/gpt-5.4` → `gpt-5.4`). */
// Cache keyed by model id (a bounded set of bundled/aggregator ids), so no eviction is needed.
const bareModelIdCache = new Map<string, string>();
export function bareModelId(modelId: string): string {
	const cached = bareModelIdCache.get(modelId);
	if (cached !== undefined) return cached;
	const p = modelId.lastIndexOf("/");
	const result = p !== -1 ? modelId.slice(p + 1) : modelId;
	bareModelIdCache.set(modelId, result);
	return result;
}

export function parseKnownModel(modelId: string): ParsedModel {
	const canonicalId = bareModelId(modelId);
	return (
		parseGeminiModel(canonicalId) ??
		parseAnthropicModel(canonicalId) ??
		parseOpenAIModel(canonicalId) ?? { family: "unknown", id: canonicalId }
	);
}

/**
 * Wrap a parse function in a per-id memo cache. Caches the `null` result too, so
 * repeated misses (the common case — ids of other families) stay O(1) and never
 * re-run the regex/semver work.
 */
function parser<T>(parse: (modelId: string) => T | null): (modelId: string) => T | null {
	const cache = new Map<string, T | null>();
	return modelId => {
		const hit = cache.get(modelId);
		if (hit !== undefined || cache.has(modelId)) {
			return hit ?? null;
		}
		const result = parse(modelId);
		cache.set(modelId, result);
		return result;
	};
}

const GEMINI_SUFFIX = "-preview";
export const parseGeminiModel = parser((modelId): GeminiModel | null => {
	if (modelId.endsWith(GEMINI_SUFFIX)) {
		modelId = modelId.slice(0, -GEMINI_SUFFIX.length);
	}
	const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "gemini", kind: match[2] as GeminiKind, version };
});

export const parseAnthropicModel = parser((modelId): AnthropicModel | null => {
	const kindFirst = /claude-(opus|sonnet|fable|mythos)-(\d{1,2}(?:[.-]\d{1,2}){0,2})\b/.exec(modelId);
	const versionFirst = kindFirst
		? null
		: /claude-(\d{1,2}(?:[.-]\d{1,2}){0,2})-(opus|sonnet|fable|mythos)\b/.exec(modelId);
	const kind = kindFirst?.[1] ?? versionFirst?.[2];
	const versionInput = kindFirst?.[2] ?? versionFirst?.[1];
	if (!kind || !versionInput) {
		return null;
	}
	const version = parseSemVer(versionInput);
	if (!version) {
		return null;
	}
	return { family: "anthropic", kind: kind as AnthropicKind, version };
});

/**
 * Rolling OpenAI aliases inherit wire capabilities from their current default
 * snapshots. Keep this map aligned with the model docs when an alias advances.
 */
const OPENAI_ALIAS_VERSIONS: Readonly<Record<string, string>> = {
	"daybreak-blue-latest": "5.6",
	"gpt-daybreak-blue-latest": "5.6",
	"daybreak-red-latest": "5.6",
	"gpt-daybreak-red-latest": "5.6",
};

export const parseOpenAIModel = parser((modelId): OpenAIModel | null => {
	const aliasVersion = OPENAI_ALIAS_VERSIONS[modelId];
	const match = aliasVersion
		? null
		: /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|mini|max|nano))?\b/.exec(modelId);
	const versionInput = aliasVersion ?? match?.[1];
	if (!versionInput) {
		return null;
	}
	const version = parseSemVer(versionInput);
	if (!version) {
		return null;
	}
	return { family: "openai", variant: (match?.[2] as OpenAIVariant | undefined) ?? "base", version };
});

/**
 * Parse a GLM (Zhipu / Z.AI) model id into family + variant + vision + version.
 * Shape: `glm-<version>[v][-<variant>]` — e.g. `glm-4.5`, `glm-4.5-air`,
 * `glm-5-turbo`, `glm-4.5v`, `glm-5-preview`. The `v` (vision) attaches to the
 * version; other variants are `-` suffixes. Standalone like `parseAnthropicModel`
 * is used in family.ts — GLM needs no global thinking policy, so it stays out of
 * `parseKnownModel`.
 */
export const parseGlmModel = parser((modelId): GlmModel | null => {
	const match = /glm-(\d{1,2}(?:\.\d+)?)(v)?(?:-(air|turbo|flashx|flash|preview))?\b/i.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return {
		family: "glm",
		variant: (match[3]?.toLowerCase() as GlmVariant | undefined) ?? "base",
		vision: match[2]?.toLowerCase() === "v",
		version,
	};
});

export function isFableOrMythos(kind: AnthropicKind): boolean {
	return kind === "fable" || kind === "mythos";
}

/**
 * Returns true if the parsed Anthropic model is part of the adaptive-thinking
 * Claude generation at or above a specific capability threshold.
 * - Opus has a configurable minimum version floor (e.g. "4.6", "4.7", "4.8").
 * - Sonnet, Fable, and Mythos all require version 5 or higher.
 */
export function isAnthropicAdaptiveGenAtLeast(parsed: AnthropicModel, opusMin: "4.6" | "4.7" | "4.8"): boolean {
	if (parsed.kind === "opus") {
		return semverGte(parsed.version, opusMin);
	}
	// Sonnet 5+, Fable 5+, Mythos 5+, and any future gen-5+ models
	return semverGte(parsed.version, "5");
}

function createSemVer(major: number, minor: number, patch = 0): SemVer {
	return { major, minor, patch };
}

// Fast path for the common 1–2 component versions; anything the table misses
// (large minors, 3-part versions) parses dynamically below so no future
// version ever classifies as unknown (the failure class #8256 fixed).
const precomputeTable: Record<string, SemVer> = {};
for (let major = 0; major <= 9; major++) {
	for (let minor = 0; minor <= 10; minor++) {
		const version = createSemVer(major, minor, 0);
		precomputeTable[`${major}.${minor}`] = version;
		precomputeTable[`${major}-${minor}`] = version;
	}
	precomputeTable[`${major}`] = createSemVer(major, 0, 0);
}

const SEMVER_PATTERN = /^(\d{1,2})(?:[.-](\d{1,2}))?(?:[.-](\d{1,2}))?$/;

export function parseSemVer(version: string): SemVer | null {
	const hit = precomputeTable[version];
	if (hit) return hit;
	const match = SEMVER_PATTERN.exec(version);
	if (!match) return null;
	return createSemVer(Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0));
}

export function semverGte(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) >= 0;
}

export function semverEqual(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) === 0;
}

export function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number {
	left = typeof left === "string" ? parseSemVer(left) : left;
	right = typeof right === "string" ? parseSemVer(right) : right;
	if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);

	if (left.major !== right.major) {
		return left.major - right.major;
	}
	if (left.minor !== right.minor) {
		return left.minor - right.minor;
	}
	return left.patch - right.patch;
}
