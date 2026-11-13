import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import {
	ClickRefusedError,
	clickElement,
	clickQueryHandlerText,
	ElementDetachedError,
	fillViaHandle,
	resolveActionableQueryHandlerClickTarget,
	setElementChecked,
	TypingInterruptedError,
	withLiveElement,
} from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";
import type { ElementHandle } from "puppeteer-core";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const TAB_NAME = `interactions-${crypto.randomUUID()}`;
const STARVED_TAB_NAME = `starved-${crypto.randomUUID()}`;
const SELECT_TAB_NAME = `select-${crypto.randomUUID()}`;
const COMBO_TAB_NAME = `combos-${crypto.randomUUID()}`;
// The platform's editing modifier; on macOS its shortcuts only edit when the key-down names the command.
const SHORTCUT = process.platform === "darwin" ? "Meta" : "Control";
const comboHtml = `<!doctype html><textarea id="area">hello world</textarea><input id="field"><input id="paste">
<iframe id="inner" srcdoc='<!doctype html><textarea id="deep">nested text</textarea>'></iframe>`;
const TEXT_TAB_NAME = `text-click-${crypto.randomUUID()}`;
let tempDir = "";
let uploadPath = "";

const html = `<!doctype html>
<style>
body { margin: 0; font: 16px sans-serif; }
#covered { position: absolute; left: 20px; top: 20px; width: 140px; height: 48px; }
#overlay { position: fixed; left: 20px; top: 20px; width: 140px; height: 48px; z-index: 10; }
#point { position: absolute; left: 300px; top: 20px; width: 100px; height: 50px; }
#drop, #highlight { margin-top: 100px; width: 180px; height: 50px; border: 1px solid black; }
</style>
<button id="covered">Covered target</button><div id="overlay"></div>
<label><input id="check" type="checkbox"> Toggle</label>
<button id="double">Double</button><input id="keys">
<button id="point">Point</button><div id="drop">Drop zone</div><div id="highlight">Highlight</div>
<script>
window.results = { covered: 0, doubles: 0, keys: [], point: 0, dropped: "" };
document.querySelector("#covered").addEventListener("click", () => results.covered++);
document.querySelector("#double").addEventListener("dblclick", () => results.doubles++);
document.querySelector("#keys").addEventListener("keydown", event => results.keys.push(event.key + ":" + event.shiftKey));
document.querySelector("#point").addEventListener("click", () => results.point++);
document.querySelector("#drop").addEventListener("dragover", event => event.preventDefault());
document.querySelector("#drop").addEventListener("drop", event => {
  event.preventDefault();
  results.dropped = event.dataTransfer.files[0]?.name || "";
});
</script>`;

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object") throw new Error("Browser result did not include details");
	return ("value" in details ? details.value : undefined) as T;
}

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
			"browser.webkit": false,
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-interactions-"));
	uploadPath = path.join(tempDir, "drop-fixture.txt");
	await Bun.write(uploadPath, "drop contents");
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser click timeouts", () => {
	test("rejects promptly when a text-click candidate evaluation is aborted", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent('<button id="abort-candidate">Abort candidate</button>');
			const [candidate] = await page.$$("text/Abort candidate");
			if (!candidate) throw new Error("Expected a text-query candidate");
			await candidate.evaluate(element => {
				Object.defineProperty(element, "closest", {
					configurable: true,
					value: () => {
						// Puppeteer's page callback type cannot name DOM globals in this test environment.
						const target = element as unknown as { dataset: { closestEntered?: string } };
						target.dataset.closestEntered = "1";
						return Promise.withResolvers<never>().promise;
					},
				});
			});

			const controller = new AbortController();
			const reason = new Error("candidate lookup aborted");
			const settled = clickQueryHandlerText(
				page,
				"text/Abort candidate",
				'tab.click("text/Abort candidate")',
				5_000,
				controller.signal,
			).then(
				() => ({ status: "resolved" as const }),
				error => ({ status: "rejected" as const, error }),
			);
			await page.waitForFunction(
				() => {
					const page = globalThis as unknown as {
						document: { querySelector(selector: string): { dataset: { closestEntered?: string } } | null };
					};
					return page.document.querySelector("#abort-candidate")?.dataset.closestEntered === "1";
				},
				{ timeout: 1_000 },
			);

			controller.abort(reason);
			// The abort, not the lookup's 5 s deadline, ends it: only the abort carries `reason` as its cause.
			const outcome = await settled;
			if (outcome.status !== "rejected") throw new Error("Text-click candidate lookup resolved after abort");
			if (!(outcome.error instanceof Error)) throw new Error("Expected candidate lookup to reject with an Error");
			expect(outcome.error.name).toBe("AbortError");
			expect(outcome.error.cause).toBe(reason);
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser fill aborts", () => {
	test("reports a rich-text replacement that was already sent when the fill is aborted", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent('<div id="editor" contenteditable>old text</div>');
			const editor = await page.$("#editor");
			if (!editor) throw new Error("Expected the editor");
			const controller = new AbortController();
			const reason = new Error("per-op deadline");
			const send = page.keyboard.sendCharacter.bind(page.keyboard);
			// The insertion reaches the page, then the deadline fires while its reply is still outstanding.
			page.keyboard.sendCharacter = async text => {
				await send(text);
				controller.abort(reason);
				return Promise.withResolvers<void>().promise;
			};

			const error = await rejectionOf(fillViaHandle(editor, "new text", controller.signal));
			if (!(error instanceof TypingInterruptedError))
				throw new Error(`Expected TypingInterruptedError, got ${error}`);
			expect(error.progress).toContain("replacement text was already sent");
			expect(error.cause).toBe(reason);
			expect(await editor.evaluate(el => el.textContent)).toBe("new text");
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser input cut off mid-gesture", () => {
	// `blockNow(ms)` blocks the page's main thread in its own script right after the current call answers; with
	// `blockMs` set, the next mousedown or keydown handler blocks instead. Either way omp's input waits on the page
	// for 9 s, past the 8 s per-op ceiling of a 10 s cell, and the cell's cleanup returns once the page answers.
	const gestureHtml = `<!doctype html>
<button id="target" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
<div id="from" style="position:absolute;left:20px;top:100px;width:60px;height:60px"></div>
<div id="to" style="position:absolute;left:200px;top:100px;width:60px;height:60px"></div>
<script>
window.log = [];
window.blockMs = 0;
const block = () => { const until = Date.now() + blockMs; blockMs = 0; while (Date.now() < until) {} };
window.blockNow = ms => { const channel = new MessageChannel(); channel.port1.onmessage = () => { blockMs = ms; block(); }; channel.port2.postMessage(0); };
addEventListener("mousedown", () => { log.push("down"); block(); }, true);
addEventListener("mouseup", () => { log.push("up"); if (window.blockUpMs) { blockMs = window.blockUpMs; window.blockUpMs = 0; block(); } }, true);
addEventListener("click", event => log.push(event.target === document.querySelector("#target") ? "click" : "click:" + event.target.nodeName), true);
addEventListener("keydown", event => { log.push("keydown:" + event.key); block(); }, true);
addEventListener("keyup", event => log.push("keyup:" + event.key), true);
</script>`;
	// Input a cut-off call would still have sent arrives within a few round trips of the page answering; the
	// page's log is read after that, as the user's next look at the page would be.
	const readLog = "await wait(500); return await tab.evaluate(() => window.log);";

	async function withGestureTab(
		toolCallId: string,
		body: (run: (code: string, timeout?: number) => Promise<unknown>) => Promise<void>,
	): Promise<void> {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId };
		const tabName = `${toolCallId}-${crypto.randomUUID()}`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(gestureHtml)}` },
			context,
		);
		try {
			await body(async (code, timeout = 10) =>
				valueFrom<unknown>(await prelude.invoke({ action: "run", name: tabName, code, timeout }, context)),
			);
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}
	const attempt = (call: string) =>
		`try { await ${call}; return "done"; } catch (error) { return error instanceof Error ? error.message : String(error); }`;

	test("a click that timed out on a page busy in its own script does not click its target once the page answers", async () => {
		await withGestureTab("late-click", async run => {
			const outcome = await run(`await tab.evaluate(() => blockNow(9000)); ${attempt("tab.clickAt(80, 40)")}`);
			expect(outcome).toMatch(/^tab\.clickAt\(\) timed out after \d+ms/);
			// The press was already on its way; it is released off the target, so the button never sees a click.
			expect(await run(readLog)).toEqual(["down", "up"]);
		});
	}, 40_000);

	test("an already-dispatched release can click after timeout, but no later click in the sequence is sent", async () => {
		await withGestureTab("cut-release", async run => {
			await run("await tab.evaluate(() => { window.blockUpMs = 9000; });");
			expect(await run(attempt("tab.clickAt(80, 40, { clickCount: 2 })"))).toMatch(
				/^tab\.clickAt\(\) timed out after \d+ms/,
			);
			// Chrome already owns the first release; cancellation cannot recall it, but prevents the second press.
			expect(await run(readLog)).toEqual(["down", "up", "click"]);
			expect(await run(attempt("tab.clickAt(80, 40)"))).toBe("done");
		});
	}, 40_000);

	test("a drag cut off with the button down releases it off the page, so the next click works", async () => {
		await withGestureTab("cut-drag", async run => {
			await run("await tab.evaluate(() => { window.blockMs = 9000; });");
			expect(await run(attempt(`tab.drag("#from", "#to")`))).toMatch(/^tab\.drag\(\) timed out after \d+ms/);
			expect(await run(readLog)).toEqual(["down", "up"]);
			expect(await run(attempt(`tab.click("#target")`))).toBe("done");
		});
	}, 40_000);

	test.each([
		["tab.press", `tab.press("Shift+a")`, "Shift"],
		["an element handle's press", `(await tab.waitFor("#target")).press("Shift+a")`, "Shift"],
		["tab.clipboardCopy", "tab.clipboardCopy()", SHORTCUT],
	])(
		"a key combo through %s cut off with its modifier down sends no further key and releases the modifier",
		async (_label, call, modifier) => {
			await withGestureTab("cut-press", async run => {
				await run("await tab.evaluate(() => { window.blockMs = 9000; });");
				expect(await run(attempt(call))).toMatch(/ timed out after \d+ms/);
				expect(await run(readLog)).toEqual([`keydown:${modifier}`, `keyup:${modifier}`]);
			});
		},
		40_000,
	);

	test("a tab.mouseDown whose own deadline passed, caught by the code, still releases the button", async () => {
		await withGestureTab("caught-down", async run => {
			await run("await tab.evaluate(() => { window.blockMs = 9000; });");
			expect(await run(`await tab.mouseMove(80, 40); ${attempt("tab.mouseDown()")}`)).toMatch(
				/^tab\.mouseDown\(\) timed out after \d+ms/,
			);
			expect(await run(readLog)).toEqual(["down", "up"]);
			expect(await run(attempt("tab.mouseDown()"))).toBe("done");
		});
	}, 40_000);

	test("a drag refused because the button is already held leaves that hold alone", async () => {
		await withGestureTab("held-drag", async run => {
			await run("await tab.mouseMove(80, 40); await tab.mouseDown();");
			expect(await run(attempt(`tab.drag("#from", "#to")`))).toContain("'left' is already pressed");
			expect(await run(readLog)).toEqual(["down"]);
			expect(await run(attempt("tab.mouseUp()"))).toBe("done");
		});
	}, 40_000);

	test("a click count below one is refused before anything is sent", async () => {
		await withGestureTab("zero-clicks", async run => {
			expect(await run(attempt("tab.clickAt(80, 40, { clickCount: 0 })"))).toContain("positive number of times");
			expect(await run(readLog)).toEqual([]);
		});
	}, 40_000);

	test("a run that times out holding tab.mouseDown releases the button off its target", async () => {
		await withGestureTab("held-timeout", async run => {
			const timedOut = await run(
				"await tab.mouseMove(80, 40); await tab.mouseDown(); await new Promise(() => {});",
				2,
			).then(
				() => "finished",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(timedOut).toContain("Browser code execution timed out");
			expect(await run(readLog)).toEqual(["down", "up"]);
		});
	}, 40_000);
});
describe.skipIf(!CHROMIUM_AVAILABLE)("browser interaction parity", () => {
	test("clicks a link that wraps across two lines on the link, not on its paragraph, on puppeteer and Tern", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-wrapped-link" };
		const tabName = `wrapped-${crypto.randomUUID()}`;
		const wrappedHtml = `<!doctype html><p id="para" style="width:33ch;font:16px/20px monospace;margin:0">aaaaaaaaaaaaaaaaaaaaaaa <a id="link" href="#">wrapped link</a> bbbbbbbbbbbbbbbbbbbbbbbbbbbb</p>
<script>window.clicked = []; document.addEventListener("click", event => { clicked.push(event.target.id); event.preventDefault(); });</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(wrappedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					// The Tern page kit is plain page script, so its aim point is checked on this page.
					code: `const fragments = await tab.evaluate(() => document.querySelector("#link").getClientRects().length);
await tab.click("#link");
await tab.evaluate(${JSON.stringify(`(function () {\n${TERN_KIT_SOURCE}\n})()`)});
const ternHit = await tab.evaluate(async () => {
	const target = await globalThis.__ompTernKit.target({ engine: "css", query: "#link" }, "click");
	return target.ok ? document.elementFromPoint(target.x, target.y)?.id : target.reason;
});
return { fragments, clicked: await tab.evaluate(() => window.clicked), ternHit };`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<{ fragments: number; clicked: string[]; ternHit: string }>(result)).toEqual({
				fragments: 2,
				clicked: ["link"],
				ternHit: "link",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
	test("clicks a shadow button through its own slotted content, still refusing a real overlay, on puppeteer and Tern", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-slotted-button" };
		const tabName = `slotted-${crypto.randomUUID()}`;
		// The slotted icon fills the button's centre, so the hit test lands on light-DOM content the button renders.
		const slottedHtml = `<!doctype html><slot-button id="open"><span style="display:inline-flex;width:40px;height:40px">x</span></slot-button>
<slot-button id="covered"><span style="display:inline-flex;width:40px;height:40px">x</span></slot-button>
<div id="overlay" style="position:absolute;left:0;top:70px;width:300px;height:100px"></div>
<script>
customElements.define("slot-button", class extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" }).innerHTML = '<style>:host{display:block;height:70px}button{width:120px;height:64px}</style><button id="' + this.id + '-inner"><slot></slot></button>';
	}
});
window.clicked = [];
document.addEventListener("click", event => clicked.push(event.composedPath().find(node => node.localName === "button")?.id));
</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(slottedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const open = await tab.click("pierce/#open-inner").then(() => "clicked", error => error.message);
const covered = await tab.click("pierce/#covered-inner").then(() => "clicked", error => error.message);
await tab.evaluate(${JSON.stringify(`(function () {\n${TERN_KIT_SOURCE}\n})()`)});
const tern = await tab.evaluate(async () => {
	const aim = async query => {
		const target = await globalThis.__ompTernKit.target({ engine: "pierce", query }, "click");
		return target.ok ? "ok" : target.detail;
	};
	return { open: await aim("#open-inner"), covered: await aim("#covered-inner") };
});
return { open, covered, clicked: await tab.evaluate(() => window.clicked), tern };`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<unknown>(result)).toEqual({
				open: "clicked",
				covered: 'tab.click("pierce/#covered-inner") blocked: covered by <div#overlay>',
				clicked: ["open-inner"],
				tern: { open: "ok", covered: "<div#overlay>" },
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
	test("refuses to fill or type into a disabled or read-only field", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `locked-${crypto.randomUUID()}`;
		const lockedHtml = `<!doctype html><input id="locked" disabled value="kept"><input id="fixed" readonly value="kept">
<input id="locksOnFocus" value="kept" onfocus="this.readOnly = true"><input id="disablesOnFocus" onfocus="this.disabled = true">
<input id="other">`;
		const context = { session, toolCallId: "browser-locked" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(lockedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const attempt = async action => {
	try {
		await action();
		return "ok";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};
await tab.focus("#other");
return {
	fillDisabled: await attempt(() => tab.fill("#locked", "typed")),
	fillReadOnly: await attempt(() => tab.fill("#fixed", "typed")),
	typeDisabled: await attempt(() => tab.type("#locked", "typed")),
	fillLockedOnFocus: await attempt(() => tab.fill("#locksOnFocus", "typed")),
	typeDisabledOnFocus: await attempt(() => tab.type("#disablesOnFocus", "typed")),
	locked: await tab.value("#locked"),
	fixed: await tab.value("#fixed"),
	lockedOnFocus: await tab.value("#locksOnFocus"),
	other: await tab.value("#other"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<Record<string, string>>(result)).toEqual({
				fillDisabled: "Cannot fill a disabled element",
				fillReadOnly: "Cannot fill a read-only element",
				typeDisabled: "Cannot type into a disabled element",
				fillLockedOnFocus: "Cannot fill a read-only element",
				typeDisabledOnFocus: "Cannot type into a disabled element",
				locked: "kept",
				fixed: "kept",
				lockedOnFocus: "kept",
				other: "",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("guards covered clicks and drives keyboard, pointer, drop-zone, checked-state, and highlight interactions", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-interactions" });
		const call = async (method: string, args: unknown[] = []): Promise<unknown> => {
			const result = await invoke({ action: "call", name: TAB_NAME, chain: [{ method, args }] });
			return valueFrom<unknown>(result);
		};

		await invoke({
			action: "open",
			name: TAB_NAME,
			url: `data:text/html,${encodeURIComponent(html)}`,
		});
		try {
			const blocked = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `try {
	await tab.click("#covered");
	return "clicked";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
				timeout: 10,
			});
			expect(valueFrom<string>(blocked)).toBe('tab.click("#covered") blocked: covered by <div#overlay>');
			await call("evaluate", ["document.querySelector('#overlay').remove()"]);
			await call("click", ["#covered"]);

			await call("check", ["#check"]);
			await call("check", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(true);
			await call("uncheck", ["#check"]);
			await call("uncheck", ["#check"]);
			expect(await call("evaluate", ["document.querySelector('#check').checked"])).toBe(false);

			await call("dblclick", ["#double"]);
			await call("focus", ["#keys"]);
			await call("keyDown", ["Shift"]);
			await call("press", ["a"]);
			await call("keyUp", ["Shift"]);
			await call("clickAt", [350, 45]);
			await call("uploadFile", ["#drop", uploadPath]);

			const highlight = await invoke({
				action: "run",
				name: TAB_NAME,
				code: `const pending = tab.highlight("#highlight", { duration: 1000 });
// The overlay is injected asynchronously and removed once the helper's
// host-side hold elapses, so wait for the node instead of sampling the count.
await tab.waitForSelector("[data-omp-highlight-overlay]", { timeout: 5000 });
const during = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
await pending;
const after = await tab.evaluate(() => document.querySelectorAll("[data-omp-highlight-overlay]").length);
return { during, after };`,
			});
			expect(valueFrom<{ during: number; after: number }>(highlight)).toEqual({ during: 1, after: 0 });

			const results = await call("evaluate", ["window.results"]);
			expect(results).toMatchObject({
				covered: 1,
				doubles: 1,
				keys: ["Shift:true", "a:true"],
				point: 1,
				dropped: "drop-fixture.txt",
			});
		} finally {
			await invoke({ action: "close", name: TAB_NAME, kill: true }).catch(() => undefined);
		}
	}, 30_000);

	test("selects options by value, then by visible label, from tabs and element handles", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-select" };
		const selectHtml = `<!doctype html>
<select id="country"><option value="">Choose…</option><option value="us">United States</option><option value="ca">Canada</option></select>
<select id="size"><option value="m">Large</option><option value="Large">Extra large</option></select>
<select id="extras" multiple><option value="cheese">Cheese</option><option value="ham">Ham</option><option value="olives">Olives</option></select>
<select id="jump"><option value="">Jump to…</option><option value="docs">Docs</option></select>
<select id="swap"></select>
<script>
// A jump menu acts on the choice and resets itself, as "add filter" and "go to" menus do.
document.querySelector("#jump").addEventListener("change", event => { event.target.value = ""; });
// A cascading menu replaces its own options on a change.
window.resetSwap = () => { document.querySelector("#swap").innerHTML = '<option value="a">A</option><option value="b">B</option>'; };
resetSwap();
document.querySelector("#swap").addEventListener("change", event => { event.target.innerHTML = '<option value="z" selected>Z</option>'; });
</script>`;
		await prelude.invoke(
			{ action: "open", name: SELECT_TAB_NAME, url: `data:text/html,${encodeURIComponent(selectHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: SELECT_TAB_NAME,
					code: `const byLabel = await tab.select("#country", "United States");
const afterLabel = await tab.value("#country");
const byValue = await tab.select("#country", "ca");
const handle = await tab.waitFor("#country");
const handleByLabel = await handle.select("United States");
const afterHandle = await tab.value("#country");
const valueWins = await tab.select("#size", "Large");
const cleared = await tab.select("#size");
const afterCleared = await tab.value("#size");
const firstOnSingle = await tab.select("#country", "Canada", "us");
const handleFirstOnSingle = await handle.select("us", "ca");
const afterFirst = await tab.value("#country");
const noMatch = await tab.select("#country", "Mexico").catch(error => error.message);
const handleNoMatch = await handle.select("ca", "Mexico").catch(error => error.message);
const afterNoMatch = await tab.value("#country");
const multiple = await tab.select("#extras", "Cheese", "olives");
const reset = await tab.select("#jump", "Docs");
const handleReset = await (await tab.waitFor("#jump")).select("docs");
const afterReset = await tab.value("#jump");
await tab.evaluate(() => resetSwap());
const swapped = await tab.select("#swap", "b");
await tab.evaluate(() => resetSwap());
await tab.evaluate(${JSON.stringify(`(function () {\n${TERN_KIT_SOURCE}\n})()`)});
const ternSwapped = await tab.evaluate(() => globalThis.__ompTernKit.select({ engine: "css", query: "#swap" }, ["b"]));
return { byLabel, afterLabel, byValue, handleByLabel, afterHandle, valueWins, cleared, afterCleared, firstOnSingle, handleFirstOnSingle, afterFirst, noMatch, handleNoMatch, afterNoMatch, multiple, reset, handleReset, afterReset, swapped, ternSwapped };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<Record<string, unknown>>(result)).toEqual({
				byLabel: ["us"],
				afterLabel: "us",
				byValue: ["ca"],
				handleByLabel: ["us"],
				afterHandle: "us",
				valueWins: ["Large"],
				// A drop-down select with nothing selected selects its first option again.
				cleared: ["m"],
				afterCleared: "m",
				firstOnSingle: ["ca"],
				handleFirstOnSingle: ["us"],
				afterFirst: "us",
				noMatch: expect.stringContaining('No <select> option matches "Mexico"'),
				handleNoMatch: expect.stringContaining('No <select> option matches "Mexico"'),
				afterNoMatch: "us",
				multiple: ["cheese", "olives"],
				reset: [""],
				handleReset: [""],
				afterReset: "",
				swapped: ["z"],
				ternSwapped: ["z"],
			});

			// cmux tabs run the same rules in their injected page script; replay it in this page.
			const cmux = new CmuxTab({
				client: {
					request: async (method: string, params: { script?: string }) => {
						expect(method).toBe("browser.eval");
						const evaluated = await prelude.invoke(
							{ action: "call", name: SELECT_TAB_NAME, chain: [{ method: "evaluate", args: [params.script] }] },
							context,
						);
						return { value: valueFrom<unknown>(evaluated) };
					},
				} as never,
				surfaceId: "select",
			});
			await prelude.invoke(
				{ action: "call", name: SELECT_TAB_NAME, chain: [{ method: "evaluate", args: ["resetSwap()"] }] },
				context,
			);
			expect({
				byLabel: await cmux.select("#country", "United States"),
				firstOnSingle: await cmux.select("#country", "Canada", "us"),
				multiple: await cmux.select("#extras", "Ham", "olives"),
				swapped: await cmux.select("#swap", "b"),
			}).toEqual({ byLabel: ["us"], firstOnSingle: ["ca"], multiple: ["ham", "olives"], swapped: ["z"] });
			const noMatch = await cmux.select("#country", "Mexico").catch((error: Error) => error.message);
			expect(noMatch).toContain('No <select> option matches "Mexico"');
			expect(await cmux.value("#country")).toBe("ca");
		} finally {
			await prelude.invoke({ action: "close", name: SELECT_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("presses key combos on the tab, an element and a frame", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-combos" };
		await prelude.invoke(
			{ action: "open", name: COMBO_TAB_NAME, url: `data:text/html,${encodeURIComponent(comboHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: COMBO_TAB_NAME,
					code: `await tab.press("${SHORTCUT}+a", { selector: "#area" });
const page = await tab.evaluate(() => { const t = document.querySelector("#area"); return [t.selectionStart, t.selectionEnd]; });
await tab.evaluate(() => document.querySelector("#area").setSelectionRange(0, 0));
await tab.press("${SHORTCUT}Left+KeyA", { selector: "#area" });
const spelled = await tab.evaluate(() => { const t = document.querySelector("#area"); return [t.selectionStart, t.selectionEnd]; });
const field = await tab.waitFor("#field");
await field.type("abc");
await field.press("Shift+ArrowLeft");
const shifted = await tab.evaluate(() => { const t = document.querySelector("#field"); return [t.selectionStart, t.selectionEnd]; });
await field.press("${SHORTCUT}+a");
await field.type("x");
await (await tab.waitFor("#paste")).press("a", { text: "é" });
const inner = await tab.frame("#inner");
await inner.press("${SHORTCUT}+a", { selector: "#deep" });
const frame = await inner.evaluate(() => { const t = document.querySelector("#deep"); return [t.selectionStart, t.selectionEnd]; });
return { page, spelled, shifted, replaced: await tab.value("#field"), frame, optioned: await tab.value("#paste") };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<unknown>(result)).toEqual({
				page: [0, 11],
				spelled: [0, 11],
				shifted: [2, 3],
				replaced: "x",
				frame: [0, 11],
				optioned: "é",
			});
		} finally {
			await prelude.invoke({ action: "close", name: COMBO_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	// CI runs Linux, where Control+C/V already edit; this is the macOS contract.
	test.skipIf(process.platform !== "darwin")(
		"copies and pastes the selection with the clipboard helpers on macOS",
		async () => {
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "browser-clipboard-keys" };
			await prelude.invoke(
				{ action: "open", name: COMBO_TAB_NAME, url: `data:text/html,${encodeURIComponent(comboHtml)}` },
				context,
			);
			try {
				const result = await prelude.invoke(
					{
						action: "run",
						name: COMBO_TAB_NAME,
						code: `await tab.evaluate(() => { const t = document.querySelector("#area"); t.focus(); t.select(); });
await tab.clipboardCopy();
await tab.focus("#paste");
await tab.clipboardPaste();
return await tab.value("#paste");`,
						timeout: 20,
					},
					context,
				);
				expect(valueFrom<string>(result)).toBe("hello world");
			} finally {
				await prelude.invoke({ action: "close", name: COMBO_TAB_NAME, kill: true }, context).catch(() => undefined);
			}
		},
		30_000,
	);

	test("clearing a field with an empty fill reports the change to the page", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `cleared-${crypto.randomUUID()}`;
		// The input listener mirrors a framework value tracker (React's): it records
		// programmatic assignments and reports only input whose value differs from them.
		const clearedHtml = `<!doctype html><input id="q" value="stale">
<script>
window.reported = [];
const field = document.querySelector("#q");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let tracked = field.value;
Object.defineProperty(field, "value", {
  configurable: true,
  get() { return native.get.call(this); },
  set(next) { tracked = String(next); native.set.call(this, next); },
});
field.addEventListener("input", () => {
  if (field.value === tracked) return;
  tracked = field.value;
  reported.push("input:" + field.value);
});
field.addEventListener("change", () => reported.push("change:" + field.value));
</script>`;
		const context = { session, toolCallId: "browser-cleared" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(clearedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#q", "");
// A field that is already empty has nothing to report.
await tab.fill("#q", "");
return { value: await tab.value("#q"), reported: await tab.evaluate(() => window.reported) };`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ value: string; reported: string[] }>(result)).toEqual({
				value: "",
				reported: ["input:", "change:"],
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills and clears a rich-text editor that keeps its own model", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `rich-editor-${crypto.randomUUID()}`;
		// Like Slate and Lexical, the editor applies input to its own model through beforeinput, renders
		// from that model, and undoes any DOM write it did not make itself.
		const editorHtml = `<!doctype html><div id="editor" contenteditable></div>
<script>
const editor = document.querySelector("#editor");
window.model = "old query";
const observer = new MutationObserver(() => render());
function render(caret) {
  observer.disconnect();
  editor.textContent = model;
  if (caret !== undefined && editor.firstChild) getSelection().collapse(editor.firstChild, caret);
  observer.observe(editor, { childList: true, characterData: true, subtree: true });
}
const offset = (node, at) => (node === editor ? (at === 0 ? 0 : model.length) : at);
editor.addEventListener("beforeinput", event => {
  event.preventDefault();
  const [range] = event.getTargetRanges();
  const start = offset(range.startContainer, range.startOffset);
  const end = offset(range.endContainer, range.endOffset);
  const inserted = event.inputType === "insertText" ? event.data : "";
  model = model.slice(0, start) + inserted + model.slice(end);
  render(start + inserted.length);
});
render();
</script>`;
		const context = { session, toolCallId: "browser-rich-editor" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(editorHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#editor", "new query");
const filled = await tab.evaluate(() => window.model);
await tab.fill("#editor", "");
return { filled, cleared: await tab.evaluate(() => window.model) };`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ filled: string; cleared: string }>(result)).toEqual({ filled: "new query", cleared: "" });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills an editor that applies input at the selection it read once after focus", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editor-synced-${crypto.randomUUID()}`;
		// Like Slate while its render lags behind, the editor reads the page's selection once after focus and
		// applies the next input there, whatever the page's selection has become since.
		const syncedHtml = `<!doctype html><div id="editor" contenteditable>old query</div>
<script>
const editor = document.querySelector("#editor");
window.model = "old query";
let synced = [0, 0];
let reading = false;
editor.addEventListener("focus", () => { reading = true; });
const offset = (node, at) => (node === editor ? (at === 0 ? 0 : model.length) : at);
document.addEventListener("selectionchange", () => {
  if (!reading) return;
  reading = false;
  const range = getSelection().getRangeAt(0);
  synced = [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
});
editor.addEventListener("beforeinput", event => {
  event.preventDefault();
  const inserted = event.inputType === "insertText" ? event.data : "";
  model = model.slice(0, synced[0]) + inserted + model.slice(synced[1]);
  editor.textContent = model;
});
</script>`;
		const context = { session, toolCallId: "browser-editor-synced" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(syncedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#editor", "new query");
return await tab.evaluate(() => window.model);`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<string>(result)).toBe("new query");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("an empty fill deletes every content of an editing host and nothing outside an element inside one", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editable-clear-${crypto.randomUUID()}`;
		// The blank span holds only an empty text node: its selected contents show nothing, so a Backspace there
		// would delete the "p" before it.
		const clearHtml = `<!doctype html><div id="pictured" contenteditable><img alt="pic" width="20" height="20"
src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div><div id="hidden" contenteditable><span style="display:none">old</span></div>
<div id="host" contenteditable>keep<span id="blank"></span>this</div>
<script>document.querySelector("#blank").append("");</script>`;
		const context = { session, toolCallId: "browser-editable-clear" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(clearHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#pictured", "");
await tab.fill("#hidden", "");
await tab.fill("#blank", "");
return {
	images: await tab.count("#pictured img"),
	hidden: await tab.evaluate(() => document.querySelector("#hidden").textContent),
	host: await tab.text("#host"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ images: number; hidden: string; host: string }>(result)).toEqual({
				images: 0,
				hidden: "",
				host: "keepthis",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("refuses to fill a contenteditable whose focus handler moves focus off it", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editable-focus-${crypto.randomUUID()}`;
		// One editor sends focus to another control, the other to a focusable wrapper around it.
		const focusHtml = `<!doctype html><input id="other" value="keep"><div id="editor" contenteditable>old</div>
<div id="wrapper" tabindex="-1"><div id="wrapped" contenteditable>old</div></div>
<script>
document.querySelector("#editor").addEventListener("focus", () => document.querySelector("#other").focus());
document.querySelector("#wrapped").addEventListener("focus", () => document.querySelector("#wrapper").focus());
</script>`;
		const context = { session, toolCallId: "browser-editable-focus" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(focusHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const refusal = async selector => {
  try { await tab.fill(selector, "new"); } catch (error) { return error.message; }
  return "";
};
return {
	refused: [await refusal("#editor"), await refusal("#wrapped")],
	other: await tab.value("#other"),
	editor: await tab.text("#editor"),
	wrapped: await tab.text("#wrapped"),
};`,
					timeout: 25,
				},
				context,
			);
			const outcome = valueFrom<{ refused: string[]; other: string; editor: string; wrapped: string }>(result);
			for (const refused of outcome.refused) expect(refused).toContain("does not keep focus");
			expect(outcome).toMatchObject({ other: "keep", editor: "old", wrapped: "old" });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills an element inside an editing host whose host hands focus to it", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editable-inner-focus-${crypto.randomUUID()}`;
		const innerHtml = `<!doctype html><div id="host" contenteditable>keep<span id="target" tabindex="0">old</span>end</div>
<script>
document.querySelector("#host").addEventListener("focus", () => document.querySelector("#target").focus());
</script>`;
		const context = { session, toolCallId: "browser-editable-inner-focus" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(innerHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#target", "new");
return await tab.text("#host");`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<string>(result)).toBe("keepnewend");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills and clears a contenteditable inside a closed shadow root through its observed handle", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editable-closed-${crypto.randomUUID()}`;
		const closedHtml = `<!doctype html><div id="host"></div>
<script>
const root = document.querySelector("#host").attachShadow({ mode: "closed" });
root.innerHTML = '<div contenteditable role="textbox" aria-label="Closed editor">old</div>';
window.closedEditor = root.firstChild;
</script>`;
		const context = { session, toolCallId: "browser-editable-closed" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(closedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const { elements } = await tab.observe();
const editor = await tab.id(elements.find(element => element.name === "Closed editor").id);
await editor.fill("new");
const filled = await tab.evaluate(() => window.closedEditor.textContent);
await editor.fill("");
return { filled, cleared: await tab.evaluate(() => window.closedEditor.textContent) };`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ filled: string; cleared: string }>(result)).toEqual({ filled: "new", cleared: "" });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("a multi-line fill of a contenteditable inserts its line breaks without pressing Enter", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `editable-lines-${crypto.randomUUID()}`;
		// Like a chat composer, Enter sends what the editor holds.
		const linesHtml = `<!doctype html><div id="composer" contenteditable style="white-space: pre-wrap">draft</div>
<script>
window.sent = [];
const composer = document.querySelector("#composer");
composer.addEventListener("keydown", event => {
  if (event.key === "Enter") sent.push(composer.innerText);
});
</script>`;
		const context = { session, toolCallId: "browser-editable-lines" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(linesHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#composer", "line one\\nline two");
return { text: await tab.text("#composer"), sent: await tab.evaluate(() => window.sent) };`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ text: string; sent: string[] }>(result)).toEqual({ text: "line one\nline two", sent: [] });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills colour, date, time and range inputs with their value instead of typing into them", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `pickers-${crypto.randomUUID()}`;
		const pickersHtml = `<!doctype html><input id="color" type="color"><input id="date" type="date">
<input id="time" type="time"><input id="datetime-local" type="datetime-local"><input id="month" type="month">
<input id="week" type="week"><input id="range" type="range" min="0" max="10"><div id="host"></div>
<script>
window.reported = [];
for (const field of document.querySelectorAll("input")) {
  field.addEventListener("input", () => reported.push("input:" + field.id + "=" + field.value));
  field.addEventListener("change", () => reported.push("change:" + field.id + "=" + field.value));
}
document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<input id="shadow-date" type="date">';
// What crosses the shadow boundary to a listener on the document.
for (const type of ["input", "change"]) {
  document.addEventListener(type, event => {
    if (event.target.id === "host") reported.push(type + ":host=" + event.composedPath()[0].value);
  });
}
</script>`;
		const context = { session, toolCallId: "browser-pickers" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(pickersHtml)}` },
			context,
		);
		try {
			// Typing left the colour at #000000, turned the date into 61012-02-02, the range at 5, and a
			// second time fill emptied the field.
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const filled = {
  color: "#FF8800",
  date: "2026-10-12",
  time: "14:30",
  "datetime-local": "2026-10-12T14:30",
  month: "2026-10",
  week: "2026-W41",
  range: "7",
};
for (const [id, value] of Object.entries(filled)) await tab.fill("#" + id, value);
await tab.fill("#time", "16:45");
await tab.fill("#month", "");
// Filling the value a field already holds changes nothing, so it reports nothing.
await tab.fill("#week", "2026-W41");
await tab.fill("pierce/#shadow-date", "2026-10-12");
const read = async () => {
  const values = {};
  for (const id of Object.keys(filled)) values[id] = await tab.value("#" + id);
  return values;
};
const values = await read();
const refused = [];
for (const [id, value] of [["date", "12/10/2026"], ["color", "nonsense"], ["color", ""], ["range", "11"], ["range", ""], ["range", "0x5"]]) {
  try { await tab.fill("#" + id, value); } catch (error) { refused.push(error.message); }
}
// An exponent spelling of the current value is accepted and changes nothing.
await tab.fill("#range", "7e0");
return { values, reported: await tab.evaluate(() => window.reported), refused, after: await read() };`,
					timeout: 25,
				},
				context,
			);
			const value = valueFrom<{
				values: Record<string, string>;
				reported: string[];
				refused: string[];
				after: Record<string, string>;
			}>(result);
			expect(value.values).toEqual({
				color: "#ff8800",
				date: "2026-10-12",
				time: "16:45",
				"datetime-local": "2026-10-12T14:30",
				month: "",
				week: "2026-W41",
				range: "7",
			});
			// Each fill reports its value once, the way a pick in the native picker does; a refused one reports nothing.
			expect(value.reported).toEqual([
				...[
					["color", "#ff8800"],
					["date", "2026-10-12"],
					["time", "14:30"],
					["datetime-local", "2026-10-12T14:30"],
					["month", "2026-10"],
					["week", "2026-W41"],
					["range", "7"],
					["time", "16:45"],
					["month", ""],
				].flatMap(([id, filled]) => [`input:${id}=${filled}`, `change:${id}=${filled}`]),
				// Like Chrome's own events, input leaves a shadow root and change stays inside it.
				"input:host=2026-10-12",
			]);
			expect(value.refused).toEqual([
				expect.stringContaining('<input type=date> does not accept "12/10/2026"'),
				expect.stringContaining('<input type=color> does not accept "nonsense"'),
				expect.stringContaining('<input type=color> does not accept ""'),
				expect.stringContaining('<input type=range> does not accept "11"'),
				expect.stringContaining('<input type=range> does not accept ""'),
				expect.stringContaining('<input type=range> does not accept "0x5"'),
			]);
			// A refused fill leaves the value it found.
			expect(value.after).toEqual(value.values);
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("fills a colour by any CSS name and leaves a refused picker following its value attribute", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `picker-css-${crypto.randomUUID()}`;
		const html = `<!doctype html><input id="color" type="color" value="#123456"><input id="date" type="date" value="2026-10-12">`;
		const context = { session, toolCallId: "browser-picker-css" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(html)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const colors = [];
// A colour the input stores as #000000 is taken only if it draws black, so the last three leave red in place.
for (const value of ["red", "oklab(0.5 0.1 0.1)", "rgb(0 0 0)", "oklab(0 0 0)", "color(srgb 0 0 0)", "currentcolor", "red", "var(--missing)", "light-dark(red, blue)", "rgb(from red r g b)"]) {
  try {
    await tab.fill("#color", value);
    colors.push(await tab.value("#color"));
  } catch (error) {
    colors.push(error.message);
  }
}
let refused = "";
try { await tab.fill("#date", "12/10/2026"); } catch (error) { refused = error.message; }
// An input nothing has written to still takes its value from the attribute.
await tab.evaluate(() => document.querySelector("#date").setAttribute("value", "2020-01-01"));
return { colors, color: await tab.value("#color"), refused, date: await tab.value("#date") };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<{ colors: string[]; color: string; refused: string; date: string }>(result)).toEqual({
				colors: [
					"#ff0000",
					"#a14203",
					"#000000",
					"#000000",
					"#000000",
					"#000000",
					"#ff0000",
					expect.stringContaining('<input type=color> does not accept "var(--missing)"'),
					expect.stringContaining('<input type=color> does not accept "light-dark(red, blue)"'),
					expect.stringContaining('<input type=color> does not accept "rgb(from red r g b)"'),
				],
				color: "#ff0000",
				refused: expect.stringContaining('<input type=date> does not accept "12/10/2026"'),
				date: "2020-01-01",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("fills picker inputs on an XHTML page with their value", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `picker-xhtml-${crypto.randomUUID()}`;
		const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><input id="date" type="date"/></body></html>`;
		const context = { session, toolCallId: "browser-picker-xhtml" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:application/xhtml+xml,${encodeURIComponent(xhtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#date", "2026-10-12");
return { tag: await tab.evaluate(() => document.querySelector("#date").tagName), date: await tab.value("#date") };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<{ tag: string; date: string }>(result)).toEqual({ tag: "input", date: "2026-10-12" });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("refuses a value a picker input rejects on an XML page", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `picker-xml-${crypto.randomUUID()}`;
		// An XML document's createElement makes a generic element that keeps any value, not an input.
		const xml = `<root><input xmlns="http://www.w3.org/1999/xhtml" id="date" type="date" value="2026-10-12"/></root>`;
		const context = { session, toolCallId: "browser-picker-xml" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:application/xml,${encodeURIComponent(xml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `let refused = "";
try { await tab.fill("#date", "12/10/2026"); } catch (error) { refused = error.message; }
return { refused, date: await tab.value("#date") };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<{ refused: string; date: string }>(result)).toEqual({
				refused: expect.stringContaining('<input type=date> does not accept "12/10/2026"'),
				date: "2026-10-12",
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("fills a customized built-in picker past a value tracker on the element", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `picker-tracker-${crypto.randomUUID()}`;
		// Like React's value tracker: an own `value` on the element that records each write through it, so an
		// input event whose value it already recorded reads as no change. The element is a customized built-in, whose
		// own prototype does not hold `value`; both an observed element's handle and `tab.fill` must still reach the
		// native setter.
		const trackerHtml = `<!doctype html><script>
customElements.define("x-range", class extends HTMLInputElement {}, { extends: "input" });
</script><input id="volume" is="x-range" type="range" min="0" max="10" aria-label="Volume"><script>
const field = document.querySelector("#volume");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let tracked = field.value;
Object.defineProperty(field, "value", {
  configurable: true,
  get() { return native.get.call(this); },
  set(next) { tracked = String(next); native.set.call(this, next); },
});
window.seen = [];
field.addEventListener("input", () => {
  if (field.value !== tracked) seen.push(field.value);
  tracked = field.value;
});
</script>`;
		const context = { session, toolCallId: "browser-picker-tracker" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(trackerHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const { elements } = await tab.observe();
const main = await tab.id(elements.find(element => element.name === "Volume").id);
await main.fill("7");
await tab.fill("#volume", "3");
return await tab.evaluate(() => ({ customized: Object.getPrototypeOf(document.querySelector("#volume")) !== HTMLInputElement.prototype, seen: window.seen }));`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<{ customized: boolean; seen: string[] }>(result)).toEqual({
				customized: true,
				seen: ["7", "3"],
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("fills a customized built-in picker without running the page class's own constructor or value accessor", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const tabName = `picker-accessor-${crypto.randomUUID()}`;
		// The page's class counts its instances and overrides `value` to log each write. Fill validates on a plain
		// input and reaches the native setter, so it makes no instance and the accessor never runs.
		const accessorHtml = `<!doctype html><script>
window.calls = [];
window.made = 0;
customElements.define("x-range", class extends HTMLInputElement {
  constructor() { super(); made++; }
  get value() { return super.value; }
  set value(next) { calls.push(next); super.value = next; }
}, { extends: "input" });
</script><input id="volume" is="x-range" type="range" min="0" max="10" aria-label="Volume">`;
		const context = { session, toolCallId: "browser-picker-accessor" };
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(accessorHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.fill("#volume", "3");
const filled = await tab.value("#volume");
const { elements } = await tab.observe();
await (await tab.id(elements.find(element => element.name === "Volume").id)).fill("7");
return {
  customized: await tab.evaluate(() => Object.getPrototypeOf(document.querySelector("#volume")) !== HTMLInputElement.prototype),
  values: [filled, await tab.value("#volume")],
  calls: await tab.evaluate(() => window.calls),
  made: await tab.evaluate(() => window.made),
};`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<{ customized: boolean; values: string[]; calls: string[]; made: number }>(result)).toEqual({
				customized: true,
				values: ["3", "7"],
				calls: [],
				made: 1,
			});
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	// Backgrounded headless tabs deliver no animation frames, which stalls every
	// Puppeteer `Locator` precondition (viewport/stability/enabled) forever.
	// Virtual time pinned at "pause" reproduces that state deterministically.
	test("fills page and frame selectors on a tab that produces no animation frames", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const starvedHtml = `<!doctype html><input id="q" value="stale"><div id="editable" contenteditable>stale</div>
<button id="top" onclick="this.dataset.clicked=1">Top level</button>
<iframe id="inner" srcdoc='<!doctype html><input id="deep" value="stale"><button id="go" onclick="this.dataset.clicked=1">Go</button>'></iframe>`;
		const context = { session, toolCallId: "browser-starved" };
		await prelude.invoke(
			{ action: "open", name: STARVED_TAB_NAME, url: `data:text/html,${encodeURIComponent(starvedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: STARVED_TAB_NAME,
					code: `await tab.waitFor("#inner");
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
await tab.fill("#q", "typed");
const inner = await tab.frame("#inner");
await inner.fill("#deep", "nested");
await tab.fill("#editable", "replaced");
await inner.click("#go");
await tab.click("text/Top level");
return {
	page: await tab.value("#q"),
	frame: await inner.value("#deep"),
	editable: await tab.text("#editable"),
	clicked: await inner.attr("#go", "data-clicked"),
	textClicked: await tab.attr("#top", "data-clicked"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(
				valueFrom<{ page: string; frame: string; editable: string; clicked: string; textClicked: string }>(result),
			).toEqual({
				page: "typed",
				frame: "nested",
				editable: "replaced",
				clicked: "1",
				textClicked: "1",
			});
		} finally {
			await prelude.invoke({ action: "close", name: STARVED_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("checks custom-styled checkboxes where their drawn box is, for the left button only", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-custom-checkbox" };
		const tabName = `custom-checkbox-${crypto.randomUUID()}`;
		// #terms, #nested and #shadowed hold a link or button inside the label, which no click may follow.
		const customHtml = `<!doctype html><style>label { position: relative; display: block; padding: 4px 24px } input { position: absolute; left: 4px; top: 4px; margin: 0 } .box { position: absolute; left: 2px; top: 2px; width: 18px; height: 18px; background: #fff; border: 1px solid #333 }</style>
<label><input id="faded" type="checkbox" style="opacity:0"><span style="position:absolute;left:4px;top:4px;width:14px;height:14px;border:1px solid #333"></span>Faded option</label>
<label><input id="covered" type="checkbox"><span class="box"></span>Covered option</label>
<label style="display:inline-block"><input id="terms" type="checkbox" style="opacity:0"><span class="box"></span>I agree to the <a href="#terms-page">Terms of Service and Privacy Policy</a></label>
<label><input id="nested" type="checkbox"><button class="box" type="button"></button>Nested option</label>
<label><input id="shadowed" type="checkbox"><a class="box" href="#tos"><x-icon></x-icon></a>Shadowed option</label>
<script>customElements.define("x-icon", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<span style="display:block;width:18px;height:18px"></span>'; } });</script>
<script>
window.changes = 0;
window.links = 0;
document.addEventListener("change", event => { if (event.isTrusted) changes++; });
document.addEventListener("click", event => { if (event.target.closest("a")) { links++; event.preventDefault(); } });
</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(customHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.check("#faded");
await tab.check("#covered");
await tab.uncheck("#covered");
await tab.click("#covered");
await tab.check("#terms");
const refusal = async click => {
	try {
		await click();
		return "pressed";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};
const nested = await refusal(() => tab.click("#nested"));
const shadowed = await refusal(() => tab.click("#shadowed"));
const { elements } = await tab.observe();
const covered = await tab.id(elements.find(element => element.name === "Covered option").id);
const rightClick = await refusal(() => covered.click({ button: "right" }));
const state = await tab.evaluate(() => ({
	faded: document.querySelector("#faded").checked,
	covered: document.querySelector("#covered").checked,
	terms: document.querySelector("#terms").checked,
	changes: window.changes,
	links: window.links,
}));
return { ...state, nested, shadowed, rightClick };`,
					timeout: 15,
				},
				context,
			);
			const value = valueFrom<Record<string, unknown>>(result);
			expect(value).toMatchObject({
				faded: true,
				covered: true,
				terms: true,
				// One trusted change per call: a state forced through the DOM fires an untrusted one.
				changes: 5,
				links: 0,
			});
			expect(value.nested).toContain("covered by <button.box>");
			expect(value.shadowed).toContain("covered by");
			expect(value.rightClick).toContain("covered by <span.box>");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("clicks a radio or checkbox whose real input is transparent, by id, ref and selector", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-transparent-radio" };
		const tabName = `transparent-radio-${crypto.randomUUID()}`;
		// GOV.UK radios: the opacity:0 input sits on top of the circle its label draws. #agree's label draws over its input.
		const radiosHtml = `<!doctype html><style>
.item { display: flex; position: relative; margin-bottom: 10px }
.radio { z-index: 1; width: 44px; height: 44px; margin: 0; opacity: 0 }
.item label::before { content: ""; position: absolute; top: 2px; left: 2px; width: 40px; height: 40px; border: 2px solid; border-radius: 50%; box-sizing: border-box }
#agree { position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: 0; opacity: 0 }
#agree + label { padding-left: 50px }
</style>
<div class="item"><input class="radio" id="maternity" name="leave" type="radio"><label for="maternity">Maternity</label></div>
<div class="item"><input class="radio" id="paternity" name="leave" type="radio"><label for="paternity">Paternity</label></div>
<div class="item"><input id="agree" type="checkbox"><label for="agree">I agree</label></div>
<script>window.changes = 0; document.addEventListener("change", event => { if (event.isTrusted) changes++; });</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(radiosHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const { elements } = await tab.observe();
await (await tab.id(elements.find(element => element.name === "Maternity").id)).click();
const ref = (await tab.ariaSnapshot()).match(/radio "Paternity".*\\[ref=(e\\d+)\\]/)[1];
await (await tab.ref(ref)).click();
await tab.click("#agree");
return await tab.evaluate(() => ({
	leave: document.querySelector("input[name=leave]:checked")?.id,
	agree: document.querySelector("#agree").checked,
	changes: window.changes,
}));`,
					timeout: 15,
				},
				context,
			);
			// One trusted change per click: each one really reached its input.
			expect(valueFrom<Record<string, unknown>>(result)).toEqual({ leave: "paternity", agree: true, changes: 3 });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("scrolls below-the-fold text matches into view and clicks shadow-DOM buttons", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-text-click" };
		const textHtml = `<!doctype html>
<style>
#covered-wrap { position: relative; width: max-content }
#text-overlay { position: absolute; inset: 0; background: white }
</style>
<div id="covered-wrap"><button>Covered match</button><div id="text-overlay"></div></div>
<button id="sliver" style="position: absolute; left: 0; top: calc(100vh - .5px)" onclick="window.clicks.sliver++">Sliver match</button>
<div style="height: 4000px">Tall content</div>
<button id="snippets" onclick="window.clicks.snippets++">View Snippets</button>
<div style="height: 2000px"></div>
<s-button id="save"></s-button>
<script>
window.clicks = { sliver: 0, snippets: 0, save: 0 };
customElements.define("s-button", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="inner-save">Save</button>';
    root.querySelector("button").addEventListener("click", () => window.clicks.save++);
  }
});
</script>`;
		await prelude.invoke(
			{ action: "open", name: TEXT_TAB_NAME, url: `data:text/html,${encodeURIComponent(textHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: TEXT_TAB_NAME,
					code: `let blocked;
try {
	await tab.click("text/Covered match");
} catch (error) {
	blocked = error instanceof Error ? error.message : String(error);
}
await tab.click("text/Sliver match");
await tab.evaluate(() => window.scrollTo(0, 0));
await tab.click("text/View Snippets");
const afterSnippets = await tab.evaluate(() => ({ ...window.clicks }));
await tab.evaluate(() => window.scrollTo(0, 0));
await tab.click("text/Save");
await tab.evaluate(() => window.scrollTo(0, 0));
await tab.click("pierce/#inner-save");
return { blocked, afterSnippets, final: await tab.evaluate(() => window.clicks) };`,
					timeout: 30,
				},
				context,
			);
			const { blocked, ...clicks } = valueFrom<{ blocked: string }>(result);
			expect(blocked).toContain("covered by <div#text-overlay>");
			expect(clicks).toEqual({
				afterSnippets: { sliver: 1, snippets: 1, save: 0 },
				final: { sliver: 1, snippets: 1, save: 2 },
			});
		} finally {
			await prelude.invoke({ action: "close", name: TEXT_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);

	test("prefers an on-screen text match over one clipped by a scroll container", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-text-click-clipped" };
		const tabName = `text-click-clipped-${crypto.randomUUID()}`;
		const clippedHtml = `<!doctype html>
<div id="panel" style="width: 100px; overflow: auto; white-space: nowrap"><span style="display: inline-block; width: 400px"></span><button onclick="window.picks.push('clipped')">Pick</button></div>
<button onclick="window.picks.push('visible')">Pick</button>
<script>window.picks = [];</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(clippedHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.click("text/Pick");
return { picks: await tab.evaluate(() => window.picks), panelScroll: await tab.evaluate(() => document.querySelector("#panel").scrollLeft) };`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<unknown>(result)).toEqual({ picks: ["visible"], panelScroll: 0 });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("clicks the first text match a scroll container shows a strip of, not one an overlay leaves an edge of", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-text-click-strip" };
		const tabName = `text-click-strip-${crypto.randomUUID()}`;
		// Each first button shows only its edge: 1px of 120px at a scroll panel's edge, 2px beside a fixed overlay,
		// or 2px beside its wrapper's ::after, which hit testing reports as the wrapper, an ancestor.
		const fixtures = {
			strip: `<div style="width: 100px; overflow: auto; white-space: nowrap"><span style="display: inline-block; width: 99px"></span><button style="width: 120px" onclick="window.picks.push('strip')">Pick</button></div>
<button onclick="window.picks.push('later')">Pick</button>`,
			covered: `<button style="position: absolute; left: 10px; top: 10px; width: 120px" onclick="window.picks.push('covered')">Pick</button>
<div style="position: fixed; left: 0; top: 0; width: 128px; height: 200px; background: white"><button style="margin-top: 100px" onclick="window.picks.push('overlay')">Pick</button></div>`,
			pseudo: `<style>#wrap { position: relative; display: inline-block } #wrap::after { content: ""; position: absolute; inset: 0 2px 0 0; background: white }</style>
<div id="wrap"><button style="width: 120px" onclick="window.picks.push('pseudo')">Pick</button></div>
<button onclick="window.picks.push('later')">Pick</button>`,
		};
		await prelude.invoke({ action: "open", name: tabName, url: "about:blank" }, context);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const picks = {};
for (const [name, html] of Object.entries(${JSON.stringify(fixtures)})) {
	await tab.evaluate(html => {
		document.body.innerHTML = html;
		window.picks = [];
	}, html);
	picks[name] = await tab.click("text/Pick").then(() => tab.evaluate(() => window.picks), error => String(error));
}
return picks;`,
					timeout: 20,
				},
				context,
			);
			expect(valueFrom<unknown>(result)).toEqual({ strip: ["strip"], covered: ["overlay"], pseudo: ["later"] });
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("fails a click the browser does not deliver and completes the rest", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		const outcomes = async (ids: string[]): Promise<Record<string, string>> => {
			const result: Record<string, string> = {};
			for (const id of ids) {
				const handle = await page.$(`#${id}`);
				if (!handle) throw new Error(`Expected #${id}`);
				result[id] = await clickElement(handle, `click #${id}`).then(
					() => "clicked",
					error =>
						String(error).includes("did not deliver the click")
							? "refused"
							: String(error).includes("covered by")
								? "covered"
								: String(error),
				);
				await handle.dispose();
			}
			return result;
		};
		try {
			// Shadow roots hold a disabled button around the host's content, or around an alternate slot only.
			await page.setContent(`<button id="enabled">Enabled</button>
<button id="disabled" disabled>Disabled</button>
<div inert><button id="inert">Inert</button></div>
<div style="interactivity: inert"><button id="styled-inert">Styled inert</button></div>
<span id="shadowed">Shadowed</span>
<span id="actions">Go<span slot="alt" hidden>Alt</span></span>
<button id="menu-item">Menu item</button>
<script>
document.getElementById("shadowed").attachShadow({ mode: "open" }).innerHTML = "<button disabled><slot></slot></button>";
document.getElementById("actions").attachShadow({ mode: "open" }).innerHTML =
	'<button disabled><slot name="alt"></slot></button><button><slot></slot></button>';
// A menu item acts on pointerdown, consumes it (so no mouse events follow) and closes.
document.getElementById("menu-item").addEventListener("pointerdown", event => {
	event.preventDefault();
	event.currentTarget.remove();
});
</script>`);
			expect(
				await outcomes(["enabled", "disabled", "inert", "styled-inert", "shadowed", "actions", "menu-item"]),
			).toEqual({
				enabled: "clicked",
				disabled: "refused",
				inert: "refused",
				"styled-inert": "refused",
				shadowed: "refused",
				actions: "clicked",
				"menu-item": "clicked",
			});
			// A modal dialog escapes the inert shell it sits in; the shell lies under its backdrop.
			await page.setContent(`<div inert><button id="shell">Shell</button><dialog id="dlg"><button id="ok">OK</button></dialog></div>
<script>document.getElementById("dlg").showModal();</script>`);
			expect(await outcomes(["ok", "shell"])).toEqual({ ok: "clicked", shell: "covered" });
			// A button in a closed shadow root receives the click though the window only sees its host.
			const closed = await page.evaluateHandle(`(() => {
	const host = document.body.appendChild(document.createElement("div"));
	const root = host.attachShadow({ mode: "closed" });
	root.innerHTML = "<button>Closed</button>";
	return root.querySelector("button");
})()`);
			const closedButton = closed.asElement();
			if (!closedButton) throw new Error("Expected the closed-root button");
			await page.evaluate("document.querySelector('dialog').close()");
			expect(await clickElement(closedButton, "click closed").then(() => "clicked")).toBe("clicked");
			await closed.dispose();
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);

	test("fails a click whose frame the page removes while the first press is down, and keeps one it removes on a click", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		// Each frame counts its button's clicks on the top document, and removes itself on the `removeOn` event.
		const frameClick = async (removeOn: string, clickCount = 1): Promise<{ outcome: string; clicks: string }> => {
			const script = `const button = document.querySelector("button");
button.addEventListener("click", () => { top.document.body.dataset.clicks = String(Number(top.document.body.dataset.clicks || 0) + 1); });
button.addEventListener("${removeOn}", () => frameElement.remove());`;
			const srcdoc = `<button>Bump</button><script>${script}</script>`
				.replaceAll("&", "&amp;")
				.replaceAll('"', "&quot;");
			await page.setContent(
				`<button style="position:absolute;inset:0;width:100%;height:100%" onclick="document.body.dataset.stray='1'">Behind</button><iframe style="position:relative" name="inner" srcdoc="${srcdoc}"></iframe>`,
			);
			const frame = await page.waitForFrame(candidate => candidate.name() === "inner");
			const handle = await frame.waitForSelector("button");
			if (!handle) throw new Error("Expected the frame's button");
			const outcome = await clickElement(handle, "click bump", undefined, { clickCount }).then(
				() => "clicked",
				error => (String(error).includes("could not confirm the click") ? "unconfirmed" : String(error)),
			);
			await handle.dispose().catch(() => undefined);
			if (removeOn !== "click") expect(await page.evaluate("document.body.dataset.stray || '0'")).toBe("0");
			return { outcome, clicks: String(await page.evaluate("document.body.dataset.clicks || '0'")) };
		};
		try {
			expect(await frameClick("pointerdown")).toEqual({ outcome: "unconfirmed", clicks: "0" });
			expect(await frameClick("mousedown")).toEqual({ outcome: "unconfirmed", clicks: "0" });
			expect(await frameClick("pointerdown", 2)).toEqual({ outcome: "unconfirmed", clicks: "0" });
			// The page acts on the click and removes the frame after it, as a consent or sign-in frame closing does.
			expect(await frameClick("click")).toEqual({ outcome: "clicked", clicks: "1" });
			expect(await frameClick("click", 2)).toEqual({ outcome: "clicked", clicks: "1" });
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);

	test("keeps a child-frame click delivered when the first press navigates its frame", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent(
				`<iframe name="inner" srcdoc="<button onpointerdown='location.replace(&quot;about:blank&quot;)'>Go</button>"></iframe>`,
			);
			const frame = await page.waitForFrame(candidate => candidate.name() === "inner");
			const handle = await frame.waitForSelector("button");
			if (!handle) throw new Error("Expected the frame's button");
			const navigated = frame.waitForNavigation();
			expect(await clickElement(handle, "click go").then(() => "clicked")).toBe("clicked");
			await navigated;
			expect(frame.detached).toBe(false);
			expect(frame.url()).toBe("about:blank");
			await handle.dispose().catch(() => undefined);
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	});

	test("skips an off-screen text match that stays clipped once scrolled to", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent(`<div style="height: 3000px"></div><div style="overflow: hidden; height: 0"><button id="clipped">Far</button></div>
<div style="height: 3000px"></div><button id="enabled">Far</button>`);
			const handles = await page.$$("text/Far");
			const winner = await resolveActionableQueryHandlerClickTarget(handles);
			const winnerId = await winner?.evaluate(el => {
				// Puppeteer's page callback type cannot name DOM globals in this test environment.
				const element = el as unknown as { id: string };
				return element.id;
			});
			expect(winnerId).toBe("enabled");
			await Promise.all([winner, ...handles].map(handle => handle?.dispose()));
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);

	test("scrolls off-screen text matches only until the first reachable one", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent(`<div style="height: 3000px"></div><button id="near">Far</button>
<div style="height: 3000px"></div><button id="farther">Far</button>`);
			const handles = await page.$$("text/Far");
			const winner = await resolveActionableQueryHandlerClickTarget(handles);
			// The page stays where the last probe scrolled it, so the farther match must not have been probed.
			const probe = await page.evaluate(() => {
				// Puppeteer's page callback type cannot name DOM globals in this test environment.
				const page = globalThis as unknown as {
					scrollY: number;
					innerHeight: number;
					document: { querySelector(selector: string): { offsetTop: number } };
				};
				const nearTop = page.document.querySelector("#near").offsetTop;
				return { scrollY: page.scrollY, nearBottomScroll: nearTop + page.innerHeight };
			});
			const winnerId = await winner?.evaluate(el => {
				const element = el as unknown as { id: string };
				return element.id;
			});
			expect(winnerId).toBe("near");
			expect(probe.scrollY).toBeLessThan(probe.nearBottomScroll);
			await Promise.all([winner, ...handles].map(handle => handle?.dispose()));
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);

	test("clips query matches only by overflow boxes holding their containing block, through slots", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		const later = `<button id="later" style="position: absolute; top: 200px; left: 10px">Pick</button>`;
		const shadow = (id: string, html: string) =>
			`document.getElementById(${JSON.stringify(id)}).attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(html)};`;
		const zeroClip = `<div style="overflow: hidden; height: 0"><slot></slot></div>`;
		// Puppeteer's text handler yields a shadow host rather than its slotted children, so slotted
		// fixtures pass CSS-selected handles straight to the resolver.
		const fixtures: Record<string, { html: string; winner: string; selector?: string }> = {
			// The static overflow box is not the absolute button's containing block, so it does not clip it.
			"absolute escaping a static clip": {
				html: `<div style="overflow: hidden; height: 0"><button id="escaped" style="position: absolute; top: 10px; left: 10px">Pick</button></div>${later}`,
				winner: "escaped",
			},
			"fixed escaping a positioned clip": {
				html: `<div style="position: relative; overflow: hidden; height: 0"><button id="escaped" style="position: fixed; top: 10px; left: 10px">Pick</button></div>${later}`,
				winner: "escaped",
			},
			"absolute inside its positioned clip": {
				html: `<div style="position: relative; overflow: hidden; height: 0"><button id="clipped" style="position: absolute; top: 10px; left: 10px">Pick</button></div>${later}`,
				winner: "later",
			},
			"clipped by paint containment": {
				html: `<div style="contain: paint; height: 0"><button id="clipped">Pick</button></div>${later}`,
				winner: "later",
			},
			"clipped by content-visibility": {
				html: `<div style="content-visibility: auto; height: 0"><button id="clipped">Pick</button></div>${later}`,
				winner: "later",
			},
			"clipped by an inline svg viewport": {
				html: `<svg width="50" height="50"><text id="clipped" x="10" y="190">Pick</text></svg>${later}`,
				winner: "later",
			},
			"inside a scaled inline svg viewport": {
				html: `<svg width="50" height="50" style="transform: scale(4); transform-origin: 0 0"><text id="scaled" x="35" y="20">Pick</text></svg>${later}`,
				winner: "scaled",
			},
			"modal dialog escaping a transformed clip": {
				html: `<div style="transform: translateZ(0); overflow: hidden; height: 0"><dialog id="dlg" style="margin: 0"><button id="modal">Pick</button></dialog></div>${later}<script>document.getElementById("dlg").showModal();</script>`,
				winner: "modal",
			},
			"fixed match inside a modal dialog in a transformed clip": {
				html: `<div style="transform: translateZ(0); overflow: hidden; height: 0"><dialog id="dlg"><button id="modal" style="position: fixed; top: 10px; left: 10px">Pick</button></dialog></div>${later}<script>document.getElementById("dlg").showModal();</script>`,
				winner: "modal",
			},
			"slotted into a clipped shadow wrapper": {
				html: `<div id="host"><button id="slotted">Pick</button></div>${later}<script>${shadow("host", zeroClip)}</script>`,
				selector: "#slotted, #later",
				winner: "later",
			},
			"re-projected into a clipped inner shadow wrapper": {
				html: `<div id="outer"><button id="slotted">Pick</button></div>${later}<script>${shadow("outer", `<div id="inner"><slot></slot></div>`)}
document.getElementById("outer").shadowRoot.getElementById("inner").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(zeroClip)};</script>`,
				selector: "#slotted, #later",
				winner: "later",
			},
		};
		try {
			const winners: Record<string, string | undefined> = {};
			for (const [name, fixture] of Object.entries(fixtures)) {
				await page.setContent(`<!doctype html><body style="margin: 0">${fixture.html}</body>`);
				const handles = await page.$$(fixture.selector ?? "text/Pick");
				const winner = await resolveActionableQueryHandlerClickTarget(handles);
				winners[name] = await winner?.evaluate(el => {
					// Puppeteer's page callback type cannot name DOM globals in this test environment.
					const element = el as unknown as { id: string };
					return element.id;
				});
				await Promise.all([winner, ...handles].map(handle => handle?.dispose()));
			}
			expect(winners).toEqual(Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, f.winner])));
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser element handle clicks", () => {
	test("presses the requested button and click count through an element handle", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-element-click" };
		const tabName = `element-click-${crypto.randomUUID()}`;
		const menuHtml = `<!doctype html><button id="menu">Menu</button>
<script>window.presses = []; for (const type of ["mousedown", "dblclick", "contextmenu"]) document.querySelector("#menu").addEventListener(type, event => { presses.push(type + ":" + event.button); event.preventDefault(); });</script>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(menuHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `const { elements } = await tab.observe();
const menu = await tab.id(elements.find(element => element.name === "Menu").id);
await menu.click({ button: "right" });
await menu.click({ count: 2 });
return await tab.evaluate(() => window.presses);`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<string[]>(result)).toEqual([
				"mousedown:2",
				"contextmenu:2",
				"mousedown:0",
				"mousedown:0",
				"dblclick:0",
			]);
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("presses the requested button and click count through tab.click and frame.click", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-tab-click" };
		const tabName = `tab-click-${crypto.randomUUID()}`;
		const record = `window.presses = []; for (const type of ["mousedown", "dblclick", "contextmenu"]) document.querySelector("#menu").addEventListener(type, event => { presses.push(type + ":" + event.button); event.preventDefault(); });`;
		const menuHtml = `<!doctype html><button id="menu">Menu</button><script>${record}</script><iframe name="inner" srcdoc="<button id='menu'>Menu</button>"></iframe>`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(menuHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.click("#menu", { button: "right" });
await tab.click("text/Menu", { count: 2 });
const inner = await tab.frame("inner");
await inner.evaluate(${JSON.stringify(record)});
await inner.click("#menu", { button: "right" });
return [await tab.evaluate(() => window.presses), await inner.evaluate(() => window.presses)];`,
					timeout: 15,
				},
				context,
			);
			expect(valueFrom<string[][]>(result)).toEqual([
				["mousedown:2", "contextmenu:2", "mousedown:0", "mousedown:0", "dblclick:0"],
				["mousedown:2", "contextmenu:2"],
			]);
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	// A trapped button takes no clicks, and the page rebuilds the list once a click scrolls the button to the middle
	// of the view, as a page that rebuilds a list after a request does: the handle the click resolved is detached
	// before it could take the click. `rebuild` is what the rebuild leaves: a clickable button, or nothing; `trapped`
	// arms the trap at load. Clicks are counted in the DOM, which frame helpers read from their own world.
	const replacingList = (rebuild: string, trapped = false) =>
		`<!doctype html><style>body { margin: 0; height: 3000px; } #list { position: absolute; top: 500px; }</style><div id="list"></div>
<script>window.render = trap => { scrollTo(0, 0); const list = document.querySelector("#list"); list.innerHTML = trap ? '<button id="vol" style="pointer-events: none">pgdata-2</button>' : '<button id="vol">pgdata-2</button>'; list.firstChild.addEventListener("click", () => { document.body.dataset.clicks = (document.body.dataset.clicks ?? "") + "vol "; }); };
addEventListener("scroll", () => { const vol = document.querySelector("#vol"); if (scrollY > 0 && vol?.style.pointerEvents === "none") ${rebuild}; }); render(${trapped});</script>`;

	test("looks a selector up again when the page replaces its element before the click, and fails a replaced handle at once", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-replaced-click" };
		const tabName = `replaced-click-${crypto.randomUUID()}`;
		const listHtml = replacingList("render(false)");
		const frameHtml = replacingList("render(false)", true);
		const frameScript = `const inner = document.createElement("iframe"); inner.name = "inner"; inner.style = "position: absolute; top: 0; left: 300px; width: 900px; height: 700px; border: 0"; inner.srcdoc = ${JSON.stringify(frameHtml).replaceAll("</", "<\\/")}; document.body.append(inner);`;
		await prelude.invoke(
			{
				action: "open",
				name: tabName,
				url: `data:text/html,${encodeURIComponent(`${listHtml}<script>${frameScript}</script>`)}`,
			},
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.evaluate(() => window.render(true));
await tab.click("#vol");
await tab.evaluate(() => window.render(true));
await tab.click("text/pgdata-2");
const inner = await tab.frame("inner");
await inner.click("#vol");
const { elements } = await tab.observe();
const vol = await tab.id(elements.find(element => element.name === "pgdata-2").id);
await tab.evaluate(() => window.render(false));
let error = "";
try { await vol.click(); } catch (caught) { error = String(caught?.message ?? caught); }
const clicks = () => document.body.dataset.clicks;
return { clicks: await tab.evaluate(clicks), frameClicks: await inner.evaluate(clicks), error };`,
					timeout: 20,
				},
				context,
			);
			const { clicks, frameClicks, error } = valueFrom<{ clicks: string; frameClicks: string; error: string }>(
				result,
			);
			expect(clicks).toBe("vol vol ");
			expect(frameClicks).toBe("vol ");
			expect(error).toContain("is detached from the document");
			expect(error).not.toContain("timed out");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("looks replaced checkboxes up before returning their state and replaced radios up before unchecking", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		try {
			await page.setContent(
				'<input id="check" type="checkbox"><input id="uncheck" type="checkbox" checked><input id="radio" type="radio" checked>',
			);
			const signal = new AbortController().signal;
			for (const [id, desired] of [
				["check", true],
				["uncheck", false],
				["radio", false],
			] as const) {
				let first = true;
				await withLiveElement(
					async () => {
						const handle = await page.locator(`#${id}`).waitHandle();
						if (first) {
							first = false;
							await handle.evaluate((input, desired) => {
								if (input.type === "radio") {
									// Detach after the state read, before the separate radio mutation.
									Object.defineProperty(input, "checked", {
										get() {
											queueMicrotask(() => input.replaceWith(input.cloneNode()));
											return true;
										},
									});
								} else {
									const next = input.cloneNode() as typeof input;
									input.checked = desired;
									next.checked = !desired;
									input.replaceWith(next);
								}
							}, desired);
						}
						return handle;
					},
					async handle => {
						try {
							await setElementChecked(handle, desired, `tab.${desired ? "check" : "uncheck"}`, signal);
						} finally {
							await handle.dispose();
						}
					},
					signal,
				);
			}
			expect(await page.$$eval("input", inputs => inputs.map(input => input.checked))).toEqual([true, false, false]);
		} finally {
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	});

	test("a click whose element the page removed after replacing it reports the selector matching nothing", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-removed-click" };
		const tabName = `removed-click-${crypto.randomUUID()}`;
		const listHtml = replacingList('document.querySelector("#list").innerHTML = ""');
		await prelude.invoke(
			{ action: "open", name: tabName, url: `data:text/html,${encodeURIComponent(listHtml)}` },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.evaluate(() => window.render(true));
try { await tab.click("#vol"); return "clicked"; } catch (caught) { return String(caught?.message ?? caught); }`,
					timeout: 4,
				},
				context,
			);
			const error = valueFrom<string>(result);
			expect(error).toContain("timed out");
			expect(error).toContain("selector currently matches no elements");
			expect(error).not.toContain("detached");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
});

describe("looking a replaced element up again", () => {
	// Stands in for the handles `resolve` returns; `act` decides what happens to each.
	const handle = {} as ElementHandle;

	test("looks the element up again after each replacement, and reports a wait that runs out clicking as replaced", async () => {
		const controller = new AbortController();
		let lookups = 0;
		const error = await rejectionOf(
			withLiveElement(
				async () => {
					lookups++;
					return handle;
				},
				async () => {
					if (lookups < 3) throw new ElementDetachedError("tab.click(#vol)");
					controller.abort(new Error("deadline"));
					throw new Error("aborted");
				},
				controller.signal,
			),
		);
		expect(lookups).toBe(3);
		expect(error).toBeInstanceOf(ClickRefusedError);
		expect(error instanceof ClickRefusedError ? error.refusal : "").toContain("kept replacing");
	});
});
