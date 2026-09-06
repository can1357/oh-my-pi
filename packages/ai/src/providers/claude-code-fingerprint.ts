/**
 * Cowork inference-fingerprint constants, kept in a leaf module so consumers
 * outside the provider (`registry/oauth/anthropic`, `usage/claude`) don't
 * import the heavy `providers/anthropic` module.
 *
 * That import edge was a live init cycle: `providers/anthropic` → `stream` →
 * `registry` → `registry/oauth/anthropic` → back into the still-initializing
 * provider module.
 */

/** Claude runtime version bundled by the current Cowork desktop release. */
export const claudeCodeVersion = "2.1.246";
/** `@anthropic-ai/sdk` version bundled by the current Cowork desktop release. */
export const claudeCodeSdkVersion = "0.112.1";
/** User-Agent emitted by Cowork's `claude-desktop` inference entrypoint. */
export const coworkUserAgent = `claude-cli/${claudeCodeVersion} (external, claude-desktop)`;
/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix: string = "_";
/** Identity block prepended by Cowork's Claude runtime. */
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** Cowork's per-request output-token ceiling. */
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
