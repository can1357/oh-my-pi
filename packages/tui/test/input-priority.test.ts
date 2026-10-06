import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type Component, type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { SPACE_HOLD_MECHANICAL_RUN, SPACE_HOLD_RELEASE_MS } from "@oh-my-pi/pi-tui/space-hold";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

class BlockingDoubleInterruptComponent implements Component {
	interruptsHandled = 0;
	exitRequests = 0;
	#firstInterruptAt = 0;
	#blockNextRenderMs = 0;
	secondInterruptSeen = false;
	slowRenderBeforeSecond = false;

	armSlowRender(blockMs: number): void {
		this.#blockNextRenderMs = blockMs;
	}

	handleInput(data: string): void {
		if (data !== "\x03") return;
		this.interruptsHandled++;
		if (this.interruptsHandled === 1) {
			this.#firstInterruptAt = Date.now();
			return;
		}
		this.secondInterruptSeen = true;
		const now = Date.now();
		if (!this.slowRenderBeforeSecond && this.#firstInterruptAt !== 0 && now - this.#firstInterruptAt < 500) {
			this.exitRequests++;
		}
		this.#firstInterruptAt = 0;
	}

	render(_width: number): readonly string[] {
		const blockMs = this.#blockNextRenderMs;
		this.#blockNextRenderMs = 0;
		if (blockMs > 0) {
			if (!this.secondInterruptSeen) this.slowRenderBeforeSecond = true;
			setSystemTime(new Date(Date.now() + blockMs));
		}
		return ["ready"];
	}
}

class NavigationProbe implements Component {
	#selected = 0;

	handleInput(data: string): void {
		if (data === "\x1b[B") this.#selected++;
	}

	render(_width: number): readonly string[] {
		return [`selected:${this.#selected}`];
	}
}

async function drainNextTick(): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
}

function fakeTimerScheduler(): RenderScheduler {
	return {
		now: () => Date.now(),
		scheduleImmediate: callback => {
			process.nextTick(callback);
		},
		scheduleRender: (callback, delayMs) => {
			if (delayMs <= 0) {
				let cancelled = false;
				process.nextTick(() => {
					if (!cancelled) callback();
				});
				return {
					cancel: () => {
						cancelled = true;
					},
				};
			}
			const handle = setTimeout(callback, delayMs);
			return {
				cancel: () => clearTimeout(handle),
			};
		},
	};
}

