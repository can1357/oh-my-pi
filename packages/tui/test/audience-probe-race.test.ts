/**
 * Audience probe races.
 *
 * `Terminal.hasAudience` is answered by an asynchronous `tmux` probe, and the
 * signals that prove someone is watching — a keystroke, the resize a tmux
 * attach sends — arrive between a probe's question and its answer. A probe
 * that asked before such a signal describes the pane the client had not
 * attached to yet.
 *
 * Contract this test defends: a `false` sampled before the audience question
 * was re-opened may never be published. If it is, the renderer re-applies the
 * one-second no-audience floor and the keystroke that re-opened the question
 * disappears for the rest of that second.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { Component } from "@oh-my-pi/pi-tui";
import * as tmux from "../src/tmux";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

/** Shortest gap the terminal keeps between two probes (AUDIENCE_PROBE_MIN_INTERVAL_MS). */
const PROBE_INTERVAL_MS = 2_000;

/** A focused component that appends every keystroke to the text it paints. */
class Echo implements Component {
	text = "before";
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
	handleInput(data: string): void {
		this.text += data;
	}
}

let harness: ProcessTerminalRenderHarness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
	vi.restoreAllMocks();
});

/**
 * Start a real ProcessTerminal + TUI whose tmux probe answers only when this
 * test resolves it, so the window between a probe's question and its answer is
 * the one thing under test.
 */
function setup() {
	const answers: Array<(attached: boolean | undefined) => void> = [];
	vi.spyOn(tmux, "canQueryTmuxAttachment").mockReturnValue(true);
	vi.spyOn(tmux, "tmuxSessionHasAttachedClients").mockImplementation(() => {
		const pending = Promise.withResolvers<boolean | undefined>();
		answers.push(pending.resolve);
		return pending.promise;
	});
	harness = createProcessTerminalRenderHarness(60, 8);
	const echo = new Echo();
	harness.tui.addChild(echo);
	harness.tui.setFocus(echo);
	return { answers, echo, h: harness };
}

/** Let `ms` of fake time pass, draining the promise continuations behind it. */
async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	for (let step = 0; step < 8; step++) await scheduler.yield();
}

describe("audience probe races", () => {
	it("never publishes a false sampled before a keystroke re-opened the audience question", async () => {
		const { answers, h } = setup();

		// The pane starts detached: the first probe establishes it. Reading
		// `hasAudience` is what arms the probe — the renderer does it every
		// frame. Answered before any time passes, so the probe's measured cost
		// is zero and the next gap is the floor rather than a duty-scaled one.
		void h.terminal.hasAudience;
		expect(answers).toHaveLength(1);
		answers[0]!(false);
		await advance(0);
		expect(h.terminal.hasAudience).toBe(false);

		// The poll comes round again and asks a second time.
		await advance(PROBE_INTERVAL_MS);
		h.tui.requestRender();
		await h.settle();
		expect(answers).toHaveLength(2);
		h.writes.length = 0;

		// A client attaches without changing the pane's shape and types, and the
		// probe that was already out answers with what it saw before the attach.
		process.stdin.emit("data", "X");
		answers[1]!(false);
		await h.settle();

		expect(h.terminal.hasAudience).not.toBe(false);
		expect(h.writes.join("")).toContain("beforeX");
	});

	it("keeps publishing a false that nothing re-opened, so a quiet detached pane still throttles", async () => {
		const { answers, h } = setup();

		void h.terminal.hasAudience;
		expect(answers).toHaveLength(1);
		answers[0]!(false);
		await advance(0);
		expect(h.terminal.hasAudience).toBe(false);

		await advance(PROBE_INTERVAL_MS);
		h.tui.requestRender();
		await h.settle();
		expect(answers).toHaveLength(2);

		answers[1]!(false);
		await advance(0);
		expect(h.terminal.hasAudience).toBe(false);
	});
});
