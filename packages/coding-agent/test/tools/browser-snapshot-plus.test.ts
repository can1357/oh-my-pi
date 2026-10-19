import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { buildAriaSnapshotScript, createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
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
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-snapshot-plus-${crypto.randomUUID()}` });
}

function valueFrom<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	return result.details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser snapshot and readable parity", () => {
	test("filters snapshots, scopes observations, diffs revisions, and extracts selected sections", async () => {
		const invoke = createHost();
		const name = `snapshot-plus-${crypto.randomUUID()}`;
		const filler = Array.from({ length: 24 }, (_, index) => `<p>Reference line ${index}</p>`).join("");
		const html = `<!doctype html><html><head><title>Snapshot fixture</title></head><body>
			<button id="outside">Outside control</button>
			<main id="scope">
				<h1>Product Guide</h1><p id="intro">Static introduction.</p>
				<section><h2>Install macOS</h2><p>Use brew.</p><button id="save">Save settings</button></section>
				<section><h2>Install Linux</h2><p>Use apt.</p></section>
				<a href="/help">Help center</a>${filler}
			</main>
		</body></html>`;
		await invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
		try {
			const interactive = valueFrom<string>(
				await invoke({
					action: "run",
					name,
					code: 'return await tab.ariaSnapshot("#scope", { interactive: true, urls: true });',
				}),
			);
			expect(interactive).toContain("Save settings");
			expect(interactive).toContain("Help center");
			expect(interactive).toContain("[href=");
			expect(interactive).not.toContain("Static introduction");

			const observed = valueFrom<{ elements: Array<{ name?: string }> }>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "observe", args: [{ selector: "#scope", includeAll: true, compact: true }] }],
				}),
			);
			expect(observed.elements.some(element => element.name === "Save settings")).toBeTrue();
			expect(observed.elements.some(element => element.name === "Outside control")).toBeFalse();

			const first = valueFrom<{ status: string; revision: number; snapshot?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(first).toMatchObject({ status: "full", revision: 1 });
			expect(first.snapshot).toContain("Static introduction");
			const unchanged = valueFrom<{ status: string; revision: number }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(unchanged).toEqual({ status: "unchanged", revision: 1 });

			await invoke({
				action: "call",
				name,
				chain: [
					{ method: "evaluate", args: ['document.querySelector("#intro").textContent = "Changed introduction."'] },
				],
			});
			const changed = valueFrom<{ status: string; revision: number; baseRevision?: number; delta?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(changed).toMatchObject({ status: "delta", revision: 2, baseRevision: 1 });
			expect(changed.delta).toContain("-    - paragraph [ref=e5]: Static introduction.");
			expect(changed.delta).toContain("+    - paragraph [ref=e5]: Changed introduction.");

			await invoke({
				action: "call",
				name,
				chain: [{ method: "goto", args: [`data:text/html,${encodeURIComponent("<h1>Another page</h1>")}`] }],
			});
			const navigated = valueFrom<{ status: string; revision: number; snapshot?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(navigated).toMatchObject({ status: "full", revision: 3 });

			await invoke({
				action: "call",
				name,
				chain: [{ method: "goto", args: [`data:text/html,${encodeURIComponent(html)}`] }],
			});
			const outline = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "extract", args: ["markdown", { selector: "#scope", outline: true }] }],
				}),
			);
			expect(outline).toBe("# Product Guide\n## Install macOS\n## Install Linux");
			const filtered = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "extract", args: ["markdown", { selector: "#scope", filter: "macOS" }] }],
				}),
			);
			expect(filtered).toContain("Use brew.");
			expect(filtered).not.toContain("Use apt.");
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 60_000);

	test("masks password field values in ARIA snapshots like observe() does", async () => {
		const invoke = createHost();
		const name = `snapshot-password-${crypto.randomUUID()}`;
		const secret = "Fake-Secret-9931";
		// Quotes, a backslash, a double space, ": " and a control character make Playwright normalize, JSON-quote and
		// YAML-escape this one; a second unpatchable password contains it.
		const pinnedValue = `${secret}-pinned "q" \\ x  y: it's\x01`;
		const longerValue = `${pinnedValue}-longer`;
		// Besides a plain field: password inputs Playwright gives no ref (no pointer events, zero size), a control
		// named by a password input through aria-labelledby, whose accessible name is the input's value, an input
		// carrying the page's own `value` accessor (React's change tracker installs one), ones the page made
		// unpatchable (a non-configurable accessor, a non-extensible input), and one adopted from another frame,
		// whose prototype is not this window's.
		const html = `<!doctype html><html><head><title>Sign in</title></head><body><form>
			<label>Email <input id="user" autocomplete="username"></label>
			<label>Password <input id="pw" type="password" autocomplete="current-password"></label>
			<input id="nopointer" type="password" aria-label="NoPointer" style="pointer-events:none">
			<input id="zero" type="password" aria-label="Zero" style="width:0;height:0;padding:0;border:0">
			<input id="tracked" type="password" aria-label="Tracked">
			<button aria-labelledby="pw"></button>
			<button>Sign in</button>
			<textarea id="notes" aria-label="Notes"></textarea>
		</form></body></html>`;
		await invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
		try {
			await invoke({
				action: "run",
				name,
				code: `await tab.fill("#user", "dana@example.test"); await tab.fill("#pw", ${JSON.stringify(secret)});
await tab.fill("#notes", "plain notes");
await tab.evaluate(s => { document.querySelector("#nopointer").value = s + "-np"; document.querySelector("#zero").value = s + "-zero"; }, ${JSON.stringify(secret)});
await tab.evaluate(s => {
	const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	const tracked = document.querySelector("#tracked");
	window.trackerGet = function () { return native.get.call(this); };
	Object.defineProperty(tracked, "value", { configurable: true, get: window.trackerGet, set(v) { native.set.call(this, v); } });
	tracked.value = s + "-tracked";
}, ${JSON.stringify(secret)});
await tab.evaluate((s, p, l) => {
	const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	const form = document.querySelector("form");
	const pin = (id, v) => {
		const input = form.appendChild(document.createElement("input"));
		input.type = "password";
		input.id = id;
		input.setAttribute("aria-label", id);
		native.set.call(input, v);
		form.appendChild(document.createElement("button")).setAttribute("aria-labelledby", id);
		return input;
	};
	Object.defineProperty(pin("pinned", p), "value", { get() { return native.get.call(this); } });
	Object.defineProperty(pin("longer", l), "value", { get() { return native.get.call(this); } });
	Object.preventExtensions(pin("sealed", s + "-sealed"));
	// Overlapping, neither containing the other: a name reading "k9 abX4" holds the end of one and all of the other.
	Object.defineProperty(pin("ovl1", "k9 ab"), "value", { get() { return native.get.call(this); } });
	Object.defineProperty(pin("ovl2", "abX4"), "value", { get() { return native.get.call(this); } });
	const pub = form.appendChild(document.createElement("span"));
	pub.id = "pub";
	pub.textContent = "k9";
	form.appendChild(document.createElement("button")).setAttribute("aria-labelledby", "pub ovl2");
	const frame = document.body.appendChild(document.createElement("iframe"));
	const adopted = frame.contentDocument.createElement("input");
	adopted.type = "password";
	adopted.id = "adopted";
	adopted.value = s + "-adopted";
	form.append(adopted);
	// The page holding it keeps the element's wrapper, and so its prototype, from the frame it came from.
	window.adoptedInput = adopted;
	form.appendChild(document.createElement("button")).setAttribute("aria-labelledby", "adopted");
}, ${JSON.stringify(secret)}, ${JSON.stringify(pinnedValue)}, ${JSON.stringify(longerValue)});`,
			});
			const snapshot = valueFrom<string>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot();" }),
			);
			expect(snapshot).toContain("dana@example.test");
			expect(snapshot).toContain("plain notes");
			expect(snapshot).not.toContain(secret);
			expect(snapshot).toContain(`textbox "Password" [ref=`);
			expect(snapshot).toContain("•".repeat(secret.length));
			expect(snapshot).toContain(`textbox "NoPointer": ${"•".repeat(secret.length + 3)}`);
			// The page keeps its real values once the snapshot is done.
			const restored = valueFrom<boolean>(
				await invoke({
					action: "run",
					name,
					code: `return await tab.evaluate(s => { const pw = document.querySelector("#pw"); return pw.value === s && !Object.getOwnPropertyDescriptor(pw, "value"); }, ${JSON.stringify(secret)});`,
				}),
			);
			expect(restored).toBeTrue();

			// A hidden password field whose page getter throws must not fail the whole snapshot.
			await invoke({
				action: "run",
				name,
				code: `await tab.evaluate(() => {
	const input = document.body.appendChild(document.createElement("input"));
	input.type = "password";
	input.hidden = true;
	Object.defineProperty(input, "value", { configurable: true, get() { throw new Error("no value"); } });
});`,
			});

			// cmux and frame snapshots run the same bundle in the page's own world, where the page's accessors are
			// the ones masked and must come back.
			const pageWorld = valueFrom<{ snapshot: string; kept: boolean; crossRealm: boolean }>(
				await invoke({
					action: "run",
					name,
					code: `return await tab.evaluate((script, s, p, l) => {
	const snapshot = (0, eval)(script);
	const value = id => document.getElementById(id).value;
	const kept = value("pw") === s && value("tracked") === s + "-tracked" && value("pinned") === p && value("longer") === l
		&& value("sealed") === s + "-sealed" && value("adopted") === s + "-adopted"
		&& Object.getOwnPropertyDescriptor(document.getElementById("tracked"), "value")?.get === window.trackerGet
		&& !Object.getOwnPropertyDescriptor(document.getElementById("adopted"), "value");
	return { snapshot, kept, crossRealm: !(window.adoptedInput instanceof HTMLInputElement) };
}, ${JSON.stringify(buildAriaSnapshotScript(undefined))}, ${JSON.stringify(secret)}, ${JSON.stringify(pinnedValue)}, ${JSON.stringify(longerValue)});`,
				}),
			);
			expect(pageWorld.snapshot).not.toContain(secret);
			expect(pageWorld.snapshot).not.toContain("X4");
			for (const [id, value] of [
				["pinned", pinnedValue],
				["longer", longerValue],
				["sealed", `${secret}-sealed`],
			]) {
				expect(pageWorld.snapshot).toMatch(
					new RegExp(`textbox "${id}" \\[ref=e\\d+\\]: "?•{${value.length}}"?$`, "m"),
				);
				expect(pageWorld.snapshot).toContain(`button "${"•".repeat(value.length)}"`);
			}
			expect(pageWorld.snapshot).toContain(`button "${"•".repeat(secret.length + "-adopted".length)}"`);
			expect(pageWorld.crossRealm).toBeTrue();
			expect(pageWorld.kept).toBeTrue();

			const scoped = valueFrom<string>(
				await invoke({
					action: "run",
					name,
					code: 'return await tab.ariaSnapshot("form", { interactive: true });',
				}),
			);
			expect(scoped).not.toContain(secret);

			const diff = await invoke({
				action: "run",
				name,
				code: "return await tab.ariaSnapshot(undefined, { diff: true });",
			});
			expect(JSON.stringify(diff)).not.toContain(secret);
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 60_000);

	test("masks password fields on XHTML pages, whose tag names are lowercase", async () => {
		const invoke = createHost();
		const name = `snapshot-password-xhtml-${crypto.randomUUID()}`;
		const secret = "Fake-Xhtml-Secret-4417";
		const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Sign in</title></head><body><form>
			<label>Password <input id="pw" type="password"/></label>
		</form></body></html>`;
		await invoke({ action: "open", name, url: `data:application/xhtml+xml,${encodeURIComponent(xhtml)}` });
		try {
			await invoke({ action: "run", name, code: `await tab.fill("#pw", ${JSON.stringify(secret)});` });
			const snapshot = valueFrom<string>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot();" }),
			);
			expect(snapshot).not.toContain(secret);
			expect(snapshot).toContain(`textbox "Password" [active] [ref=`);
			expect(snapshot).toContain(`: ${"•".repeat(secret.length)}`);
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 60_000);
});
