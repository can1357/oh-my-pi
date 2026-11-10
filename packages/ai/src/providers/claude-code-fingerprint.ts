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
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.321";
/** `@anthropic-ai/sdk` version bundled by the current Claude Code release. */
export const claudeCodeSdkVersion = "0.128.0";

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
 * rejection for the rest of the process. A rejected request retries if its
 * client used an older version, even when another request adopted the required
 * version while this one was in flight.
 *
 * Returns false if the client's version already satisfies the rejection or
 * `PI_AI_CLAUDE_CODE_VERSION` explicitly pins the version.
 */
export function adoptRequiredClaudeCodeVersion(error: unknown, clientVersion: string): boolean {
	if (process.env.PI_AI_CLAUDE_CODE_VERSION) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes(VERSION_TOO_OLD_CODE)) return false;
	const required = REQUIRED_VERSION_PATTERN.exec(message)?.[1];
	if (!required || compareSemver(required, clientVersion) <= 0) return false;
	if (compareSemver(required, getClaudeCodeVersion()) > 0) adoptedClaudeCodeVersion = required;
	return true;
}

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix: string = "_";
/** Identity block prepended by Claude Code's CLI runtime. */
export const claudeCodeSystemInstruction = "You are Claude Code, Anthropic's official CLI for Claude.";
