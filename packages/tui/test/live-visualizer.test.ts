import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LiveVisualizer } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders across the entire provided width in both voice and text modes", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			onSendText: async () => {},
		});

		for (const targetWidth of [2, 3, 4, 20, 80]) {
			const lines = visualizer.render(targetWidth);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}

		visualizer.handleInput("m");
		visualizer.pasteText("a message long enough to scroll");
		for (const targetWidth of [2, 3, 4, 20, 80]) {
			for (const line of visualizer.render(targetWidth)) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}
	});

	it("edits a message without triggering Live controls and Esc closes the field before ending Live", () => {
		let stops = 0;
		let muteToggles = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => stops++,
			onToggleMute: () => muteToggles++,
			onSendText: async () => {},
			stopKeys: ["ctrl+l"],
		});

		visualizer.handleInput("m");
		visualizer.handleInput("M");
		visualizer.handleInput(" ");
		visualizer.handleInput("m");
		expect(visualizer.render(80).join("\n")).toContain("M m");
		expect(muteToggles).toBe(0);
		visualizer.handleInput("\x0c");
		visualizer.handleInput("\x03");
		expect(stops).toBe(2);

		visualizer.handleInput("\x1b");
		expect(stops).toBe(2);
		visualizer.handleInput("\x1b");
		expect(stops).toBe(3);
	});

	it("sends typed text while muted without changing mute state", async () => {
		const sent: string[] = [];
		let muteToggles = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => muteToggles++,
			onSendText: async text => {
				sent.push(text);
			},
		});
		visualizer.setPhase("muted");

		visualizer.handleInput("\x1b[109u");
		visualizer.handleInput("\r");
		expect(sent).toEqual([]);
		visualizer.pasteText("hello from keyboard");
		visualizer.handleInput("\r");
		await Promise.resolve();

		expect(sent).toEqual(["hello from keyboard"]);
		expect(muteToggles).toBe(0);
		expect(visualizer.render(80).join("\n")).toContain("muted");
		expect(visualizer.render(80).join("\n")).not.toContain("hello from keyboard");
	});

	it("retains a failed draft across Esc and ignores duplicate submit while pending", async () => {
		const pending = Promise.withResolvers<void>();
		let sends = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			onSendText: () => {
				sends++;
				return pending.promise;
			},
		});

		visualizer.handleInput("m");
		visualizer.pasteText("keep this draft");
		visualizer.handleInput("\r");
		visualizer.handleInput("\r");
		expect(sends).toBe(1);

		visualizer.handleInput("\x1b");
		pending.reject(new Error("send failed"));
		await Promise.resolve();
		visualizer.handleInput("M");
		expect(visualizer.render(80).join("\n")).toContain("keep this draft");
	});

	it("applies native replacement edits before submitting a message", async () => {
		const sent: string[] = [];
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			onSendText: async text => {
				sent.push(text);
			},
		});

		visualizer.handleNativeEvent({ type: "action", key: "", act: "message", mods: [] });
		visualizer.handleNativeEvent({
			type: "edit",
			key: "2",
			from: 0,
			to: 0,
			text: "native message",
			cursor: 14,
			len: 0,
		});
		visualizer.handleNativeEvent({
			type: "edit",
			key: "2",
			from: 7,
			to: 14,
			text: "typed",
			cursor: 12,
			len: 14,
		});
		visualizer.handleNativeEvent({ type: "action", key: "", act: "send", mods: [] });
		await Promise.resolve();

		expect(sent).toEqual(["native typed"]);
	});

	it("leaves Esc as End when the host has no text input capability", () => {
		let stops = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => stops++,
			onToggleMute: () => {},
		});
		visualizer.handleInput("m");
		visualizer.handleInput("\x1b");
		expect(stops).toBe(1);
	});
});
