import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const TAB_NAME = `interactions-${crypto.randomUUID()}`;
const STARVED_TAB_NAME = `starved-${crypto.randomUUID()}`;
const COMBO_TAB_NAME = `combos-${crypto.randomUUID()}`;
// The platform's editing modifier. On macOS its shortcuts are app-menu commands a
// CDP key event never reaches, so they only edit when the key-down names the command.
const SHORTCUT = process.platform === "darwin" ? "Meta" : "Control";
const comboHtml = `<!doctype html><textarea id="area">hello world</textarea><input id="field"><input id="paste">
<iframe id="inner" srcdoc='<!doctype html><textarea id="deep">nested text</textarea>'></iframe>`;
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

describe.skipIf(!CHROMIUM_AVAILABLE)("browser interaction parity", () => {
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

	// Backgrounded headless tabs deliver no animation frames, which stalls every
	// Puppeteer `Locator` precondition (viewport/stability/enabled) forever.
	// Virtual time pinned at "pause" reproduces that state deterministically.
	test("fills page and frame selectors on a tab that produces no animation frames", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const starvedHtml = `<!doctype html><input id="q" value="stale"><div id="editable" contenteditable>stale</div>
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
return {
	page: await tab.value("#q"),
	frame: await inner.value("#deep"),
	editable: await tab.text("#editable"),
	clicked: await inner.attr("#go", "data-clicked"),
};`,
					timeout: 25,
				},
				context,
			);
			expect(valueFrom<{ page: string; frame: string; editable: string; clicked: string }>(result)).toEqual({
				page: "typed",
				frame: "nested",
				editable: "replaced",
				clicked: "1",
			});
		} finally {
			await prelude.invoke({ action: "close", name: STARVED_TAB_NAME, kill: true }, context).catch(() => undefined);
		}
	}, 40_000);
});
