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

// Every way a page asks for a file; `#log` records the name and contents each control received.
const html = `<!doctype html>
<style>button, label, div { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<label id="styled" for="hidden-input">Choose file</label><input id="hidden-input" type="file" style="display:none">
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<div id="drop">Drop files here</div>
<script>
window.log = [];
const record = async (id, files) =>
  log.push({ id, files: await Promise.all([...files].map(async file => file.name + ":" + (await file.text()))) });
for (const id of ["direct", "hidden-input", "trigger-input"]) {
  const input = document.getElementById(id);
  input.addEventListener("change", () => record(id, input.files));
}
document.getElementById("trigger").addEventListener("click", () => document.getElementById("trigger-input").click());
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => { event.preventDefault(); record("drop", event.dataTransfer.files); });
</script>`;

let tempDir = "";
let site: Bun.Server<undefined> | undefined;
let url = "";

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
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
	await Bun.write(path.join(tempDir, "beta.txt"), "beta");
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile", () => {
	test("element handles fill inputs, chooser triggers and drop zones from session-relative paths", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-upload-element" };
		const name = `upload-${crypto.randomUUID()}`;
		await prelude.invoke({ action: "open", name, url }, context);
		try {
			// Relative paths name files in the session directory, which is not the process cwd. No paths clears the
			// input. The change listeners read contents asynchronously, so the cell waits for all five entries.
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					timeout: 15,
					code: `const errors = [];
for (const [selector, files] of [["#direct", ["alpha.txt"]], ["#styled", ["alpha.txt"]], ["#trigger", ["beta.txt"]], ["#drop", ["alpha.txt", "beta.txt"]]]) {
	try { await (await tab.waitFor(selector)).uploadFile(...files); }
	catch (error) { errors.push(selector + ": " + (error instanceof Error ? error.message : String(error))); }
}
await tab.page.waitForFunction(() => window.log.length >= 4, { timeout: 5000 }).catch(() => undefined);
await (await tab.waitFor("#direct")).uploadFile();
await tab.page.waitForFunction(() => window.log.length >= 5, { timeout: 5000 }).catch(() => undefined);
return { errors, log: await tab.evaluate(() => window.log) };`,
				},
				context,
			);
			const details = result.details;
			if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
			expect(details.value).toEqual({
				errors: [],
				log: [
					{ id: "direct", files: ["alpha.txt:alpha"] },
					{ id: "hidden-input", files: ["alpha.txt:alpha"] },
					{ id: "trigger-input", files: ["beta.txt:beta"] },
					{ id: "drop", files: ["alpha.txt:alpha", "beta.txt:beta"] },
					{ id: "direct", files: [] },
				],
			});
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
		}
	}, 60_000);
});
