/**
 * The interactive status line's data model ({@link SessionStatusLine}) over
 * a stand-in session, and its bar painted to plain text.
 */
import "../../src/ui/styles/status";
import { signal } from "@oh-my-pi/pi-tui";
import type { StatusLineSegmentId } from "../../src/config/status-line-schema";
import { SessionStatusLine } from "../../src/modes/interactive/status-line";
import type { StatusLineSettings } from "../../src/modes/view-model/status-line/types";
import type { AgentViewSession } from "../../src/session/agent-session-handle";
import { printRows } from "../../src/ui/print-rows";
import type { StatusFacts } from "../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../src/ui/status/segments";
import { StatusLine } from "../../src/ui/status/status-line";

/** Session members the status line reads, every one overridable. */
export type StatusSessionStub = Record<string, unknown>;

/** A session the status line can read: no model, no usage, no activity unless `overrides` say so. */
export function statusSession(overrides: StatusSessionStub = {}): AgentViewSession {
	const sessionManager = {
		getSessionName: () => undefined,
		getSessionId: () => "session-id",
		getUsageStatistics: () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			premiumRequests: 0,
			cost: 0,
			subagentCost: 0,
		}),
		...(overrides.sessionManager as object | undefined),
	};
	return {
		subscribe: () => () => {},
		state: { messages: [], model: undefined, thinkingLevel: undefined },
		messages: [],
		model: undefined,
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAnthropicSlowModeLabel: () => undefined,
		getAdvisorCost: () => 0,
		isAdvisorUsingSubscription: () => false,
		getGoalModeState: () => undefined,
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		compactionSpeculation: undefined,
		modelRegistry: { isUsingSubscription: () => false },
		...overrides,
		sessionManager,
	} as unknown as AgentViewSession;
}

const openLines: SessionStatusLine[] = [];

/** A status line over `session` showing `settings` (on top of the saved ones); disposed by {@link disposeStatusLines}. */
export function statusLine(session: AgentViewSession, settings?: Partial<StatusLineSettings>): SessionStatusLine {
	const line = new SessionStatusLine(session);
	if (settings) line.previewSettings(settings);
	openLines.push(line);
	return line;
}

/** Dispose every status line the file created (call in `afterEach`). */
export function disposeStatusLines(): void {
	for (const line of openLines.splice(0)) line.dispose();
}

/** The bar for `facts` under `settings`, painted at `width`, escapes kept. */
export function statusRows(settings: StatusLineSettings, facts: StatusFacts, width = 160): string[] {
	return printRows(
		() =>
			StatusLine({
				settings: () => settings,
				facts: () => facts,
				placement: signal({ bar: "full", gap: false, autocomplete: false }),
			}),
		width,
	);
}

/** {@link statusRows} as plain text. */
export function statusText(settings: StatusLineSettings, facts: StatusFacts, width = 160): string {
	return Bun.stripANSI(statusRows(settings, facts, width).join("\n"));
}

/** The model's current bar as plain text. */
export function lineText(line: SessionStatusLine, width = 160): string {
	return statusText(line.settings(), line.facts(), width);
}

/** Let queued session events and background reads settle. */
export async function flushStatus(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Facts of an idle session with no model, usage or activity, `patch` applied. */
export function statusFacts(patch: Partial<StatusFacts> = {}): StatusFacts {
	return {
		sessionId: "session-id",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		},
		usingSubscription: false,
		context: { tokens: 0, window: 0, percent: null },
		autoCompact: true,
		cwd: "/repo",
		home: "/home/user",
		now: 0,
		subagents: 0,
		jobs: 0,
		activeMs: 0,
		hooks: [],
		...patch,
	};
}

/**
 * Terminal text of segment `id` (its look's text pieces) for `facts` under
 * `settings` (default: the custom preset), or null while it shows nothing.
 */
export function segmentText(
	id: StatusLineSegmentId,
	facts: StatusFacts,
	settings: StatusLineSettings = { preset: "custom" },
): string | null {
	const view = segmentView(id, facts, effectiveStatusSettings(settings));
	return view ? view.look.pieces.map(piece => ("t" in piece ? piece.t : "")).join("") : null;
}
