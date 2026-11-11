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
// Windows ignores POSIX read bits and root reads a mode-000 file, so neither can make delivery fail through one.
const MODE_BITS_ENFORCED = process.platform !== "win32" && process.getuid?.() !== 0;

// `#log` records what each control received; headless Chrome cancels a chooser nobody intercepts, so a `cancel`
// entry proves a click reached a real, uninterrupted chooser.
const html = `<!doctype html>
<style>button, div { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<button id="other" type="button">Upload another</button><input id="other-input" type="file" hidden>
<button id="picker" type="button">Open</button>
<div id="drop">Drop files here</div>
<script>
window.log = [];
const record = (id, event, files) => log.push({ id, event, names: [...(files || [])].map(file => file.name) });
for (const id of ["direct", "trigger-input", "other-input"]) {
  const input = document.getElementById(id);
  input.addEventListener("change", () => record(id, "change", input.files));
  input.addEventListener("cancel", () => record(id, "cancel"));
}
for (const id of ["trigger", "other"])
  document.getElementById(id).addEventListener("click", () => document.getElementById(id + "-input").click());
document.getElementById("picker").addEventListener("click", () =>
  showOpenFilePicker().then(() => record("picker", "picked"), error => record("picker", error.name)));
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => { event.preventDefault(); record("drop", "drop", event.dataTransfer.files); });
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

interface LogEntry {
	id: string;
	event: string;
	names: string[];
}

/** Open a tab on the fixture; `attempt` reloads it, runs `code`, and returns the thrown message and the page log. */
async function openFixture() {
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	const context = { session, toolCallId: "browser-upload" };
	const name = `upload-${crypto.randomUUID()}`;
	await prelude.invoke({ action: "open", name, url }, context);
	const attempt = async (code: string): Promise<{ error?: string; log: LogEntry[] }> => {
		// Cells share top-level bindings, so `error` is reset explicitly. The 300 ms pause is real time: the
		// browser fires change/cancel after the CDP call returns and signals no end.
		const result = await prelude.invoke(
			{
				action: "run",
				name,
				timeout: 15,
				code: `await tab.goto(${JSON.stringify(url)});
let error = undefined;
try { ${code} } catch (e) { error = e instanceof Error ? e.message : String(e); }
await Bun.sleep(300);
return { error, log: await tab.evaluate(() => window.log) };`,
			},
			context,
		);
		const details = result.details;
		if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
		// `run` details carry the cell's return value untyped.
		return details.value as { error?: string; log: LogEntry[] };
	};
	const close = () => prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
	return { attempt, close };
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
	await Bun.write(path.join(tempDir, "beta.txt"), "beta");
	// Readable enough to open for an upload (a stat), not to copy or read: delivery fails after the chooser is caught.
	await Bun.write(path.join(tempDir, "locked.txt"), "locked");
	await fs.chmod(path.join(tempDir, "locked.txt"), 0o000);
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
	test("fills the chooser a trigger opens", async () => {
		const { attempt, close } = await openFixture();
		try {
			expect(await attempt(`await tab.uploadFile("#trigger", "alpha.txt");`)).toEqual({
				log: [{ id: "trigger-input", event: "change", names: ["alpha.txt"] }],
			});
			// A refused upload leaves the chooser unfilled; the page hears it close as a user's cancel would.
			const multiple = await attempt(`await tab.uploadFile("#trigger", "alpha.txt", "beta.txt");`);
			expect(multiple.error).toContain("Multiple file uploads only work with <input type=file multiple>");
			expect(multiple.log).toEqual([{ id: "trigger-input", event: "cancel", names: [] }]);
		} finally {
			await close();
		}
	}, 60_000);

	test.skipIf(!MODE_BITS_ENFORCED)(
		"cancels the chooser when delivering the files fails",
		async () => {
			const { attempt, close } = await openFixture();
			try {
				const failed = await attempt(`await tab.uploadFile("#trigger", "locked.txt");`);
				expect(failed.error).toBeDefined();
				expect(failed.log).toEqual([{ id: "trigger-input", event: "cancel", names: [] }]);
			} finally {
				await close();
			}
		},
		60_000,
	);

	test("rejects a File System Access picker without killing the tab", async () => {
		const { attempt, close } = await openFixture();
		try {
			// Puppeteer's chooser listener threw on the picker's node-less event, killing the tab worker;
			// the cell then hung until the supervisor killed the tab. The later trigger click proves the error
			// path also switched interception off: a `cancel` means its chooser reached the browser.
			const picker = await attempt(
				`try { await tab.uploadFile("#picker", "alpha.txt"); } finally { await tab.click("#trigger"); }`,
			);
			expect(picker.error).toContain("File System Access picker");
			expect(picker.log).toContainEqual({ id: "trigger-input", event: "cancel", names: [] });
		} finally {
			await close();
		}
	}, 60_000);

	test("leaves later file choosers to the page", async () => {
		const { attempt, close } = await openFixture();
		try {
			// Puppeteer's waitForFileChooser left interception on, so a later chooser opened nothing at all.
			const result = await attempt(`await tab.uploadFile("#drop", "alpha.txt");
await tab.click("#trigger");`);
			expect(result.log).toEqual([
				{ id: "drop", event: "drop", names: ["alpha.txt"] },
				{ id: "trigger-input", event: "cancel", names: [] },
			]);
		} finally {
			await close();
		}
	}, 60_000);
});
