import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { prepareElementUpload } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import {
	openUploadSource,
	sweepUploadStaging,
	type UploadRoute,
	UploadStaging,
} from "@oh-my-pi/pi-coding-agent/tools/browser/upload-files";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { ElementHandle, Page } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// File inputs reached by selector, by handle and inside a shadow root; buttons whose click opens a hidden input's
// chooser, one of which turns its input into a text field once the chooser is open; drop zones in the document and in
// the shadow root, and an element that takes no drop though the document cancels drops everywhere.
const html = `<!doctype html>
<style>button, #drop { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<input id="handle" type="file">
<div id="host"></div>
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<button id="other" type="button">Upload another</button><input id="other-input" type="file" hidden>
<button id="swap" type="button">Upload, then swap</button><input id="swap-input" type="file" hidden>
<div id="drop">Drop files here</div>
<div id="inert">Not a drop zone</div>
<input id="folder" type="file" webkitdirectory>
<script>
window.composedInputs = [];
window.dropped = [];
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
shadow.innerHTML = '<input id="shadow" type="file"><div id="shadow-drop">Drop files here</div>';
shadow.getElementById("shadow-drop").addEventListener("drop", event => {
  event.preventDefault();
  window.dropped = [...event.dataTransfer.files];
});
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => event.preventDefault());
document.addEventListener("input", event => composedInputs.push(event.composedPath()[0].id));
for (const id of ["trigger", "other"])
  document.getElementById(id).addEventListener("click", () => document.getElementById(id + "-input").click());
document.getElementById("swap").addEventListener("click", () => {
  const input = document.getElementById("swap-input");
  input.click();
  input.type = "text";
});
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => {
  event.preventDefault();
  window.dropped = [...event.dataTransfer.files];
});
</script>`;

// A page that replaces the globals an upload builds its files with, as polyfills and monitoring scripts do.
const poisonedHtml = `<!doctype html>
<input id="direct" type="file">
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<div id="drop" style="padding: 8px">Drop files here</div>
<script>
window.dropped = [];
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => { event.preventDefault(); window.dropped = [...event.dataTransfer.files]; });
for (const name of ["DataTransfer", "File", "Event", "DragEvent", "atob"])
  window[name] = function () { throw new Error("the page replaced " + name); };
document.getElementById("trigger").addEventListener("click", () => document.getElementById("trigger-input").click());
</script>`;

interface ProxyOptions {
	/** Drop the connection on a websocket message over this size, as the relay does at 256 MiB. */
	maxMessageBytes?: number;
	/** Answer `DOM.setFileInputFiles` with `Not allowed`, as Chrome does for a relay without file-URL access. */
	denyFilePaths?: boolean;
	/**
	 * Hold each message over 1 MiB this long before forwarding it, as a slow link would. A real delay: the deadline under
	 * test runs on the tab worker's own clock, which fake timers here cannot reach.
	 */
	holdLargeMs?: number;
}

interface ProxiedSocket {
	path: string;
	upstream?: WebSocket;
	pending: (string | Buffer)[];
}

interface CdpProxy {
	port: number;
	/** `DOM.setFileInputFiles` requests seen, forwarded or refused. */
	filePathCalls: number;
	stop(): void;
}

const LARGE_MESSAGE_BYTES = 1024 * 1024;

/** Forward CDP to Chrome, applying `options` to what omp sends. */
function startCdpProxy(chromePort: number, options: ProxyOptions): CdpProxy {
	const proxy = { port: 0, filePathCalls: 0, stop: () => {} };
	const server = Bun.serve<ProxiedSocket>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req, server) {
			const { pathname } = new URL(req.url);
			if (server.upgrade(req, { data: { path: pathname, pending: [] } })) return undefined;
			const response = await fetch(`http://127.0.0.1:${chromePort}${pathname}`);
			const body = (await response.text()).replaceAll(`127.0.0.1:${chromePort}`, `127.0.0.1:${server.port}`);
			return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
		},
		websocket: {
			maxPayloadLength: options.maxMessageBytes ?? 512 * 1024 * 1024,
			open(ws) {
				const upstream = new WebSocket(`ws://127.0.0.1:${chromePort}${ws.data.path}`);
				ws.data.upstream = upstream;
				upstream.onopen = () => {
					for (const message of ws.data.pending.splice(0)) upstream.send(message);
				};
				upstream.onmessage = event => ws.send(event.data);
				upstream.onclose = () => ws.close();
			},
			async message(ws, message) {
				const size = typeof message === "string" ? message.length : message.byteLength;
				if (size < LARGE_MESSAGE_BYTES) {
					const text = typeof message === "string" ? message : message.toString();
					if (text.includes('"DOM.setFileInputFiles"')) {
						proxy.filePathCalls++;
						if (options.denyFilePaths) {
							const { id, sessionId } = JSON.parse(text) as { id: number; sessionId?: string };
							ws.send(JSON.stringify({ id, sessionId, error: { code: -32000, message: "Not allowed" } }));
							return;
						}
					}
				} else if (options.holdLargeMs) {
					await Bun.sleep(options.holdLargeMs);
				}
				const { upstream } = ws.data;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
				else ws.data.pending.push(message);
			},
			close(ws) {
				ws.data.upstream?.close();
			},
		},
	});
	proxy.port = server.port ?? 0;
	proxy.stop = () => server.stop(true);
	return proxy;
}

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

