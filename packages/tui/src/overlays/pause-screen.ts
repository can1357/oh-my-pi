/**
 * Fullscreen `/pause` screen.
 *
 * `/pause` engages the process-global {@link agentPauseGate}, freezing every
 * agent loop in the process (main agent, in-process subagents, advisor) at its
 * next safe boundary — nothing is aborted, so a later resume continues exactly
 * where each loop parked. While engaged, this component owns the alternate
 * screen (the `runStartupSplash` idiom) and paints a large pause glyph with a
 * live hold timer; esc / enter / space / ctrl+c releases the gate.
 *
 * Use case: freeze a busy session, hand-edit the repo, resume, then explain
 * the change via a normal steering message.
 */
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { type Component, matchesKey, type OverlayFocusOwner, type OverlayHandle, type OverlayOptions } from "../index";
import { formatCoarseDuration } from "../chrome/format";
import { centerLine, visibleWidth } from "../utils";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../keybinding-matchers";
import { formatKeyHint, formatTooltipKey } from "../app-keybindings";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { col, keyed, node, row, span, text } from "../native/describe";
import { actionBar, actionButton } from "../native/overlay";
import { isNativeRendering } from "../native/state";

/** Outstanding turn and job counts supplied by the pause-screen host. */
export interface PauseWorkStatus {
	unsettledTurns: number;
	unfinishedJobs: number;
}

/** Optional live work source for the pause overlay. */
export interface PauseScreenOptions {
	getWorkStatus?: () => PauseWorkStatus;
}

/**
 * Slice of `InteractiveModeContext` the pause screen drives. Narrow so tests
 * can exercise the full engage → hold → release lifecycle without a real TUI.
 */
export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		/** Paint one frame synchronously, without the scheduler's hop and cadence. */
		renderNow(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
}

const EMPTY_WORK_STATUS: PauseWorkStatus = { unsettledTurns: 0, unfinishedJobs: 0 };

/** Refresh cadence for the live hold clock and work-status snapshot. */
const TICK_MS = 1_000;
/** Pause-bar glyph geometry (rows × columns of full blocks per bar). */
const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

/** Below either bound the full scene cannot breathe; drop to the compact card. */
const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 23;

const TITLE = "P A U S E D";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;

/** What the hold means, one fact per row of the native sheet: icon, what, detail. */
const HOLD_FACTS = [
	["users", "Every agent holds", "Main agent, subagents and advisor stop at their next step."],
	["activity", "Running calls finish", "A reply or tool already under way completes; nothing new starts."],
	["message", "Queued messages wait", "Steering and follow-ups already queued send after you resume."],
	["pen", "The repo is yours", "Edit files freely, then tell the agent what changed."],
] as const;

/** Live hold clock, seconds-precise: `0:07`, `12:34`, `1:02:03`. */
function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Paint the pause scene as exactly `height` rows, vertically centered.
 * Exported for tests.
 */
