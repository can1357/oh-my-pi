import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { pickTernBlock, type TernBlockEntry } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/blocks";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

/** The window's browser blocks as the `blocks` op lists them. */
const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

let daemon: FakeDaemon | undefined;
const opened: string[] = [];

afterEach(async () => {
	for (const name of opened.splice(0)) await releaseTab(name, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
});

/**
 * A Tern window with {@link BLOCKS}; a PiP `open` makes block 9. `state`
 * reports `shown`; `release` answers `release` (an older Tern: `invalid`).
 */
async function startWindow(opts: { shown: boolean; release?: FakeAnswer }): Promise<FakeDaemon> {
	let seq = 0;
	daemon = await startFakeDaemon((op): FakeAnswer => {
		switch (op.op) {
			case "blocks":
				return { ok: { blocks: BLOCKS } };
			case "open":
				return { ok: { block: 9, url: "about:blank" } };
			case "events": {
				// A PiP's initial about:blank load; an adopted block's old events are skipped by `next`.
				const events = op.after === 0 && op.block === 9 ? [{ seq: ++seq, type: "loaded", url: "about:blank" }] : [];
				return { ok: { events, next: seq + (op.block === 9 ? 0 : 40), dropped: 0 } };
			}
			case "state": {
				const block = BLOCKS.find(entry => entry.block === op.block);
				return {
					ok: {
						url: block?.url ?? "about:blank",
						title: block?.title ?? "",
						loading: false,
						shown: opts.shown,
						width: 800,
						height: 600,
					},
				};
			}
			case "eval":
				// The kit's `frames`: no child frames.
				return { ok: { value: { value: [] } } };
			case "release":
				return opts.release ?? { ok: {} };
			default:
				return { ok: {} };
		}
	});
	return daemon;
}

async function ternBrowser(fake: FakeDaemon) {
	return await acquireBrowser({ kind: "tern", socketPath: fake.socketPath, pane: PANE }, { cwd: "/tmp" });
}

function opsFor(fake: FakeDaemon, block: number): string[] {
	return fake.requests.filter(request => request.op.block === block).map(request => String(request.op.op));
}

function entry(block: number, fields: Partial<TernBlockEntry>): TernBlockEntry {
	return { block, url: "https://x.example/", title: "", owner: null, shown: undefined, driven: undefined, ...fields };
}

describe("pickTernBlock", () => {
	it("matches an id exactly, else a URL/title substring in any case", () => {
		const blocks = [entry(12, { url: "https://a.example/12" }), entry(4, { title: "GitHub Issues" })];
		expect(pickTernBlock(blocks, "4")?.block).toBe(4);
		expect(pickTernBlock(blocks, "github")?.block).toBe(4);
		expect(pickTernBlock(blocks, "A.EXAMPLE")?.block).toBe(12);
		expect(pickTernBlock(blocks, "missing")).toBeUndefined();
	});

	it("prefers a block on screen, then the user's own, then the first", () => {
		const hidden = entry(1, { shown: false, driven: false });
		const shownDriven = entry(2, { shown: true, driven: true });
		const shownOwn = entry(3, { shown: true, driven: false });
		expect(pickTernBlock([hidden, shownDriven, shownOwn], "x.example")?.block).toBe(3);
		expect(pickTernBlock([hidden, shownDriven], "x.example")?.block).toBe(2);
		// An older Tern says neither: the first match.
		expect(pickTernBlock([entry(8, {}), entry(9, {})], "x.example")?.block).toBe(8);
	});

	it("never matches a block another omp tab drives", () => {
		const blocks = [entry(1, { shown: true }), entry(2, { shown: false })];
		expect(pickTernBlock(blocks, "x.example", new Map([[1, "docs"]]))?.block).toBe(2);
		expect(pickTernBlock(blocks, "1", new Map([[1, "docs"]]))).toBeUndefined();
	});
});

describe("Tern block adoption", () => {
	it("drives the matching block without opening one, and releases it on close without closing it", async () => {
		const fake = await startWindow({ shown: true });
		const browser = await ternBrowser(fake);
		opened.push("adopt-release");
		const { tab } = await acquireTab("adopt-release", browser, { target: "docs", timeoutMs: 5_000 });
		expect(tab.targetId).toBe("7");
		expect(tab.info.url).toBe("https://docs.example/c");
		await releaseTab("adopt-release", { kill: false });
		const ops = fake.requests.map(request => String(request.op.op));
		expect(ops).not.toContain("open");
		expect(ops).not.toContain("close");
		// Only the options the caller gave: no dialog policy, no viewport.
		expect(opsFor(fake, 7)).not.toContain("dialogs");
		expect(opsFor(fake, 7)).not.toContain("viewport");
		expect(opsFor(fake, 7)).toContain("scripts");
		expect(opsFor(fake, 7).at(-1)).toBe("release");
	});

	it("clears its scripts instead on a Tern without release", async () => {
		const fake = await startWindow({
			shown: true,
			release: { error: { kind: "invalid", message: 'unknown web call "release"' } },
		});
		const browser = await ternBrowser(fake);
		opened.push("adopt-old");
		await acquireTab("adopt-old", browser, { target: "6", timeoutMs: 5_000 });
		await releaseTab("adopt-old", { kill: false });
		const last = fake.requests.filter(request => request.op.block === 6).at(-1)?.op;
		expect(last).toEqual({ op: "scripts", block: 6, scripts: [] });
		expect(opsFor(fake, 6)).not.toContain("close");
	});

	it("fails a target no block matches, listing the window's blocks, and touches none", async () => {
		const fake = await startWindow({ shown: true });
		const browser = await ternBrowser(fake);
		const failure = await acquireTab("adopt-none", browser, { target: "nowhere", timeoutMs: 5_000 }).catch(
			(error: unknown) => error,
		);
		expect(String(failure)).toContain('5 "Docs A" https://docs.example/a (docked, not on screen)');
		expect(String(failure)).toContain(
			'6 "Docs B" https://docs.example/b (picture-in-picture over block 3, on screen',
		);
		expect(fake.requests.map(request => String(request.op.op))).toEqual(["blocks"]);
	});
});

describe("Tern open result", () => {
	const saved = {
		socket: process.env.TERN_PANE_SOCKET,
		pane: process.env.TERN_PANE,
		flag: process.env.PI_BROWSER_TERN,
	};

	afterEach(() => {
		for (const [key, value] of [
			["TERN_PANE_SOCKET", saved.socket],
			["TERN_PANE", saved.pane],
			["PI_BROWSER_TERN", saved.flag],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	async function open(fake: FakeDaemon, name: string, app?: { target: string }): Promise<string> {
		process.env.TERN_PANE_SOCKET = fake.socketPath;
		process.env.TERN_PANE = String(PANE);
		delete process.env.PI_BROWSER_TERN;
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true, "browser.relay": false, "tools.maxTimeout": 0 }),
		};
		opened.push(name);
		const result = await createBrowserPrelude(session).invoke(
			{ action: "open", name, timeout: 5, ...(app ? { app } : {}) },
			{ session, toolCallId: "tern-open-result" },
		);
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	}

	it("tells the agent a PiP is not on screen and where it shows", async () => {
		const text = await open(await startWindow({ shown: false }), "hidden-pip");
		expect(text).toStartWith('Opened tab "hidden-pip" on Tern browser picture-in-picture (pane 3)');
		expect(text).toContain("Not on screen");
		expect(text).toContain("this omp pane (block 3)");
	});

	it("names the user's adopted block and that closing releases it", async () => {
		const text = await open(await startWindow({ shown: true }), "adopted", { target: "Docs C" });
		expect(text).toStartWith('Opened tab "adopted" on the user\'s Tern browser block 7 (docked)');
		expect(text).toContain("user's own Tern browser block 7");
		expect(text).toContain("releases it");
		expect(text).not.toContain("Not on screen");
	});
});