/** Proxy settings that put a connected Chrome on `route`: refusing paths, as the default relay does, forces contents. */
function routeProxy(route: UploadRoute, options: ProxyOptions = {}): ProxyOptions {
	return { ...options, denyFilePaths: route === "contents" };
}

/**
 * Launch a Chrome omp did not start, open a fixture page in it over `app.cdp_url` through a CDP proxy, and run cells
 * there.
 */
async function openConnectedTab(toolCallId: string, options: { page?: string; proxy?: ProxyOptions } = {}) {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upload-connected-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-sandbox",
			"--no-first-run",
			"--use-mock-keychain",
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const proxy = startCdpProxy(port, options.proxy ?? {});
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	const context = { session, toolCallId };
	const name = `upload-${crypto.randomUUID()}`;
	const close = async () => {
		await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
		proxy.stop();
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	};
	try {
		await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
		await prelude.invoke(
			{
				action: "open",
				name,
				url: `${url}${options.page ?? ""}`,
				app: { cdp_url: `http://127.0.0.1:${proxy.port}` },
			},
			context,
		);
	} catch (error) {
		await close();
		throw error;
	}
	const run = async (code: string, timeout = 15): Promise<unknown> => {
		const result = await prelude.invoke({ action: "run", name, timeout, code }, context);
		const details = result.details;
		if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
		return details.value;
	};
	return { run, close, proxy };
}

/** Write `size` random bytes to `file` and return their SHA-256. */
async function writeRandomFile(file: string, size: number): Promise<string> {
	const bytes = new Uint8Array(size);
	for (let offset = 0; offset < bytes.length; offset += 65_536)
		crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
	await Bun.write(file, bytes);
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const collectErrors = (uploads: string) => `const errors = [];
for (const upload of [${uploads}]) {
	try { await upload(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return errors;`;

const readDigests = `return await tab.evaluate(() => Promise.all([
	document.querySelector("#direct").files[0],
	document.querySelector("#trigger-input").files[0],
	window.dropped[0],
].map(async file => {
	const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
})));`;

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: req =>
			new Response(new URL(req.url).pathname === "/poisoned" ? poisonedHtml : html, {
				headers: { "content-type": "text/html" },
			}),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	// Connected tabs leave their staging folders for the sweep; this process made them.
	for (const name of await stagingFolders()) {
		if (name.startsWith(`omp-uploads-${process.pid}-`))
			await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
	}
});

