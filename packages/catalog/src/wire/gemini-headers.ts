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

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
/**
 * Antigravity / Cloud Code Assist user agent. Lives in its own file so discovery
 * and usage code can read it without pulling the heavy google-gemini-cli provider
 * (and its @google/genai → google-auth-library dependency chain) into the startup
 * parse graph.
 */
export let getAntigravityUserAgent = () => {
	const DEFAULT_ANTIGRAVITY_VERSION = "2.1.4";
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	// Map Node.js platform/arch to Antigravity's expected format.
	// Verified against Antigravity source: _qn() and wqn() in main.js.
	// process.platform: win32→windows, others pass through (darwin, linux)
	// process.arch:     x64→amd64, ia32→386, others pass through (arm64)
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	const userAgent = `antigravity/hub/${version} ${os}/${arch}`;
	getAntigravityUserAgent = () => userAgent;
	return userAgent;
};

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
	"claude-sonnet-4-5": { maxOutputTokens: 64000 },
	"claude-sonnet-4-5-thinking": { maxOutputTokens: 64000 },
	"claude-opus-4-5": { maxOutputTokens: 64000 },
	"claude-opus-4-5-thinking": { maxOutputTokens: 64000 },
	"claude-3-7-sonnet": { maxOutputTokens: 64000 },
	"claude-3-7-sonnet-thinking": { maxOutputTokens: 64000 },
	"claude-3-5-sonnet": { maxOutputTokens: 64000 },
	"claude-3-5-sonnet-v2": { maxOutputTokens: 64000 },
	"claude-3-5-haiku": { maxOutputTokens: 64000 },
	"gpt-oss-120b": { maxOutputTokens: 32768 },
	"gpt-oss-120b-medium": { maxOutputTokens: 32768 },
};
export function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined {
	const existing = ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
	if (existing) {
		return existing;
	}
	const normalized = wireModelId.toLowerCase();
	if (normalized.includes("claude")) {
		return { maxOutputTokens: 64000 };
	}
	if (normalized.includes("gpt-oss")) {
		return { maxOutputTokens: 32768 };
	}
	return undefined;
}
