import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { Settings } from "../../../src/config/settings";
import {
	PauseScreenComponent,
	type PauseScreenHost,
	renderPauseScreen,
	runPauseScreen,
} from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	hiddenCount(): number;
}

function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	let hidden = 0;
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide: () => {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				};
			},
			setFocus() {},
			requestRender() {},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
	};
	return { host, shown, statuses, hiddenCount: () => hidden };
}

describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	describe("renderPauseScreen", () => {
		it("paints exactly the requested rows with title, explainer, clock, and hint", () => {
			const lines = renderPauseScreen(80, 24, 65_000);
			expect(lines.length).toBe(24);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("P A U S E D");
			expect(text).toContain("Main agent, subagents, and advisor");
			expect(text).toContain("paused for 1:05");
			expect(text).toContain("█".repeat(5));
		});

		it("drops to the compact card on small terminals", () => {
			const lines = renderPauseScreen(40, 10, 3_000);
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S E D");
			expect(text).toContain("paused for 0:03");
			expect(text).not.toContain("█".repeat(5)); // no room for the big glyph
		});

		it("rolls the clock into hours past 60 minutes", () => {
			const text = renderPauseScreen(80, 24, 3_725_000).map(stripAnsi).join("\n");
			expect(text).toContain("paused for 1:02:05");
		});

		it("displays the session name when provided in full mode", () => {
			const lines = renderPauseScreen(80, 24, 65_000, "My Awesome Session");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("My Awesome Session");
			expect(text).toContain("P A U S E D");
		});

		it("displays the session name when provided in compact mode", () => {
			const lines = renderPauseScreen(40, 10, 3_000, "Compact Session Title");
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("Compact Session Title");
			expect(text).toContain("▌▌ P A U S E D");
		});
	});

	describe("native sheet", () => {
		// Every described node, depth-first (components inside are not walked).
		const nodes = (root: NativeChild): NativeNode[] => {
			if (!("k" in root)) return [];
			return [root, ...(root.c ?? []).flatMap(nodes)];
		};
		const texts = (root: NativeNode): string =>
			nodes(root)
				.map(n => {
					const p = n.p as { text?: string; spans?: { t: string }[] } | undefined;
					return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
				})
				.join("\n");

		it("shows the live hold clock, the session it holds, what the hold means, and one Resume", () => {
			const { host } = makeHost();
			const sheet = new PauseScreenComponent({ ...host, sessionName: "Credit backpressure" });
			const root = sheet.describe();
			const all = nodes(root);

			const clock = all.find(n => n.k === "elapsed");
			expect(clock?.p).toMatchObject({ format: "clock" });
			const shown = texts(root);
			expect(shown).toContain("Credit backpressure");
			expect(shown).toContain("Every agent holds");
			expect(shown).toContain("The repo is yours");

			const buttons = all.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
			expect(buttons.length).toBe(1);
			const resume = buttons[0]!.p as { tone?: string; title?: string; actions?: { click?: string } };
			expect(resume.tone).toBe("accent");
			expect(resume.actions?.click).toBe("resume");
			// The keys live in the tooltip: `Label  key` clauses.
			expect(resume.title).toStartWith("Resume  esc");
			expect(sheet.nativeOverlay).toMatchObject({ role: "omp.overlay.pause", head: "Paused" });
		});

		it("names the whole session when it has no name", () => {
			const { host } = makeHost();
			expect(texts(new PauseScreenComponent(host).describe())).toContain("Every agent in this session");
		});

		it("resumes from the Resume button", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host); // shows the sheet synchronously, before its first await
			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleNativeEvent({ type: "action", key: "actions/resume", act: "resume", mods: [] });
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});
	});
});