/** omp's upload staging folders now in the temp directory. */
async function stagingFolders(): Promise<Set<string>> {
	return new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("omp-uploads-")));
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile into a browser omp did not launch", () => {
	describe.each(["paths", "contents"] as const)("on the %s route", route => {
		test("hands over each file as the user's own pick would, readable after the original is gone", async () => {
			const before = await stagingFolders();
			const { run, close, proxy } = await openConnectedTab(`browser-upload-${route}`, {
				proxy: routeProxy(route),
			});
			let created: string[] = [];
			try {
				const gone = path.join(tempDir, `gone-${route}.txt`);
				await Bun.write(gone, "gone soon");
				const modified = new Date("2020-01-02T03:04:05Z");
				await fs.utimes(gone, modified, modified);
				const file = JSON.stringify(path.basename(gone));
				const errors = await run(
					collectErrors(`() => tab.uploadFile("#direct", ${file}),
	() => tab.uploadFile("#trigger", ${file}),
	async () => (await tab.waitFor("#handle")).uploadFile(${file}),
	() => tab.uploadFile("pierce/#shadow", ${file}),
	() => tab.uploadFile("#drop", ${file}),`),
				);
				expect(errors).toEqual([]);
				// Chrome reads a picked file lazily: the staged copy, or the contents, outlive the original.
				await fs.rm(gone);
				const received = await run(`return await tab.evaluate(async () => {
	const files = [
		document.querySelector("#direct").files[0],
		document.querySelector("#trigger-input").files[0],
		document.querySelector("#handle").files[0],
		document.querySelector("#host").shadowRoot.querySelector("#shadow").files[0],
		window.dropped[0],
	];
	return {
		files: await Promise.all(files.map(file => file.text().then(text => [file.name, text, file.type, file.lastModified], error => [error.name]))),
		composedInputs: window.composedInputs,
	};
});`);
				const expected = [path.basename(gone), "gone soon", "text/plain", modified.getTime()];
				expect(received).toEqual({
					files: [expected, expected, expected, expected, expected],
					composedInputs: ["direct", "trigger-input", "handle", "shadow"],
				});
				// The route check, then one call per path upload, versus only the refused route check.
				expect(proxy.filePathCalls).toBe(route === "paths" ? 6 : 1);
				created = [...(await stagingFolders())].filter(
					name => !before.has(name) && name.startsWith(`omp-uploads-${process.pid}-`),
				);
				// One folder for the tab's copies; the contents route copies nothing, so it makes none.
				expect(created).toHaveLength(route === "paths" ? 1 : 0);
			} finally {
				await close();
			}
			// A page omp only attached to can outlive omp's tab, so its staged copies stay for the sweep.
			const left = await stagingFolders();
			expect(created.filter(name => left.has(name))).toEqual(created);
		}, 60_000);

		test("fails a chooser upload whose input went away or another upload holds", async () => {
			const { run, close } = await openConnectedTab(`browser-upload-refused-${route}`, {
				proxy: routeProxy(route),
			});
			try {
				await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
				await Bun.write(path.join(tempDir, "beta.txt"), "beta");
				// The page swaps its input out from under the chooser. Two overlapping uploads would both take the first
				// chooser, so whichever reaches it second is refused and only the winner's input gets a file.
				const result =
					await run(`const message = outcome => outcome.status === "rejected" ? outcome.reason.message : "ok";
const swapped = await Promise.allSettled([tab.uploadFile("#swap", "alpha.txt")]);
const uploads = [["#trigger", "alpha.txt"], ["#other", "beta.txt"]];
const outcomes = await Promise.allSettled(uploads.map(([selector, file]) => tab.uploadFile(selector, file)));
const names = await tab.evaluate(() => ["#trigger-input", "#other-input"].map(id => [...document.querySelector(id).files].map(file => file.name)));
return {
	swapped: swapped.map(message),
	overlapping: outcomes.map((outcome, i) => ({ result: message(outcome), file: uploads[i][1], names: names[i] })),
};`);
				// `run` details carry the cell's return value untyped.
				const { swapped, overlapping } = result as {
					swapped: string[];
					overlapping: { result: string; file: string; names: string[] }[];
				};
				expect(swapped[0]).toContain("Node is not a file input element");
				const winner = overlapping.find(upload => upload.result === "ok");
				const loser = overlapping.find(upload => upload.result !== "ok");
				expect(winner?.names).toEqual(winner ? [winner.file] : ["no upload succeeded"]);
				expect(loser?.result).toContain("waits for its file chooser");
				expect(loser?.names).toEqual([]);
			} finally {
				await close();
			}
		}, 60_000);

		test("builds the files out of the page's reach, untyped when the extension names no type", async () => {
			const { run, close } = await openConnectedTab(`browser-upload-poisoned-${route}`, {
				page: "poisoned",
				proxy: routeProxy(route),
			});
			try {
				await Bun.write(path.join(tempDir, "notes"), "no extension");
				const errors = await run(
					collectErrors(`() => tab.uploadFile("#direct", "notes"),
	() => tab.uploadFile("#trigger", "notes"),
	() => tab.uploadFile("#drop", "notes"),`),
				);
				expect(errors).toEqual([]);
				const received = await run(`return await tab.evaluate(() => Promise.all([
	document.querySelector("#direct").files[0],
	document.querySelector("#trigger-input").files[0],
	window.dropped[0],
].map(async file => [await file.text(), file.type])));`);
				// A browser's own pick of a file whose extension names no MIME type reports an empty type.
				const file = ["no extension", ""];
				expect(received).toEqual([file, file, file]);
			} finally {
				await close();
			}
		}, 60_000);

		test("fails a drop that nothing on the page reads", async () => {
			const { run, close } = await openConnectedTab(`browser-upload-inert-${route}`, {
				proxy: routeProxy(route),
			});
			try {
				await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
				const result = await run(`const errors = [];
for (const selector of ["#inert", "pierce/#shadow-drop"]) {
	try { await tab.uploadFile(selector, "alpha.txt"); errors.push(null); }
	catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return { errors, dropped: await tab.evaluate(() => window.dropped.map(file => file.name)) };`);
				// The document cancels the inert element's drop but never reads its files; the shadow root's zone does.
				expect(result).toEqual({
					errors: [expect.stringContaining("nothing on the page took the dropped files"), null],
					dropped: ["alpha.txt"],
				});
			} finally {
				await close();
			}
		}, 60_000);
	});

	test("stages a folder whole for a directory input", async () => {
		const { run, close } = await openConnectedTab("browser-upload-folder", { proxy: routeProxy("paths") });
		try {
			const folder = path.join(tempDir, "album");
			await fs.mkdir(path.join(folder, "nested"), { recursive: true });
			await Bun.write(path.join(folder, "one.txt"), "one");
			await Bun.write(path.join(folder, "nested", "two.txt"), "two");
			expect(await run(collectErrors(`() => tab.uploadFile("#folder", "album"),`))).toEqual([]);
			const received = await run(`return await tab.evaluate(() => Promise.all(
	[...document.querySelector("#folder").files].map(async file => [file.webkitRelativePath, await file.text()]),
).then(files => files.sort()));`);
			// Chrome expands a folder path into its files, as it does for a user's pick of that folder.
			expect(received).toEqual([
				["album/nested/two.txt", "two"],
				["album/one.txt", "one"],
			]);
		} finally {
			await close();
		}
	}, 60_000);

	test("refuses a folder by name where the browser takes only contents", async () => {
		const { run, close } = await openConnectedTab("browser-upload-folder-contents", {
			proxy: routeProxy("contents"),
		});
		try {
			await fs.mkdir(path.join(tempDir, "refused-album"), { recursive: true });
			await Bun.write(path.join(tempDir, "refused-album", "one.txt"), "one");
			const errors = await run(collectErrors(`() => tab.uploadFile("#folder", "refused-album"),`));
			expect(errors).toEqual([expect.stringContaining("refused-album is a folder")]);
		} finally {
			await close();
		}
	}, 60_000);

	test("streams contents in messages under the link's cap", async () => {
		const maxMessageBytes = 16 * 1024 * 1024;
		const { run, close } = await openConnectedTab("browser-upload-capped", {
			proxy: routeProxy("contents", { maxMessageBytes }),
		});
		try {
			// Base64 in a single message would come to 4/3 of the file, over the cap.
			const digest = await writeRandomFile(path.join(tempDir, "large.bin"), maxMessageBytes);
			// Three 16 MiB uploads: the budget covers slow hosts, since this checks chunking, not throughput.
			const errors = await run(
				collectErrors(`() => tab.uploadFile("#direct", "large.bin"),
	() => tab.uploadFile("#trigger", "large.bin"),
	() => tab.uploadFile("#drop", "large.bin"),`),
				60,
			);
			expect(errors).toEqual([]);
			expect(await run(readDigests)).toEqual([digest, digest, digest]);
		} finally {
			await close();
		}
	}, 120_000);

	test("gives streaming contents the cell's budget, not the action deadline", async () => {
		// Each chunk takes longer than the 8 s action deadline to arrive; finding the target does not.
		const { run, close } = await openConnectedTab("browser-upload-slow", {
			proxy: routeProxy("contents", { holdLargeMs: 9_000 }),
		});
		try {
			const digest = await writeRandomFile(path.join(tempDir, "slow.bin"), 2 * 1024 * 1024);
			const outcome = await run(
				`const started = Date.now();
${collectErrors(`() => tab.uploadFile("#direct", "slow.bin"),`).replace("return errors;", "return { errors, ms: Date.now() - started };")}`,
				30,
			);
			const { errors, ms } = outcome as { errors: string[]; ms: number };
			expect(errors).toEqual([]);
			expect(ms).toBeGreaterThan(8_000);
			const received = await run(
				`return await tab.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await document.querySelector("#direct").files[0].arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join(""));`,
			);
			expect(received).toBe(digest);
		} finally {
			await close();
		}
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile into a browser omp launched", () => {
	test("keeps a tab's staged copies when it moves to a new worker, and removes them with the page", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-upload-managed" };
		const name = `upload-managed-${crypto.randomUUID()}`;
		const run = (code: string) => prelude.invoke({ action: "run", name, timeout: 15, code }, context);
		const valueOf = (result: { details?: unknown }) =>
			result.details && typeof result.details === "object" && "value" in result.details
				? result.details.value
				: undefined;
		const before = await stagingFolders();
		await prelude.invoke({ action: "open", name, url }, context);
		try {
			const file = path.join(tempDir, "recycled.txt");
			await Bun.write(file, "outlives its worker");
			expect(valueOf(await run(collectErrors(`() => tab.uploadFile("#direct", "recycled.txt"),`)))).toEqual([]);
			await fs.rm(file);
			// Request interception that cannot be reset after the run moves the tab to a new worker.
			const recycled = await run(`await page.setRequestInterception(true);
const client = page._client();
const send = client.send.bind(client);
client.send = (method, ...args) => (method === "Fetch.disable" ? Promise.withResolvers().promise : send(method, ...args));
return "done";`);
			expect(JSON.stringify(recycled.content)).toContain("reattached to a new worker");
			const read = await run(`return await tab.evaluate(() => document.querySelector("#direct").files[0].text());`);
			expect(valueOf(read)).toBe("outlives its worker");
		} finally {
			await prelude.invoke({ action: "close", name }, context);
		}
		// omp closed the page it launched, the last reader of the copies.
		expect([...(await stagingFolders())].filter(folder => !before.has(folder))).toEqual([]);
	}, 60_000);
});

