/**
 * Naming a compaction.
 *
 * This file used to parse the prose `/compact` printed — `Compaction complete.
 * Tokens: 256320 -> 19880 (saved 236440).` — because a manual pass announced
 * itself no other way. It does now: both paths emit `auto_compaction_start` /
 * `auto_compaction_end`, with a `reason` that separates an operator asking from
 * the engine deciding, and the end carries `tokensAfter`. The regexes are gone
 * and only the wording is left.
 */

/** A compaction in flight, as this client sees it. */
export interface CompactionProgress {
	/**
	 * A manual run is cancellable: `compact` bypasses the server's serial command
	 * queue, so an `abort` can still reach it. An automatic one is the engine's
	 * own decision, mid-turn, and is not offered as a thing to stop.
	 */
	origin: "manual" | "auto";
	/** Context tokens when it started. */
	tokensBefore?: number;
	/** The method the engine settled on. */
	action?: string;
	/** Why it started. */
	reason?: string;
	/** Latest narration, from `notice` frames the engine emits on fallback. */
	note?: string;
}

/** `87272` → `87.3K`, the way the status bar and the terminal both write it. */
export function compactTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1)}K`;
}

/**
 * The method names the terminal prints on its divider, from
 * `packages/coding-agent/src/modes/components/compaction-summary-message.ts`.
 */
export function compactionMethodLabel(method: string | undefined): string {
	switch (method) {
		case "remote":
			return "remote-compacted";
		case "soft":
			return "soft-compacted";
		case "handoff":
			return "handed-off";
		case "snapcompact":
			return "snap-compacted";
		case "shake":
			return "shaken";
		default:
			return "compacted";
	}
}

const AUTO_REASON: Record<string, string> = {
	overflow: "Context overflow detected, ",
	incomplete: "Response incomplete, ",
	idle: "Idle ",
	threshold: "",
};

const AUTO_ACTION: Record<string, string> = {
	remote: "Auto server compaction",
	handoff: "Auto-handoff",
	shake: "Auto-shake",
	snapcompact: "Auto-snapcompact",
	soft: "Auto soft compaction",
	"context-full": "Auto context-full maintenance",
};

/**
 * What to call the pass that is running.
 *
 * The automatic wording is copied from `event-controller.ts` so the desktop and
 * the terminal describe the same event the same way — someone reading both
 * should not have to work out that they mean the same thing.
 */
export function compactionLabel(progress: CompactionProgress): string {
	if (progress.origin === "manual") {
		// Before the engine reports a method there is nothing to name but the act.
		return progress.action ? `Compacting · ${compactionMethodLabel(progress.action)}…` : "Compacting context…";
	}
	const reason = AUTO_REASON[progress.reason ?? "threshold"] ?? "";
	const action = AUTO_ACTION[progress.action ?? ""] ?? "Auto context-full maintenance";
	return `${reason}${action}…`;
}

/*
 * Refusals that mean "there was nothing to do", not "something went wrong".
 *
 * Read from the response's machine-readable `code`, not from its sentence. This
 * file used to match the engine's prose here — the last place it did — and the
 * server now labels these itself, so the regexes are gone from both ends.
 */
const BENIGN_CODES = new Set(["already_compacted", "nothing_to_compact"]);

export function isBenignRefusal(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return typeof code === "string" && BENIGN_CODES.has(code);
}

/** The operator's own cancellation, which is not a failure to report at them. */
export function isCancellation(cause: unknown): boolean {
	return (cause as { code?: unknown } | null)?.code === "cancelled";
}
