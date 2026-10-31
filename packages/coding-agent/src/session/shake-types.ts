/**
 * Public shape of the `shake` operation, kept in a dependency-free leaf module
 * so slash-command registries and controllers can import `formatShakeSummary`
 * without pulling in the heavy `agent-session` module graph (which would form
 * an import cycle through the slash-command registry).
 */

import type { ShakeConfig } from "@oh-my-pi/pi-agent-core/compaction";

/** Mode selector for `AgentSession.shake`. */
export type ShakeMode = "elide" | "images" | "thinking";

/** Options for artifact-backed elision through the extension context. */
export interface ShakeOptions {
	/** Custom shake configuration (thresholds, protected tools, etc.). */
	config?: ShakeConfig;
	/** Keep this many newest user-started exchanges intact, including their tool results. */
	protectTurns?: number;
	/** Elide only tool results (skip fenced/XML blocks in messages). */
	toolResultsOnly?: boolean;
	/** Require saving a recovery artifact before eliding; fails if persistence is unavailable. */
	requireArtifact?: boolean;
	/** Handler cancellation is composed with this signal before any history mutation. */
	signal?: AbortSignal;
}

/** Options for extension-invoked `ctx.shake`. */
export type ExtensionShakeOptions = ShakeOptions;

/** Normalize `(options?)` and `(mode, options?)` call forms for `ctx.shake`. */
export function normalizeExtensionShakeCall(
	modeOrOptions?: ShakeMode | ShakeOptions,
	options?: ShakeOptions,
): { mode: ShakeMode; options: ShakeOptions } {
	const mode: ShakeMode = typeof modeOrOptions === "string" ? modeOrOptions : "elide";
	const rawOptions: ShakeOptions = (typeof modeOrOptions === "string" ? options : modeOrOptions) ?? {};
	const requireArtifact = rawOptions.requireArtifact ?? (mode === "elide" ? true : undefined);
	return {
		mode,
		options: requireArtifact === undefined ? { ...rawOptions } : { ...rawOptions, requireArtifact },
	};
}

/** Outcome of an `AgentSession.shake` run. */
export interface ShakeResult {
	mode: ShakeMode;
	/** Whole tool-call results dropped. */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped. */
	blocksDropped: number;
	/** Image blocks removed (images mode only). */
	imagesDropped?: number;
	/** Thinking blocks dropped (thinking mode only). */
	thinkingBlocksDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the dropped originals, when persisted. */
	artifactId?: string;
}

/** One-line operator summary of a {@link ShakeResult} (shared by TUI + ACP). */
export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? "No images found in this session."
			: `Dropped ${n} image${n === 1 ? "" : "s"} from this session.`;
	}
	if (result.mode === "thinking") {
		const n = result.thinkingBlocksDropped ?? 0;
		return n === 0
			? "No thinking blocks found in this session."
			: `Dropped ${n} thinking block${n === 1 ? "" : "s"} from this session${result.tokensFreed > 0 ? ` (~${result.tokensFreed} tokens freed)` : ""}.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`);
	}
	if (result.blocksDropped > 0) {
		parts.push(`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`);
	}
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
}