test("sweeps a staging folder a day after its last upload unless an open tab or a running omp owns it", async () => {
	const now = Date.now();
	const dayAgo = new Date(now - 25 * 60 * 60 * 1000);
	// No process has a pid this large; the parent of this test process is running.
	const folders = {
		open: [`omp-uploads-${process.pid}-sweep-open`, dayAgo],
		recent: [`omp-uploads-${process.pid}-sweep-recent`, new Date(now)],
		closed: [`omp-uploads-${process.pid}-sweep-closed`, dayAgo],
		orphaned: [`omp-uploads-99999999-sweep-orphaned`, dayAgo],
		otherOmp: [`omp-uploads-${process.ppid}-sweep-other`, dayAgo],
	} as const;
	for (const [name, modified] of Object.values(folders)) {
		const folder = path.join(os.tmpdir(), name);
		await fs.mkdir(folder, { recursive: true });
		await fs.utimes(folder, modified, modified);
	}
	try {
		await sweepUploadStaging(new Set([path.join(os.tmpdir(), folders.open[0])]), now);
		const left = await stagingFolders();
		expect(Object.values(folders).map(([name]) => left.has(name))).toEqual([true, true, false, false, true]);
	} finally {
		for (const [name] of Object.values(folders))
			await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
	}
});

test("reports the type a browser's own pick would for the contents route", async () => {
	const files = { "a.txt": "text/plain", "a.bin": "application/octet-stream", "a.unknownext": "", notes: "" };
	for (const name of Object.keys(files)) await Bun.write(path.join(tempDir, name), "x");
	const types = await Promise.all(
		Object.keys(files).map(async name => (await openUploadSource(path.join(tempDir, name))).info.type),
	);
	expect(types).toEqual(Object.values(files));
});