describe("TUI input priority", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("handles a queued second Ctrl+C before a slow repaint can consume the double-interrupt window", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const component = new BlockingDoubleInterruptComponent();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await drainNextTick();
		component.armSlowRender(650);
		vi.advanceTimersByTime(40);

		terminal.sendInput("\x03");
		setTimeout(() => terminal.sendInput("\x03"), 10);
		await drainNextTick();
		vi.advanceTimersByTime(0);
		vi.advanceTimersByTime(10);

		tui.stop();

		expect(component.slowRenderBeforeSecond).toBe(false);
		expect(component.interruptsHandled).toBe(2);
		expect(component.exitRequests).toBe(1);
	});

	it("renders ordinary navigation without an interrupt-grace delay", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const component = new NavigationProbe();
		tui.addChild(component);
		tui.setFocus(component);

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);

			terminal.sendInput("\x1b[B");
			await drainNextTick();
			await drainNextTick();

			expect(terminal.getViewport().map(row => row.trimEnd())).toContain("selected:1");
		} finally {
			tui.stop();
		}
	});

	it("routes an enabled main-editor Ctrl+O hold before the global tool-expansion listener", async () => {
		await initTheme();
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const editor = new CustomEditor(getEditorTheme());
		const events: string[] = [];
		let toolExpansionCount = 0;
		editor.spaceHold.keys = ["ctrl+o"];
		editor.spaceHold.handler = {
			enabled: () => true,
			onStart: () => events.push("start"),
			onEnd: () => events.push("end"),
		};
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.addInputListener(data => {
			if (data !== "\x0f") return undefined;
			toolExpansionCount++;
			return { consume: true };
		});

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);
			for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) {
				vi.advanceTimersByTime(30);
				terminal.sendInput("\x0f");
			}

			expect(events).toEqual(["start"]);
			expect(toolExpansionCount).toBe(0);
			vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
			expect(events).toEqual(["start", "end"]);
		} finally {
			tui.stop();
		}
	});

	it("preserves the global Ctrl+O action when PTT is disabled or another component is focused", async () => {
		await initTheme();
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const editor = new CustomEditor(getEditorTheme());
		const navigation = new NavigationProbe();
		let pttEnabled = false;
		let toolExpansionCount = 0;
		editor.spaceHold.keys = ["ctrl+o"];
		editor.spaceHold.handler = {
			enabled: () => pttEnabled,
			onStart: () => {},
			onEnd: () => {},
		};
		tui.addChild(editor);
		tui.addChild(navigation);
		tui.setFocus(editor);
		tui.addInputListener(data => {
			if (data !== "\x0f") return undefined;
			toolExpansionCount++;
			return { consume: true };
		});

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);
			terminal.sendInput("\x0f");
			expect(toolExpansionCount).toBe(1);

			pttEnabled = true;
			tui.setFocus(navigation);
			terminal.sendInput("\x0f");
			expect(toolExpansionCount).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("keeps printable PTT keys visible to raw input listeners while the hold still records", async () => {
		await initTheme();
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		const editor = new CustomEditor(getEditorTheme());
		const events: string[] = [];
		editor.spaceHold.handler = {
			enabled: () => true,
			onStart: () => events.push("start"),
			onEnd: () => events.push("end"),
		};
		tui.addChild(editor);
		tui.setFocus(editor);
		const observed: string[] = [];
		tui.addInputListener(data => {
			observed.push(data);
			return undefined;
		});

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);
			terminal.sendInput("a");
			vi.advanceTimersByTime(200);
			terminal.sendInput(" ");
			vi.advanceTimersByTime(200);
			terminal.sendInput("b");
			expect(observed).toEqual(["a", " ", "b"]);
			expect(editor.getText()).toBe("a b");

			for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) {
				vi.advanceTimersByTime(30);
				terminal.sendInput(" ");
			}
			expect(events).toEqual(["start"]);
			expect(editor.getText()).toBe("a b");
		} finally {
			tui.stop();
		}
	});

	it("routes BTW Ctrl+V into its active follow-up Input before the global paste listener", async () => {
		await initTheme();
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const record: BtwHistoryRecord = {
			id: "topic",
			leafId: null,
			question: "Question",
			answer: "Answer",
			status: "complete",
			createdAt: 1,
			updatedAt: 1,
		};
		let composer: Input | undefined;
		const events: string[] = [];
		const panel = new BtwHistoryPanel({
			records: [record],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			spaceHoldKeys: ["ctrl+v"],
			spaceHold: input => {
				composer = input;
				return {
					enabled: () => true,
					onStart: () => events.push("start"),
					onEnd: () => events.push("end"),
				};
			},
			requestRender: () => {},
			getHeight: () => 8,
		});
		expect(panel.openFollowUp(record.id)).toBe(true);
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { renderScheduler: fakeTimerScheduler() });
		let pasteCount = 0;
		tui.addChild(panel);
		tui.setFocus(panel);
		tui.addInputListener(data => {
			if (data !== "\x16") return undefined;
			pasteCount++;
			return { consume: true };
		});

		try {
			tui.start();
			await drainNextTick();
			vi.advanceTimersByTime(40);
			for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) {
				vi.advanceTimersByTime(30);
				terminal.sendInput("\x16");
			}

			expect(events).toEqual(["start"]);
			expect(composer?.getValue()).toBe("");
			expect(pasteCount).toBe(0);

			terminal.sendInput("\x1b");
			terminal.sendInput("\x16");
			expect(pasteCount).toBe(1);
		} finally {
			tui.stop();
		}
	});
});
