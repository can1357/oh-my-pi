/**
 * Claude Code inference-fingerprint constants, kept in a leaf module so consumers
 * outside the provider (`registry/oauth/anthropic`, `usage/claude`) don't
 * import the heavy `providers/anthropic` module.
 *
 * That import edge was a live init cycle: `providers/anthropic` → `stream` →
 * `registry` → `registry/oauth/anthropic` → back into the still-initializing
 * provider module.
 */

/** Current Claude Code CLI version represented on the Anthropic wire. */
export const claudeCodeVersion = "2.1.257";
/** `@anthropic-ai/sdk` version bundled by the current Claude Code release. */
export const claudeCodeSdkVersion = "0.112.1";
/** User-Agent emitted by Claude Code's CLI inference entrypoint. */
export const claudeCodeUserAgent = `claude-cli/${claudeCodeVersion} (external, cli)`;
/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix: string = "_";
/** Identity block prepended by Claude Code's CLI runtime. */
export const claudeCodeSystemInstruction = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Claude Code's per-request output-token ceiling. */
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
