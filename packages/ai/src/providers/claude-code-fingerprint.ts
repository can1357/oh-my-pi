/**
 * Claude Code inference-fingerprint constants, kept in a leaf module so consumers
 * outside the provider (`registry/oauth/anthropic`, `usage/claude`) don't
 * import the heavy `providers/anthropic` module.
 *
 * That import edge was a live init cycle: `providers/anthropic` → `stream` →
 * `registry` → `registry/oauth/anthropic` → back into the still-initializing
 * provider module.
 */

/**
 * Pinned Claude Code CLI version: the offline fallback for {@link getClaudeCodeVersion}.
 * Bumped to the latest npm release by `bun run check-spoofed-versions --update`.
 */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";
/** `@anthropic-ai/sdk` version bundled by the current Claude Code release. */
export const claudeCodeSdkVersion = "0.112.1";

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TOO_OLD_CODE = "claude_code_version_too_old";
const REQUIRED_VERSION_PATTERN = /version (\d+\.\d+\.\d+) or newer is required/i;

let adoptedClaudeCodeVersion: string | null = null;

/**
 * Claude Code CLI version represented on the Anthropic wire (User-Agent, billing
 * header): `PI_AI_CLAUDE_CODE_VERSION` → version adopted from a server rejection
 * (see {@link adoptRequiredClaudeCodeVersion}) → {@link DEFAULT_CLAUDE_CODE_VERSION}.
 */
export function getClaudeCodeVersion(): string {
	return process.env.PI_AI_CLAUDE_CODE_VERSION || adoptedClaudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION;
}

/** User-Agent emitted by Claude Code's CLI inference entrypoint. */
export function getClaudeCodeUserAgent(): string {
	return `claude-cli/${getClaudeCodeVersion()} (external, cli)`;
}

function compareSemver(a: string, b: string): number {
	const pa = SEMVER_PATTERN.exec(a);
	const pb = SEMVER_PATTERN.exec(b);
	if (!pa || !pb) return 0;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(pa[i]) - Number(pb[i]);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Adopts the minimum version named by an Anthropic `claude_code_version_too_old`
 * rejection for the rest of the process, so the pinned fallback going stale costs
 * one rejected request instead of a hard failure.
 *
 * Returns true only when the wire version actually increased — callers retry on
 * true, so a repeated rejection at the same version cannot loop. Always false
 * while `PI_AI_CLAUDE_CODE_VERSION` pins the version explicitly.
 */
export function adoptRequiredClaudeCodeVersion(error: unknown): boolean {
	if (process.env.PI_AI_CLAUDE_CODE_VERSION) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes(VERSION_TOO_OLD_CODE)) return false;
	const required = REQUIRED_VERSION_PATTERN.exec(message)?.[1];
	if (!required || compareSemver(required, getClaudeCodeVersion()) <= 0) return false;
	adoptedClaudeCodeVersion = required;
	return true;
}

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix: string = "_";
/** Identity block prepended by Claude Code's CLI runtime. */
export const claudeCodeSystemInstruction = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Claude Code's per-request output-token ceiling. */
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