export function renderPauseScreen(
	width: number,
	height: number,
	elapsedMs: number,
	sessionName?: string,
	workStatus: PauseWorkStatus = EMPTY_WORK_STATUS,
): string[] {
	const screenWidth = Math.max(1, Math.floor(width));
	const screenHeight = Math.max(1, Math.floor(height));
	const compact = screenWidth < MIN_FULL_WIDTH || screenHeight < MIN_FULL_HEIGHT;
	const outstanding = workStatus.unsettledTurns > 0 || workStatus.unfinishedJobs > 0;
	const status = outstanding ? "Pausing — waiting for work to settle" : "Paused — ready to suspend";
	const workCounts = [
		`Unsettled turns: ${workStatus.unsettledTurns}`,
		`Unfinished jobs: ${workStatus.unfinishedJobs}`,
	];
	const content: string[] = [];
	// Resume keys mirror PauseScreenComponent#handleInput: `app.interrupt` (raw Escape when unbound), Enter, Space.
	const esc = interruptKey();

	if (compact) {
		const sessionLine = sessionName
			? centerLine(theme.bold(sessionName.replace(/\s+/g, " ").trim()), screenWidth).trimEnd()
			: undefined;
		const titleLine = centerLine(theme.bold(theme.fg("accent", `▌▌ ${TITLE}`)), screenWidth).trimEnd();
		const clockLine = centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), screenWidth).trimEnd();
		const statusLine = centerLine(theme.fg(outstanding ? "warning" : "success", status), screenWidth).trimEnd();
		const resumeLine = centerLine(theme.fg("dim", `${esc} to resume`), screenWidth).trimEnd();
		const fullContent: string[] = [];
		if (sessionLine) fullContent.push(sessionLine);
		fullContent.push(titleLine, "", clockLine, statusLine);
		if (outstanding)
			fullContent.push(...workCounts.map(line => centerLine(theme.fg("muted", line), screenWidth).trimEnd()));
		fullContent.push(resumeLine);

		if (screenHeight >= fullContent.length) {
			content.push(...fullContent);
		} else {
			// Keep the live state and a way out on screen before the decorative card details.
			if (screenHeight === 1) {
				const counts = `T:${workStatus.unsettledTurns} J:${workStatus.unfinishedJobs}`;
				const summary = outstanding ? `${counts} · ${esc} to resume` : `Paused · ${esc} to resume`;
				const abbreviatedSummary = outstanding
					? `T${workStatus.unsettledTurns} J${workStatus.unfinishedJobs} ${esc} resume`
					: `${esc} resume`;
				const visibleSummary = visibleWidth(summary) > screenWidth ? abbreviatedSummary : summary;
				content.push(
					centerLine(theme.fg(outstanding ? "warning" : "success", visibleSummary), screenWidth).trimEnd(),
				);
			} else if (screenHeight === 2 && outstanding) {
				const counts = `Pausing · T:${workStatus.unsettledTurns} J:${workStatus.unfinishedJobs}`;
				content.push(centerLine(theme.fg("warning", counts), screenWidth).trimEnd(), resumeLine);
			} else {
				content.push(statusLine);
				if (outstanding && screenHeight === 3) {
					content.push(
						centerLine(
							theme.fg("muted", `Turns: ${workStatus.unsettledTurns} · Jobs: ${workStatus.unfinishedJobs}`),
							screenWidth,
						).trimEnd(),
					);
				} else if (outstanding) {
					content.push(...workCounts.map(line => centerLine(theme.fg("muted", line), screenWidth).trimEnd()));
				}
				content.push(resumeLine);
			}

			if (content.length < screenHeight && sessionLine) content.push(sessionLine);
			if (content.length < screenHeight) content.push(titleLine);
			if (content.length < screenHeight) content.push(clockLine);
		}
	} else {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName.replace(/\s+/g, " ").trim()), screenWidth).trimEnd());
			content.push("");
		}
		const bar = "█".repeat(BAR_WIDTH);
		const glyphRow = `${bar}${" ".repeat(BAR_GAP)}${bar}`;
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(theme.fg("accent", glyphRow), screenWidth).trimEnd());
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", TITLE)), screenWidth).trimEnd());
		content.push("");
		for (const line of BODY_LINES) {
			content.push(centerLine(theme.fg("muted", line), screenWidth).trimEnd());
		}
		content.push(centerLine(theme.fg(outstanding ? "warning" : "success", status), screenWidth).trimEnd());
		if (outstanding) {
			content.push(centerLine(theme.fg("muted", workCounts[0]!), screenWidth).trimEnd());
			content.push(centerLine(theme.fg("muted", workCounts[1]!), screenWidth).trimEnd());
		}
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), screenWidth).trimEnd());
		content.push("");
		const resumeHint = `${esc} · ${formatKeyHint("enter")} · ${formatKeyHint("space")} — resume`;
		content.push(centerLine(theme.fg("dim", resumeHint), screenWidth).trimEnd());
	}

	const topPad = Math.max(0, Math.floor((screenHeight - content.length) / 2));
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const lines: string[] = new Array(topPad).fill("");
	lines.push(...content);
	while (lines.length < screenHeight) lines.push("");
	return lines.slice(0, screenHeight);
}

