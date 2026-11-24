import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, gracefulKillTreeOnce, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { prepareElementUpload } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import { ensureChromiumExecutable, RENDERER_PRIORITY_ARGS } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import {
	filesAreOpenable,
	inputListsNames,
	openUploadSource,
	readsOwnPaths,
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
window.fileEvents = [];
for (const id of ["direct", "trigger-input"]) {
  const input = document.getElementById(id);
  for (const type of ["input", "change", "cancel"]) input.addEventListener(type, () => fileEvents.push(id + ":" + type));
}
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
	/** Hand the browser a missing path of the same name for these files, as a browser that cannot see their folder would. */
	hideFiles?: string[];
}

interface ProxiedSocket {
	path: string;
	upstream?: WebSocket;
	pending: (string | Buffer)[];
}

interface CdpProxy {
	port: number;
	/** The `files` of every `DOM.setFileInputFiles` request seen, forwarded, rewritten or refused. */
	filePaths: string[][];
	stop(): void;
}

const LARGE_MESSAGE_BYTES = 1024 * 1024;

/** Forward CDP to Chrome, applying `options` to what omp sends. */
function startCdpProxy(chromePort: number, options: ProxyOptions): CdpProxy {
	const proxy: CdpProxy = { port: 0, filePaths: [], stop: () => {} };
	/** A path Chrome cannot resolve that keeps `file`'s name: it lists that as an empty file, whatever the file is. */
	const missingTwin = (file: string): string =>
		path.join(os.tmpdir(), `omp-missing-${crypto.randomUUID()}`, path.basename(file));
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
				let outgoing = message;
				if (size < LARGE_MESSAGE_BYTES) {
					const text = typeof message === "string" ? message : message.toString();
					if (text.includes('"DOM.setFileInputFiles"')) {
						const request = JSON.parse(text) as {
							id: number;
							sessionId?: string;
							params?: { files?: string[] };
						};
						const files = request.params?.files ?? [];
						proxy.filePaths.push(files);
						if (options.denyFilePaths) {
							ws.send(
								JSON.stringify({
									id: request.id,
									sessionId: request.sessionId,
									error: { code: -32000, message: "Not allowed" },
								}),
							);
							return;
						}
						const hide = options.hideFiles;
						if (hide && files.some(file => hide.includes(file))) {
							request.params = {
								...request.params,
								files: files.map(file => (hide.includes(file) ? missingTwin(file) : file)),
							};
							outgoing = JSON.stringify(request);
						}
					}
				}
				const { upstream } = ws.data;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(outgoing);
				else ws.data.pending.push(outgoing);
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

/** Proxy settings that put a connected Chrome on `route`: refusing paths, as the default relay does, forces contents. */
function routeProxy(route: UploadRoute, options: ProxyOptions = {}): ProxyOptions {
	return { ...options, denyFilePaths: route === "contents" };
}

/**
 * Launch a Chrome omp did not start, open a fixture page in it over an `app` CDP URL through a CDP proxy, and run cells
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
			...RENDERER_PRIORITY_ARGS,
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
		await gracefulKillTreeOnce(child.pid);
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
				app: `http://127.0.0.1:${proxy.port}`,
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

/** Staging folders omp made since `before`. */
async function stagingFoldersSince(before: Set<string>): Promise<string[]> {
	return [...(await stagingFolders())].filter(
		name => !before.has(name) && name.startsWith(`omp-uploads-${process.pid}-`),
	);
}

/** On the paths route a browser reads staged copies on macOS, the files' own paths elsewhere. */
const STAGED_COPIES = process.platform === "darwin";

/** The text of the file each target received: the input, the chooser's input and the drop zone's. */
const readTexts = `return await tab.evaluate(() => Promise.all([
	document.querySelector("#direct").files[0],
	document.querySelector("#trigger-input").files[0],
	window.dropped[0],
].map(file => file.text())));`;

/** What each of the five targets holds: name, text, type and mtime, or the read's error; with the inputs that fired. */
const readHanded = `return await tab.evaluate(async () => {
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
});`;

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile into a browser omp did not launch", () => {
	describe.each(["paths", "contents"] as const)("on the %s route", route => {
		test("hands over each file as the user's own pick would; a copy or the contents outlive the original", async () => {
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
				const expected = [path.basename(gone), "gone soon", "text/plain", modified.getTime()];
				const handed = {
					files: [expected, expected, expected, expected, expected],
					composedInputs: ["direct", "trigger-input", "handle", "shadow"],
				};
				// Chrome reads a picked file lazily: the staged copy, or the contents, outlive the original. Away from
				// macOS the paths route reads the originals, so once this one is gone, never read, the page cannot read it.
				const copies = route === "paths" && STAGED_COPIES;
				await fs.rm(gone);
				const missing = {
					files: Array.from({ length: 5 }, () => ["NotFoundError"]),
					composedInputs: handed.composedInputs,
				};
				expect(await run(readHanded)).toEqual(route === "contents" || copies ? handed : missing);
				// The contents route sees only its refused route check; away from macOS every path handed over after the
				// route check is the file's own.
				if (route === "contents") expect(proxy.filePaths).toHaveLength(1);
				if (route === "paths" && !copies) {
					const handedOver = proxy.filePaths.slice(1);
					expect(handedOver.length).toBeGreaterThan(0);
					expect(handedOver.every(files => files.length === 1 && files[0] === gone)).toBe(true);
				}
				// One folder for the tab's copies; the contents route copies nothing, nor does a browser reading the originals.
				created = await stagingFoldersSince(before);
				expect(created).toHaveLength(copies ? 1 : 0);
			} finally {
				await close();
			}
			// omp opened its own page in that browser and closed it with the tab, so its staged copies went too.
			const left = await stagingFolders();
			expect(created.filter(name => left.has(name))).toEqual([]);
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
		const before = await stagingFolders();
		const { run, close } = await openConnectedTab("browser-upload-folder", { proxy: routeProxy("paths") });
		let created: string[] = [];
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
			// A folder is copied on every platform, whatever the platform lets a browser read of a file's own path.
			created = await stagingFoldersSince(before);
			expect(created).toHaveLength(1);
		} finally {
			await close();
		}
		expect([...(await stagingFolders())].filter(name => created.includes(name))).toEqual([]);
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
		// Just over one base64-encoded 8 MiB chunk, so a whole file in one message would not fit.
		const maxMessageBytes = 11 * 1024 * 1024;
		const { run, close } = await openConnectedTab("browser-upload-capped", {
			proxy: routeProxy("contents", { maxMessageBytes }),
		});
		try {
			// Base64 in a single message would come to 4/3 of the file, over the cap.
			const digest = await writeRandomFile(path.join(tempDir, "large.bin"), maxMessageBytes);
			// Three 11 MiB uploads: the budget covers slow hosts, since this checks chunking, not throughput.
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
			// A folder is staged on every platform; away from macOS a file goes over by its own path.
			const album = path.join(tempDir, "survivor-album");
			await Bun.write(path.join(album, "recycled.txt"), "outlives its worker");
			expect(valueOf(await run(collectErrors(`() => tab.uploadFile("#folder", "survivor-album"),`)))).toEqual([]);
			await fs.rm(album, { recursive: true });
			// Request interception that cannot be reset after the run moves the tab to a new worker.
			const recycled = await run(`await page.setRequestInterception(true);
const client = page._client();
const send = client.send.bind(client);
client.send = (method, ...args) => (method === "Fetch.disable" ? Promise.withResolvers().promise : send(method, ...args));
return "done";`);
			expect(JSON.stringify(recycled.content)).toContain("reattached to a new worker");
			const read = await run(`return await tab.evaluate(() => Promise.all(
[...document.querySelector("#folder").files].map(async file => [file.webkitRelativePath, await file.text()])));`);
			expect(valueOf(read)).toEqual([["survivor-album/recycled.txt", "outlives its worker"]]);
		} finally {
			await prelude.invoke({ action: "close", name }, context);
		}
		// omp closed the page it launched, the last reader of the copies.
		expect([...(await stagingFolders())].filter(folder => !before.has(folder))).toEqual([]);
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE || process.platform === "darwin")(
	"browser uploadFile by the files' own paths",
	() => {
		test("gives the browser each file's own path, read as the user's own pick would be, and stages nothing", async () => {
			const before = await stagingFolders();
			const { run, close, proxy } = await openConnectedTab("browser-upload-own-paths", {
				proxy: routeProxy("paths"),
			});
			try {
				const own = path.join(tempDir, "own.txt");
				await Bun.write(own, "by its own path");
				const modified = new Date("2020-01-02T03:04:05Z");
				await fs.utimes(own, modified, modified);
				const errors = await run(
					collectErrors(`() => tab.uploadFile("#direct", "own.txt"),
() => tab.uploadFile("#trigger", "own.txt"),
async () => (await tab.waitFor("#handle")).uploadFile("own.txt"),
() => tab.uploadFile("pierce/#shadow", "own.txt"),
() => tab.uploadFile("#drop", "own.txt"),`),
				);
				expect(errors).toEqual([]);
				const expected = ["own.txt", "by its own path", "text/plain", modified.getTime()];
				expect(await run(readHanded)).toEqual({
					files: [expected, expected, expected, expected, expected],
					composedInputs: ["direct", "trigger-input", "handle", "shadow"],
				});
				// After the route check's token, every path handed over is the file's own.
				const handedOver = proxy.filePaths.slice(1);
				expect(handedOver.length).toBeGreaterThan(0);
				expect(handedOver.every(files => files.length === 1 && files[0] === own)).toBe(true);
				// Nothing was copied.
				expect(await stagingFoldersSince(before)).toEqual([]);
			} finally {
				await close();
			}
		}, 60_000);

		test("stages a copy for a file the browser cannot see, which outlives the original", async () => {
			const before = await stagingFolders();
			const unseen = path.join(tempDir, "unseen.txt");
			await Bun.write(unseen, "read from the copy");
			const { run, close, proxy } = await openConnectedTab("browser-upload-unseen", {
				proxy: routeProxy("paths", { hideFiles: [unseen] }),
			});
			try {
				const errors = await run(
					collectErrors(`() => tab.uploadFile("#direct", "unseen.txt"),
() => tab.uploadFile("#trigger", "unseen.txt"),
() => tab.uploadFile("#drop", "unseen.txt"),`),
				);
				expect(errors).toEqual([]);
				await fs.rm(unseen);
				expect(await run(readTexts)).toEqual(["read from the copy", "read from the copy", "read from the copy"]);
				// Each upload's picker was handed the file's own path and listed an empty file of that name, so a copy
				// followed: onto the real input, or for the drop zone into a second picker whose files are the drop's.
				expect(proxy.filePaths.filter(files => files.includes(unseen))).toHaveLength(3);
				const folder = path.join(os.tmpdir(), (await stagingFoldersSince(before))[0] ?? "no staging folder");
				expect(
					proxy.filePaths.filter(files => files.every(file => file.startsWith(folder + path.sep))),
				).toHaveLength(3);
			} finally {
				await close();
			}
		}, 60_000);

		test("fires input and change again when a file is uploaded once more to the same input", async () => {
			// Chrome fires `cancel` for a selection whose paths the input already holds, so an upload to the same input
			// again takes fresh copies under new paths instead of the file's own path.
			const before = await stagingFolders();
			const { run, close, proxy } = await openConnectedTab("browser-upload-again", {
				proxy: routeProxy("paths"),
			});
			try {
				const own = path.join(tempDir, "again.txt");
				await Bun.write(own, "first");
				const modified = new Date("2020-01-02T03:04:05Z");
				await fs.utimes(own, modified, modified);
				const events = `return await tab.evaluate(() => { const fired = window.fileEvents; window.fileEvents = []; return fired; });`;
				const pick = ["direct:input", "direct:change"];
				expect(await run(collectErrors(`() => tab.uploadFile("#direct", "again.txt"),`))).toEqual([]);
				expect(await run(events)).toEqual(pick);
				// The first pick was the file's own path: nothing was copied.
				expect(await stagingFoldersSince(before)).toEqual([]);
				await Bun.write(own, "rewritten, and longer");
				const later = new Date(modified.getTime() + 60_000);
				await fs.utimes(own, later, later);
				expect(await run(collectErrors(`() => tab.uploadFile("#direct", "again.txt"),`))).toEqual([]);
				expect(await run(events)).toEqual(pick);
				expect(await run(collectErrors(`() => tab.uploadFile("#direct", "again.txt"),`))).toEqual([]);
				expect(await run(events)).toEqual(pick);
				expect(
					await run(`return await tab.evaluate(() => document.querySelector("#direct").files[0].text());`),
				).toBe("rewritten, and longer");
				// The same through a chooser.
				const chooserPick = ["trigger-input:input", "trigger-input:change"];
				expect(await run(collectErrors(`() => tab.uploadFile("#trigger", "again.txt"),`))).toEqual([]);
				expect(await run(events)).toEqual(chooserPick);
				expect(await run(collectErrors(`() => tab.uploadFile("#trigger", "again.txt"),`))).toEqual([]);
				expect(await run(events)).toEqual(chooserPick);
				// Each pick by an input that already listed the file took a copy under a path of its own: two on the page's
				// input, one on the chooser's, whose first pick took the file's own path.
				const staging = path.join(os.tmpdir(), (await stagingFoldersSince(before))[0] ?? "no staging folder");
				const copies = proxy.filePaths.filter(
					files => files.length === 1 && files[0]?.startsWith(staging + path.sep),
				);
				expect(copies).toHaveLength(3);
				expect(new Set(copies.map(files => files[0])).size).toBe(3);
			} finally {
				await close();
			}
		}, 60_000);

		test("stages a copy for an empty file the browser cannot see", async () => {
			// Chrome lists a missing path as an empty file under the name it was asked for, so only a read tells it from
			// the real empty file.
			const before = await stagingFolders();
			const empty = path.join(tempDir, "empty.txt");
			await Bun.write(empty, "");
			const { run, close, proxy } = await openConnectedTab("browser-upload-empty-unseen", {
				proxy: routeProxy("paths", { hideFiles: [empty] }),
			});
			try {
				expect(await run(collectErrors(`() => tab.uploadFile("#direct", "empty.txt"),`))).toEqual([]);
				expect(proxy.filePaths.some(files => files.includes(empty))).toBe(true);
				expect(await stagingFoldersSince(before)).toHaveLength(1);
				expect(
					await run(
						`return await tab.evaluate(async () => { const file = document.querySelector("#direct").files[0]; return [file.size, await file.text()]; });`,
					),
				).toEqual([0, ""]);
			} finally {
				await close();
			}
		}, 60_000);
	},
);

describe("a browser reading the files' own paths", () => {
	test("gets them away from macOS for files, never for a folder", async () => {
		const file = path.join(tempDir, "own-route.txt");
		const folder = path.join(tempDir, "own-route-album");
		await Bun.write(file, "x");
		await fs.mkdir(path.join(folder, "nested"), { recursive: true });
		const source = await openUploadSource(file);
		const album = await openUploadSource(folder);
		expect(readsOwnPaths([source])).toBe(process.platform !== "darwin");
		expect(readsOwnPaths([album])).toBe(false);
		expect(readsOwnPaths([source, album])).toBe(false);
	});

	test("must list them as given and open each", async () => {
		const slices: [number, number][] = [];
		const whole: string[] = [];
		const listed = (name: string, size: number, opens = true) => ({
			name,
			size,
			slice: (start: number, end: number) => {
				slices.push([start, end]);
				return {
					arrayBuffer: async () => {
						if (!opens) throw new Error("NotReadableError");
						return new ArrayBuffer(1);
					},
				};
			},
			arrayBuffer: async () => {
				whole.push(name);
				if (!opens) throw new Error("NotFoundError");
				return new ArrayBuffer(0);
			},
		});
		// Another file has its last byte read; an empty one is read whole, since Chrome lists a missing path as an
		// empty file of that name too.
		expect(
			await filesAreOpenable(
				[listed("a.txt", 5), listed("b.txt", 0)],
				[
					["a.txt", 5],
					["b.txt", 0],
				],
			),
		).toBe(true);
		expect(slices).toEqual([[4, 5]]);
		expect(whole).toEqual(["b.txt"]);
		// Another count, name or size.
		expect(
			await filesAreOpenable(
				[listed("a.txt", 5)],
				[
					["a.txt", 5],
					["b.txt", 0],
				],
			),
		).toBe(false);
		expect(
			await filesAreOpenable(
				[listed("a.txt", 5), listed("b.txt", 0)],
				[
					["a.txt", 5],
					["other.txt", 0],
				],
			),
		).toBe(false);
		expect(await filesAreOpenable([listed("a.txt", 5)], [["a.txt", 4]])).toBe(false);
		// Listed with its size, as Chrome lists a path it cannot read, but not openable.
		expect(await filesAreOpenable([listed("a.txt", 5, false)], [["a.txt", 5]])).toBe(false);
		// An empty file of that name on another machine's file system.
		expect(await filesAreOpenable([listed("b.txt", 0, false)], [["b.txt", 0]])).toBe(false);
	});

	test("tell an input that already lists them", () => {
		const holding = (names: string[]) => ({ files: names.map(name => ({ name })) });
		expect(inputListsNames(holding(["a.txt", "b.txt"]), ["a.txt", "b.txt"])).toBe(true);
		expect(inputListsNames(holding(["a.txt"]), ["a.txt", "b.txt"])).toBe(false);
		expect(inputListsNames(holding(["b.txt", "a.txt"]), ["a.txt", "b.txt"])).toBe(false);
		expect(inputListsNames({ files: null }, ["a.txt"])).toBe(false);
	});
});

test("sweeps a staging folder a day after its last upload unless an open tab or a running omp owns it", async () => {
	const now = Date.now();
	const dayAgo = new Date(now - 25 * 60 * 60 * 1000);
	// No process has a pid this large; the parent of this test process is running.
	const folders = {
		open: [`omp-uploads-${process.pid}-sweep-open`, dayAgo],
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
		expect(Object.values(folders).map(([name]) => left.has(name))).toEqual([true, false, false, true]);
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