test("detaches a chooser session that attaches after the upload was cancelled", async () => {
	const { promise: attached, resolve: attach } = Promise.withResolvers<{ detach: () => Promise<void> }>();
	let detached = false;
	const controller = new AbortController();
	// Only what the chooser route touches before its session exists: the target's tag and session creation,
	// which the cancel interrupts.
	const page = {
		createCDPSession: () => {
			controller.abort();
			return attached;
		},
	} as unknown as Page;
	const handle = { evaluate: async () => ({ tag: "BUTTON", type: "" }) } as unknown as ElementHandle;
	const file = path.join(tempDir, "late.txt");
	await Bun.write(file, "late");
	const staging = new UploadStaging(path.join(tempDir, "late-staging"));
	await rejectionOf(prepareElementUpload(page, handle, [file], "upload", "contents", staging, controller.signal));
	attach({
		detach: async () => {
			detached = true;
		},
	});
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
	expect(detached).toBe(true);
});

/** A page whose route check reads its token through `read`, counting the checks. */
function routeCheckPage(read: (tokenPath: string) => Promise<string>): { page: Page; checks: () => number } {
	let checks = 0;
	let tokenPath = "";
	const input = {
		frame: {
			client: {
				send: async (_method: string, params: { files: string[] }) => {
					tokenPath = params.files[0] ?? "";
				},
			},
		},
		remoteObject: () => ({ objectId: "picker" }),
	};
	const picker = { asElement: () => input, evaluate: () => read(tokenPath), dispose: async () => {} };
	const realm = {
		evaluateHandle: async () => {
			checks++;
			return picker;
		},
	};
	const page = { mainFrame: () => ({ isolatedRealm: () => realm }) } as unknown as Page;
	return { page, checks: () => checks };
}