/** Fullscreen overlay component; resolves {@link run} when a resume key lands. */
export class PauseScreenComponent implements Component, OverlayFocusOwner {
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	#startedAt = Date.now();
	#native: NativeNode | undefined;
	#workSnapshot: PauseWorkStatus;

	constructor(
		readonly host: PauseScreenHost,
		readonly options: PauseScreenOptions = {},
	) {
		this.#workSnapshot = this.#readWorkSnapshot();
	}

	/** Start the clock; resolves once the user asks to resume. */
	run(): Promise<void> {
		this.#startedAt = agentPauseGate.pausedAt ?? Date.now();
		this.#native = undefined;
		this.#refreshWorkSnapshot();
		this.#timer ??= setInterval(() => {
			if (this.#disposed) return;
			const statusChanged = this.#refreshWorkSnapshot();
			if (statusChanged || !isNativeRendering()) this.host.ui.requestRender();
		}, TICK_MS);
		this.host.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		// Every dismissal path resumes — including ctrl+c, which must never
		// double as "abort agents" while the whole point of the screen is that
		// nothing gets lost.
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+c")
		) {
			if (!this.#disposed) this.#done.resolve();
		}
	}

	invalidate(): void {
		this.#native = undefined;
	}

	#readWorkSnapshot(): PauseWorkStatus {
		const workStatus = this.options.getWorkStatus?.() ?? EMPTY_WORK_STATUS;
		return {
			unsettledTurns: workStatus.unsettledTurns,
			unfinishedJobs: workStatus.unfinishedJobs,
		};
	}

	#refreshWorkSnapshot(): boolean {
		const next = this.#readWorkSnapshot();
		const previous = this.#workSnapshot;
		if (next.unsettledTurns === previous.unsettledTurns && next.unfinishedJobs === previous.unfinishedJobs) {
			return false;
		}
		this.#workSnapshot = next;
		this.#native = undefined;
		return true;
	}

	/** A glass sheet titled "Paused" (not the whole pane: the transcript stays visible, frozen). */
	readonly nativeOverlay = { role: "omp.overlay.pause", size: "md", anchor: "center", head: "Paused" } as const;

	/**
	 * The sheet: a hero (the pause glyph beside the live hold clock and the
	 * session it holds), what the hold means as four facts, and a footer that
	 * reassures and resumes. The resume keys live in the button's tooltip.
	 */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const snapshot = this.#workSnapshot;
		const outstanding = snapshot.unsettledTurns > 0 || snapshot.unfinishedJobs > 0;
		const status = col(
			[
				keyed(
					text(
						[
							span(
								outstanding ? "Pausing — waiting for work to settle" : "Paused — ready to suspend",
								outstanding ? "warning" : "success",
							),
						],
						{ role: "omp.pause.settlement" },
					),
					"settlement",
				),
				...(outstanding
					? [
							keyed(
								text([span(`Unsettled turns: ${snapshot.unsettledTurns}`, "muted")], {
									role: "omp.pause.unsettled-turn-count",
								}),
								"unsettled-turns",
							),
							keyed(
								text([span(`Unfinished jobs: ${snapshot.unfinishedJobs}`, "muted")], {
									role: "omp.pause.unfinished-job-count",
								}),
								"unfinished-jobs",
							),
						]
					: []),
			],
			{ role: "omp.pause.settlement-status", gap: "sm" },
		);
		const resumeKey = boundKeys("app.interrupt", ["escape"])[0] ?? "escape";
		const hero = row(
			[
				node("icon", { name: "pause", role: "omp.pause.glyph" }, undefined, "glyph"),
				col(
					[
						node(
							"elapsed",
							{
								age: Date.now() - this.#startedAt,
								format: "clock",
								role: "omp.pause.clock",
								title: "Paused for",
							},
							undefined,
							"clock",
						),
						keyed(
							text([span(this.host.sessionName ?? "Every agent in this session", "muted")], {
								role: "omp.pause.session",
								wrap: "none",
								truncate: "end",
							}),
							"session",
						),
					],
					{ gap: "none", grow: 1, shrink: 1 },
				),
			],
			{ role: "omp.pause.hero", gap: "md", align: "center" },
		);
		const facts = col(
			HOLD_FACTS.map(([icon, what, detail], index) =>
				keyed(
					row(
						[
							node("icon", { name: icon }),
							col([text([span(what, "strong")]), text([span(detail, "muted")], { wrap: "word" })], {
								gap: "none",
								grow: 1,
								shrink: 1,
							}),
						],
						{ role: "omp.pause.fact", gap: "md", align: "start" },
					),
					`fact-${index}`,
				),
			),
			{ role: "omp.pause.facts", gap: "md" },
		);
		this.#native = col(
			[
				keyed(hero, "hero"),
				keyed(status, "settlement-status"),
				keyed(facts, "facts"),
				actionBar([
					null,
					actionButton("Resume", "resume", {
						keys: resumeKey,
						tone: "accent",
						// Each ` · ` clause ending in two spaces and a key is a keycap: `Resume [esc] · [⏎] · [space]`.
						title: `Resume  ${formatTooltipKey(resumeKey)} ·   ${formatTooltipKey("enter")} ·   ${formatTooltipKey("space")}`,
					}),
				]),
			],
			{ gap: "md" },
		);
		return this.#native;
	}

	/** Resume runs what Esc/Enter/Space run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "resume" && !this.#disposed) this.#done.resolve();
	}

	render(width: number): readonly string[] {
		const elapsed = Date.now() - this.#startedAt;
		return renderPauseScreen(
			Math.max(1, width),
			Math.max(1, this.host.ui.terminal.rows),
			elapsed,
			this.host.sessionName,
			this.#workSnapshot,
		);
	}
}

/**
 * Engage the global pause gate and hold the fullscreen pause screen until the
 * user resumes. No-op when the gate is already engaged. Always releases the
 * gate on the way out (including teardown throws) — a leaked pause would
 * freeze every agent in the process with no UI left to release it.
 */
