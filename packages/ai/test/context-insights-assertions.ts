/** Shared cross-surface timeline assertions; keeps TUI/journal/live parity on one oracle. */
import { expect } from "bun:test";
import type { ContextTimeline } from "../src/context-insights";

export interface TimelineParityOptions {
	/** Journal responses attach fleet rows; the fold under test may not. */
	ignoreAgents?: boolean;
	/** Live folds report `source: "live"` while journal folds report `"journal"`. */
	ignoreSource?: boolean;
	/** Live folds omit the transcript path; journal responses include it. */
	ignoreFile?: boolean;
}

function comparable(timeline: ContextTimeline, options: TimelineParityOptions): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...timeline };
	if (options.ignoreAgents) copy.agents = [];
	if (options.ignoreSource) delete copy.source;
	if (options.ignoreFile) delete copy.file;
	return copy;
}

/** Assert the full version-1 timeline contract: steps, composition, events, files, caps. */
export function expectContextTimelineParity(
	actual: ContextTimeline,
	expected: ContextTimeline,
	options: TimelineParityOptions = {},
): void {
	expect(comparable(actual, options)).toEqual(comparable(expected, options));
}
