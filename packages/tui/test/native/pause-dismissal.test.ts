/**
 * `/pause` teardown on a native (TSP) surface: the PAUSED sheet is a
 * `nativeOverlay`, so it rides the inline surface's `layer` and its dismissal
 * is an ordinary frame — one the backend defers while the terminal owes
 * acknowledgements. The gate must stay closed until the terminal takes that
 * frame, or agents run against the repo behind a PAUSED screen.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { PauseScreenComponent, type PauseScreenHost, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

class Probe implements Component {
	current: NativeNode;
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["probe rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
}

let harness: TspHarness | undefined;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	harness?.stop();
	harness = undefined;
	agentPauseGate.resume();
});

/** The PAUSED sheet the terminal currently holds, if any. */
function pauseSheet(h: TspHarness): unknown {
	return h.find(node => node.k === "overlay" && node.p?.role === "omp.overlay.pause");
}

describe("native pause dismissal", () => {
	it("keeps the gate closed until the terminal takes the dismissal of a credit-blocked surface", async () => {
		const body = new Probe(text("one"));
		harness = await TspHarness.start(tui => tui.addChild(body), { credits: 1, autoAck: false });
		const h = harness;
		const host: PauseScreenHost = { ui: h.tui, showStatus: () => {} };
		h.terminal.ackAll();
		h.flush();

		const run = runPauseScreen(host);
		h.flush();
		h.terminal.ackAll();
		h.flush();
		expect(pauseSheet(h)).toBeDefined();
		const shown = h.tui.overlayStack.at(-1)?.component;
		if (!(shown instanceof PauseScreenComponent)) throw new Error("expected the pause screen");

		// Spend the surface's last credit, so the dismissal below has none.
		body.current = text("two");
		await h.render();
		expect(h.frames.at(-1)?.ops.length).toBeGreaterThan(0);

		shown.handleInput("\x1b");
		await Bun.sleep(1);
		h.flush();
		expect(pauseSheet(h)).toBeDefined(); // the terminal could not be sent the dismissal
		expect(agentPauseGate.paused).toBe(true); // ... so no agent may run yet

		h.terminal.ackAll();
		h.flush(); // a credit frees: the dismissal goes out and the terminal drops the sheet
		expect(pauseSheet(h)).toBeUndefined();
		expect(agentPauseGate.paused).toBe(true); // ... which it has not acknowledged yet

		h.terminal.ackAll();
		h.flush();
		await run;
		expect(agentPauseGate.paused).toBe(false);
		expect(h.errors).toEqual([]);
	});

	it("opens the gate on the stall span when the terminal acknowledges nothing", async () => {
		const body = new Probe(text("one"));
		harness = await TspHarness.start(tui => tui.addChild(body), { credits: 1, autoAck: false });
		const h = harness;
		const host: PauseScreenHost = { ui: h.tui, showStatus: () => {} };
		h.terminal.ackAll();
		h.flush();

		const run = runPauseScreen(host);
		h.flush();
		h.terminal.ackAll();
		h.flush();
		const shown = h.tui.overlayStack.at(-1)?.component;
		if (!(shown instanceof PauseScreenComponent)) throw new Error("expected the pause screen");
		body.current = text("two");
		await h.render(); // spends the last credit; nothing is acknowledged from here on

		shown.handleInput("\x1b");
		await Bun.sleep(1); // let the teardown reach its wait
		h.flush();
		expect(agentPauseGate.paused).toBe(true);

		// A terminal that answers nothing may delay the resume by the stall
		// span, never strand it: the backend sends without credits by then.
		h.stall(5_000);
		await run;
		expect(pauseSheet(h)).toBeUndefined();
		expect(agentPauseGate.paused).toBe(false);
	});

	it("opens the gate on the dismissal's own frame, not on paints queued after it", async () => {
		const body = new Probe(text("one"));
		harness = await TspHarness.start(tui => tui.addChild(body), { credits: 4, autoAck: false });
		const h = harness;
		const host: PauseScreenHost = { ui: h.tui, showStatus: () => {} };
		h.terminal.ackAll();
		h.flush();

		const run = runPauseScreen(host);
		h.flush();
		h.terminal.ackAll();
		h.flush();
		const shown = h.tui.overlayStack.at(-1)?.component;
		if (!(shown instanceof PauseScreenComponent)) throw new Error("expected the pause screen");

		shown.handleInput("\x1b");
		await Bun.sleep(1);
		h.flush();
		const dismissal = h.frames.at(-1);
		if (!dismissal) throw new Error("no dismissal frame");
		expect(pauseSheet(h)).toBeUndefined();

		// A paint of something else, left unacknowledged: the pause waits on its
		// own frame, not on whatever the session queues behind it.
		body.current = text("two");
		await h.render();
		expect(h.frames.at(-1)?.s).toBe(dismissal.s + 1);

		h.event({ ev: "ack", sf: dismissal.sf, s: dismissal.s });
		const settled = await Promise.race([run.then(() => "resumed"), Bun.sleep(20).then(() => "held")]);
		expect(settled).toBe("resumed");
		expect(agentPauseGate.paused).toBe(false);
	});
});
