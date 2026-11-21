/**
 * omp's WebKit browser and a held `confirm()`: the click that opens it returns,
 * page calls fail at once naming it until `tab.handleDialog()` answers it, and
 * cookies stay readable. Runs on the installed engine (or
 * `PI_BROWSER_WEBKIT_PATH`'s).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { resolveWebKitKind } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/kind";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const ENGINE_INSTALLED = resolveWebKitKind() !== null;

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () =>
		new Response("<!doctype html><title>confirm</title><p>body text</p>", {
			headers: { "content-type": "text/html" },
		}),
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	server.stop(true);
});

describe.skipIf(!ENGINE_INSTALLED)("omp's WebKit browser and a held confirm", () => {
	test("returns from a click that opens a confirm, and fails page calls at once until it is answered", async () => {
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.webkit": true,
				"browser.relay": false,
				"browser.cmux": false,
				"browser.tern": false,
				"tools.maxTimeout": 0,
			}),
		};
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-webkit-dialogs" });

		await invoke({ action: "open", name: "webkit-confirm", app: "webkit", url: `http://127.0.0.1:${server.port}/` });
		const result = await invoke({
			action: "run",
			name: "webkit-confirm",
			timeout: 60,
			code: `await tab.evaluate(() => {
	const button = document.body.appendChild(document.createElement("button"));
	button.id = "leave";
	button.textContent = "Sign Out";
	button.onclick = () => { globalThis.confirmResult = confirm("Leave?"); };
});
await tab.click("#leave");
const started = Date.now();
const blocked = await tab.text("body").then(() => "read", error => String(error));
const blockedMs = Date.now() - started;
const cookies = await tab.cookies().then(list => Array.isArray(list), error => String(error));
// A page call already running when a dialog opens fails as well.
await tab.handleDialog({ accept: true });
const midCall = await tab.evaluate(() => confirm("Again?")).then(() => "returned", error => String(error));
await tab.handleDialog({ accept: false });
return { blocked, fast: blockedMs < 2000, cookies, midCall, answered: await tab.evaluate(() => globalThis.confirmResult) };`,
		});

		const value = (result.details as { value?: unknown } | undefined)?.value as {
			blocked: string;
			fast: boolean;
			cookies: unknown;
			midCall: string;
			answered: unknown;
		};
		// The read names the dialog that stops the page instead of running out its own deadline.
		expect(value.blocked).toContain("Leave?");
		expect(value.midCall).toContain("Again?");
		expect(value).toMatchObject({ fast: true, cookies: true, answered: true });
	}, 60_000);
});
