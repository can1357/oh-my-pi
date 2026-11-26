/**
 * A bash call's shell-viz state: the view preferences its `shell` node and
 * the focused inspector share, and the replay clock that walks the trace's
 * history while playing.
 *
 * Actions use the shared vocabulary (`view:raw`, `layer:color`, `split`,
 * `play`, `pause`, `step`, `reset`, `live`, `seek:3`, `speed:2`,
 * `select:<node>`, `expand:<node>`).
 */
import { batch, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { ShellTrace, ShellVizPreferences } from "@oh-my-pi/pi-wire";
import { defaultShellVizPreferences } from "../../tools/shell-viz";
import { applyShellVizAction } from "../apps/shell-visualizer/model";

/** How often a playing replay advances its cursor. */
const REPLAY_TICK_MS = 80;

/** See the module docs. */
export class ShellVizState {
	readonly preferences: Signal<ShellVizPreferences> = signal(defaultShellVizPreferences());
	/** Bumped when the replay restarts from another position (reset, live, a seek, play from the end). */
	readonly replayEpoch: Signal<number> = signal(0);
	readonly #trace: () => ShellTrace | undefined;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	/** When the replay clock was last read. */
	#at = 0;
	/** The replay clock, in trace nanoseconds. */
	#ns = 0;
	/** The replay clock was set from a cursor (not following the live run). */
	#positioned = false;

	/** `trace` reads the run's current trace without subscribing; `now` is the replay's clock in ms. */
	constructor(trace: () => ShellTrace | undefined, now: () => number = () => performance.now()) {
		this.#trace = trace;
		this.#now = now;
	}

	/** Apply a shell-viz action, starting or stopping the replay clock as it asks. */
	action(action: string): void {
		const before = this.preferences.peek();
		const trace = this.#trace();
		const history = trace?.history ?? [];
		const now = this.#now();
		if (before.playing) this.#ns += (now - this.#at) * 1_000_000 * before.speed;
		const next = applyShellVizAction(before, action, history.length);
		const seek = /^seek:[0-9]+$/.test(action);
		const seeking = action === "reset" || action === "step" || seek;
		const restarting = action === "play" && (before.cursor === undefined || before.cursor >= history.length);
		batch(() => {
			this.preferences.set(next);
			if (action === "reset" || action === "live" || seek || restarting) this.replayEpoch.update(n => n + 1);
		});
		if (action === "live") this.#positioned = false;
		else if (seeking || restarting || (!this.#positioned && next.playing)) {
			const cursor = next.cursor ?? 0;
			this.#ns = history[cursor - 1]?.t_ns ?? (trace?.historyTruncated ? (history[0]?.t_ns ?? 0) : 0);
			this.#positioned = true;
		}
		if (!next.playing) {
			this.stop();
			return;
		}
		this.#at = now;
		if (this.#timer) return;
		this.#timer = setInterval(() => this.#tick(), REPLAY_TICK_MS);
		this.#timer.unref();
	}

	/** Advance the cursor to the replay clock; the replay stops at the end of the history. */
	#tick(): void {
		const history = this.#trace()?.history ?? [];
		const before = this.preferences.peek();
		const now = this.#now();
		this.#ns += (now - this.#at) * 1_000_000 * before.speed;
		this.#at = now;
		let cursor = before.cursor ?? 0;
		while (cursor < history.length && history[cursor]!.t_ns <= this.#ns) cursor++;
		const ended = cursor === history.length;
		if (ended) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (cursor !== before.cursor || ended) this.preferences.set({ ...before, cursor, playing: !ended });
	}

	/** Stop the replay where it is. */
	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		const preferences = this.preferences.peek();
		if (preferences.playing) this.preferences.set({ ...preferences, playing: false });
	}

	/** The run's trace was replaced by a newer one: the cursor stays on the record it had applied. */
	adopt(old: ShellTrace | undefined, next: ShellTrace): void {
		const preferences = this.preferences.peek();
		if (preferences.cursor !== undefined) {
			const applied = old?.history?.[preferences.cursor - 1]?.seq;
			const records = next.history ?? [];
			const cursor =
				applied === undefined
					? Math.min(preferences.cursor, records.length)
					: records.filter(record => record.seq <= applied).length;
			if (cursor !== preferences.cursor) this.preferences.set({ ...preferences, cursor });
		}
		if (next.historyTruncated && this.preferences.peek().cursor === 0 && this.#positioned)
			this.#ns = Math.max(this.#ns, next.history?.[0]?.t_ns ?? 0);
	}
}