test("checks the upload route again after a check that decided nothing, and keeps a decided one", async () => {
	let attempt = 0;
	const { page, checks } = routeCheckPage(async tokenPath => {
		attempt++;
		// The first check's page navigates away mid-read; the next reads the token.
		if (attempt === 1) throw new Error("Execution context was destroyed");
		return await Bun.file(tokenPath).text();
	});
	const staging = new UploadStaging(path.join(tempDir, "route-staging"));
	expect(await staging.route(page)).toBe("contents");
	expect(await staging.route(page)).toBe("paths");
	expect(await staging.route(page)).toBe("paths");
	expect(checks()).toBe(2);
});

test("stages a symlinked file's contents, once while the file is unchanged", async () => {
	const target = path.join(tempDir, "link-target.txt");
	await Bun.write(target, "linked");
	const link = path.join(tempDir, "link.txt");
	await fs.symlink(target, link, "file");
	const staging = new UploadStaging(path.join(tempDir, "symlink-staging"));
	const [first] = await staging.stage([await openUploadSource(link)]);
	const [again] = await staging.stage([await openUploadSource(link)]);
	expect(again).toBe(first);
	// A copy that still pointed at the original would send the browser to it, and break once it is gone.
	expect((await fs.lstat(first!)).isSymbolicLink()).toBe(false);
	await fs.rm(target);
	expect(await Bun.file(first!).text()).toBe("linked");
	await Bun.write(target, "changed");
	await fs.utimes(target, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
	const [changed] = await staging.stage([await openUploadSource(link)]);
	expect(changed).not.toBe(first);
	expect(await Bun.file(changed!).text()).toBe("changed");
});

test("stages a file again when it changes without moving its size or mtime", async () => {
	const file = path.join(tempDir, "same-stamp.txt");
	const stamp = new Date(1_900_000_000_000);
	await Bun.write(file, "before");
	await fs.utimes(file, stamp, stamp);
	const staging = new UploadStaging(path.join(tempDir, "same-stamp-staging"));
	await staging.stage([await openUploadSource(file)]);
	// ctime cannot be set and Linux stamps it from a coarse clock; a real tick apart keeps the rewrite distinguishable.
	await Bun.sleep(20);
	await Bun.write(file, "after!");
	await fs.utimes(file, stamp, stamp);
	const [second] = await staging.stage([await openUploadSource(file)]);
	expect(await Bun.file(second!).text()).toBe("after!");
});

test("marks the staging folder used when an upload reuses a copy, so the sweep keeps it", async () => {
	const file = path.join(tempDir, "reused.txt");
	await Bun.write(file, "reused");
	const directory = path.join(os.tmpdir(), `omp-uploads-${process.pid}-reuse-${crypto.randomUUID().slice(0, 8)}`);
	const staging = new UploadStaging(directory);
	try {
		await staging.stage([await openUploadSource(file)]);
		const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await fs.utimes(directory, dayAgo, dayAgo);
		await staging.stage([await openUploadSource(file)]);
		// The tab was released after that upload; its page may still read the copy.
		await sweepUploadStaging(new Set());
		expect((await stagingFolders()).has(path.basename(directory))).toBe(true);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("stages a folder holding a link back to itself, leaving the loop out", async () => {
	const album = path.join(tempDir, "looped-album");
	await Bun.write(path.join(album, "nested", "one.txt"), "one");
	await fs.symlink(album, path.join(album, "nested", "loop"), "junction");
	const staging = new UploadStaging(path.join(tempDir, "loop-staging"));
	const [copy] = await staging.stage([await openUploadSource(album)]);
	expect(await Bun.file(path.join(copy!, "nested", "one.txt")).text()).toBe("one");
	expect(await fs.readdir(path.join(copy!, "nested"))).toEqual(["one.txt"]);
});
