import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

/** A tab on a fake Tern daemon that answers every op, so only argument handling can fail a call. */
async function openTab(): Promise<{ tab: TernTab; fake: FakeDaemon }> {
	const fake = await startFakeDaemon(op => {
		if (op.op !== "eval") return { ok: {} };
		const args = Array.isArray(op.args) ? op.args : [];
		// The viewport centre a page scroll wheels over comes from the kit's `geometry` read.
		if (args[0] === "geometry") return { ok: { value: { value: { innerWidth: 800, innerHeight: 600 } } } };
		return { ok: {} };
	});
	daemon = fake;
	client = new TernSocketClient({ socketPath: fake.socketPath });
	const tab = new TernTab({
		client,
		block: 7,
		name: "main",
		viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
	});
	tab.setRunContext({
		timeoutMs: 5_000,
		deadline: Date.now() + 5_000,
		signal: new AbortController().signal,
		session: { cwd: os.tmpdir() },
		router: InternalUrlRouter.builtins(),
		output: new RunOutput(),
		screenshots: [],
	});
	return { tab, fake };
}

/** The wheel steps the tab sent to the daemon. */
function wheels(fake: FakeDaemon): Array<Record<string, unknown>> {
	return fake.requests.flatMap(request => {
		const events: unknown = request.op.events;
		if (!Array.isArray(events)) return [];
		return events.filter((event): event is Record<string, unknown> => isRecord(event) && event.type === "wheel");
	});
}

describe("tab.scroll() argument guard", () => {
	// Issue #19161: `{direction, amount}` carries no delta key, so it used to read as (0, 0) and
	// scroll nothing without telling the caller its call shape was wrong.
	it("rejects an object that names no delta, and names the call that does what it meant", async () => {
		const { tab, fake } = await openTab();

		const failure = await tab.scroll({ direction: "down", amount: 600 }).catch((error: unknown) => error);

		expect(String(failure)).toContain("tab.scroll() takes pixel deltas as numbers: (dx, dy) or ({x, y})");
		expect(String(failure)).toContain("tab.scroll(0, 600)");
		expect(wheels(fake)).toEqual([]);
	});

	it.each([
		["up", -600],
		["left", -600],
		["right", 600],
	])("names the %s call for the direction/amount shape", async (direction, signed) => {
		const { tab } = await openTab();

		const failure = await tab.scroll({ direction, amount: 600 }).catch((error: unknown) => error);

		const expected = direction === "up" ? `tab.scroll(0, ${signed})` : `tab.scroll(${signed}, 0)`;
		expect(String(failure)).toContain(expected);
	});

	it("keeps scrolling for the documented delta shapes", async () => {
		const { tab, fake } = await openTab();

		await tab.scroll(0, 600);
		await tab.scroll({ y: 300 });

		expect(wheels(fake).map(wheel => [wheel.dx, wheel.dy])).toEqual([
			[0, 600],
			[0, 300],
		]);
	});
});