export async function runPauseScreen(host: PauseScreenHost, options?: PauseScreenOptions): Promise<void> {
	if (!agentPauseGate.pause()) return;
	const component = new PauseScreenComponent(host, options);
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		host.ui.setFocus(component);
		await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
		// Paint before the gate opens, never after. `overlay.hide()` only
		// *schedules* a frame (one scheduler hop, then the frame cadence and the
		// adaptive floor), while `resume()` wakes every parked agent loop in this
		// same tick: their microtasks, and everything those loops queue, run ahead
		// of that frame. Until it lands the terminal still holds the frame this
		// overlay drew PAUSED on, so a reader of the pane — a person, or an
		// operator running `tmux capture-pane` — sees a session that is already
		// working as still held. Measured 2026-10-28 on pane %11 of the grouped
		// `agents` sessions: the gate opened 2.0 s after the resume key and the
		// pane still showed the overlay, hold timer frozen, 4.4 s after it.
		try {
			host.ui.renderNow();
		} finally {
			// Unconditional: a paint that throws must not strand the gate, or
			// every agent in the process freezes with no UI left to release it.
			const heldMs = agentPauseGate.resume();
			if (heldMs !== undefined) {
				host.showStatus(`Resumed after ${formatCoarseDuration(heldMs)} — agents are running again.`);
			}
		}
	}
}
