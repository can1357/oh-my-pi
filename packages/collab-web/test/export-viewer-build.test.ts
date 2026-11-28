import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Context, createContext, runInContext, runInNewContext } from "node:vm";
import type { SessionTrace } from "@oh-my-pi/omp-stats/client/traces";
import { type Document, HTMLElement, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { stringifyJsonIteratively } from "@oh-my-pi/pi-utils/json";
import { Marked, type MarkedExtension } from "@oh-my-pi/pi-utils/marked";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { nestedChain } from "../../ai/test/helpers/deep-nesting";
import { buildExportViewer, type ExportViewerMetadata, isExportViewerCheck } from "../scripts/build-export-viewer";

const temp = TempDir.createSync("@omp-export-viewer-build-");
const outDir = temp.path();
const staleName = `export-viewer-${"0".repeat(64)}.js`;
const unrelatedName = "another-build.js";
let metadata: ExportViewerMetadata;
let bytes: Buffer<ArrayBuffer>;

beforeAll(async () => {
	await Bun.write(path.join(outDir, staleName), "obsolete viewer");
	await Bun.write(path.join(outDir, unrelatedName), "unrelated output");
	await fs.mkdir(path.join(outDir, `export-viewer-${"1".repeat(64)}.js`));
	metadata = await buildExportViewer({ outDir });
	bytes = await fs.readFile(path.join(outDir, metadata.file));
}, 30_000);

afterAll(() => temp[Symbol.dispose]());

const sessionHeader = {
	type: "session",
	version: 3,
	id: "shared-runtime",
	timestamp: "2026-01-01T00:00:00Z",
	cwd: "/tmp",
};

/** A page the built viewer ran in. React's scheduled work waits until `flushWork` or `settle` runs it. */
interface ViewerPage {
	context: Context;
	document: Document;
	flushWork(): void;
	/** Runs scheduled work, and the promise callbacks it starts, until none is left. */
	settle(): Promise<void>;
}

/**
 * Runs the built viewer in a page that embeds `session` after a custom theme, with the context globals
 * `globals` adds or replaces (its Markdown and highlight dependencies, say). The lightweight DOM neither
 * upgrades custom elements nor has shadow roots, canvases, observers or layout. Here a custom element gets
 * the tag it was defined with and a light-DOM child as its shadow root, a canvas has no 2D context (the
 * trace views then draw nothing), and an observer observes nothing.
 */
function runViewer(session: unknown, globals: Record<string, unknown>): ViewerPage {
	const { document, window } = parseHTML(
		'<html><head><style id="custom-theme">:root { --accent: red; }</style></head><body><p id="viewer-status">Loading viewer…</p><script id="session-data"></script></body></html>',
	);
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Missing test session data");
	// As the export writes it: a session of any depth, where `JSON.stringify` stops near 40,000 levels.
	sessionData.textContent = Buffer.from(stringifyJsonIteratively(session)!).toBase64();
	Object.defineProperty(window, "location", { value: new URL("https://example.test/export.html") });
	const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Object.defineProperty(window, "matchMedia", { value: matchMedia });
	// Ignore transcript layout-only scroll timers and the copy buttons' "Copied" resets.
	const timers = { setTimeout: () => 0, clearTimeout() {} };
	Object.assign(window, timers);
	const createElement = document.createElement.bind(document);
	Object.assign(document, {
		createElement(tagName: string) {
			const element = createElement(tagName);
			if (tagName.toLowerCase() === "canvas") Object.assign(element, { getContext: () => null });
			return element;
		},
	});

	const elements = new Map<string, typeof HTMLElement>();
	const tags = new Map<unknown, string>();
	const scheduled: Array<() => void> = [];
	const flushWork = () => {
		while (scheduled.length > 0) scheduled.shift()?.();
	};
	class Unobserved {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const context = createContext({
		window,
		document,
		HTMLElement: class extends HTMLElement {
			constructor() {
				super(tags.get(new.target) ?? "div", document);
			}
			attachShadow() {
				const root = createElement("div");
				this.append(root);
				return root;
			}
		},
		customElements: {
			get: (name: string) => elements.get(name),
			define: (name: string, element: typeof HTMLElement) => {
				elements.set(name, element);
				tags.set(element, name);
			},
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		AbortController,
		DOMException,
		atob,
		navigator: window.navigator,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia,
		getComputedStyle: (element: HTMLElement) => element.style,
		ResizeObserver: Unobserved,
		MutationObserver: Unobserved,
		devicePixelRatio: 1,
		// Drive React's scheduled work explicitly; ignore canvas frames.
		setImmediate: (callback: () => void) => scheduled.push(callback),
		...timers,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame() {},
		queueMicrotask: (callback: () => void) => scheduled.push(callback),
		performance,
		console,
		...globals,
	});
	runInContext(bytes.toString("utf8"), context);
	return {
		context,
		document,
		flushWork,
		async settle() {
			do {
				flushWork();
				// The host's event loop turns only once every pending promise callback (an entry load's, say) ran.
				const turn = Promise.withResolvers<void>();
				setImmediate(turn.resolve);
				await turn.promise;
			} while (scheduled.length > 0);
		},
	};
}

describe("hosted export viewer build", () => {
	it("hashes the exact uploaded bytes and removes only obsolete viewer files", async () => {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		expect(metadata).toEqual({
			file: `export-viewer-${digest.toHex()}.js`,
			integrity: `sha256-${digest.toBase64()}`,
			size: bytes.length,
		});
		expect(await Bun.file(path.join(outDir, "viewer.generated.json")).json()).toEqual(metadata);
		expect(await Bun.file(path.join(outDir, staleName)).exists()).toBe(false);
		expect(await Bun.file(path.join(outDir, unrelatedName)).text()).toBe("unrelated output");
		expect((await fs.stat(path.join(outDir, `export-viewer-${"1".repeat(64)}.js`))).isDirectory()).toBe(true);
	});

	it("reproduces the asset while checking, rather than rewriting, its manifest", async () => {
		const metadataPath = path.join(outDir, "checked.json");
		const original = JSON.stringify(metadata);
		await Bun.write(metadataPath, original);
		expect(await buildExportViewer({ outDir, metadataPath, check: true })).toEqual(metadata);
		expect(await Bun.file(metadataPath).text()).toBe(original);
		expect(await fs.readFile(path.join(outDir, metadata.file))).toEqual(bytes);
	}, 30_000);

	for (const field of ["file", "integrity", "size"]) {
		it(`rejects a stale ${field} pin without changing the manifest or asset`, async () => {
			const metadataPath = path.join(outDir, `stale-${field}.json`);
			const original = JSON.stringify({ ...metadata, [field]: field === "size" ? metadata.size + 1 : "stale" });
			await Bun.write(metadataPath, original);
			await expect(buildExportViewer({ outDir, metadataPath, check: true })).rejects.toThrow(
				"metadata is stale; run bun run gen:export-viewer --write",
			);
			expect(await Bun.file(metadataPath).text()).toBe(original);
			expect(await fs.readFile(path.join(outDir, metadata.file))).toEqual(bytes);
		}, 30_000);
	}

	// The stale-manifest error names `--write`: under CI=true, which omp's bash tool
	// also sets, the bare command only re-runs the check and prints the same error.
	it("checks under CI unless --write is passed, and always checks with --check", () => {
		expect(isExportViewerCheck([], {})).toBe(false);
		expect(isExportViewerCheck([], { CI: "true" })).toBe(true);
		expect(isExportViewerCheck(["--write"], { CI: "true" })).toBe(false);
		expect(isExportViewerCheck(["--check", "--write"], {})).toBe(true);
	});

	for (const dependency of ["Markdown", "Highlight"]) {
		it(`reports a missing ${dependency} dependency before mutating the page`, () => {
			const status = {
				textContent: "Loading viewer…",
				remove: () => {
					throw new Error("Status removed");
				},
			};
			let mutations = 0;
			runInNewContext(bytes.toString("utf8"), {
				ompMarkdown: dependency === "Markdown" ? undefined : { Marked },
				document: {
					createElement() {
						mutations++;
						throw new Error("Unexpected page mutation");
					},
					getElementById(id: string) {
						return id === "viewer-status" ? status : null;
					},
				},
			});
			expect(status.textContent).toBe(`Failed to load viewer: ${dependency} dependency failed to load`);
			expect(mutations).toBe(0);
		});
	}

	it("catches synchronous initialization failures and renders them as status text", () => {
		const status = { textContent: "Loading viewer…" };
		runInNewContext(bytes.toString("utf8"), {
			ompMarkdown: { Marked },
			hljs: { getLanguage() {}, highlight() {}, highlightAuto() {} },
			document: {
				createElement() {
					throw new Error("<img src=x onerror=alert(1)>");
				},
				getElementById(id: string) {
					return id === "viewer-status" ? status : null;
				},
			},
		});
		expect(status.textContent).toContain("Failed to load viewer:");
		expect(status.textContent).toContain("<img src=x onerror=alert(1)>");
	});

	it("shares dependencies with real tool cards without leaking their math configuration into the transcript", () => {
		const parsers: Marked[] = [];
		class SharedMarked extends Marked {
			constructor(...extensions: MarkedExtension[]) {
				super(...extensions);
				parsers.push(this);
			}
		}
		const highlighted: string[] = [];
		const hljs = {
			getLanguage: () => true,
			highlight(code: string) {
				highlighted.push(code);
				return { value: `<span class="shared-highlight">${code}</span>` };
			},
			highlightAuto(code: string) {
				return this.highlight(code);
			},
		};
		const { context, document, flushWork } = runViewer(
			{
				header: sessionHeader,
				leafId: "assistant-1",
				entries: [
					{
						type: "message",
						id: "assistant-1",
						parentId: null,
						timestamp: "2026-01-01T00:00:01Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "$x^2$\n\n```js\nconst transcriptCode = 1;\n```" }],
							stopReason: "stop",
							timestamp: 1,
						},
					},
				],
			},
			{ ompMarkdown: { Marked: SharedMarked }, hljs },
		);
		expect(
			document.getElementById("viewer-status"),
			document.getElementById("viewer-status")?.textContent ?? "",
		).toBeNull();
		expect(parsers).toHaveLength(2);
		expect(parsers[0]).not.toBe(parsers[1]);
		expect(document.head.firstElementChild?.getAttribute("data-omp-export-viewer")).toBe("");
		expect(document.getElementById("custom-theme")?.previousElementSibling).toBe(document.head.firstElementChild);
		const assistant = document.querySelector(".assistant-message");
		expect(assistant?.textContent).toContain("$x^2$");
		expect(assistant?.querySelector("math")).toBeNull();
		expect(assistant?.querySelector(".shared-highlight")?.textContent).toContain("const transcriptCode = 1;");

		const payload = {
			name: "eval",
			args: { language: "js", code: "const toolCode = 2;" },
			defaultOpen: true,
			result: {
				content: [],
				details: {
					cells: [
						{
							index: 0,
							output: "$x^2$",
							views: [{ text: "$x^2$", view: { kind: "markdown", text: "$x^2$" } }],
						},
					],
				},
			},
		};
		// The lightweight DOM does not auto-upgrade custom elements. Instantiate the
		// actual registered React wrapper and deliver its normal connection callback.
		runInContext(
			`
			const tool = new (customElements.get("omp-tool-view"))();
			tool.setAttribute("payload", ${JSON.stringify(JSON.stringify(payload))});
			document.body.appendChild(tool);
			tool.connectedCallback();
		`,
			context,
		);
		try {
			flushWork();
			expect(document.querySelector("omp-tool-view .tr-md math")).not.toBeNull();
			expect(document.querySelector("omp-tool-view .shared-highlight")?.textContent).toBe("const toolCode = 2;");
			expect(highlighted.some(code => code.includes("const transcriptCode = 1;"))).toBe(true);
			expect(highlighted).toContain("const toolCode = 2;");
			expect(parsers[1]?.parse("$x^2$", { async: false })).toBe("<p>$x^2$</p>\n");
			expect(new SharedMarked().parse("$x^2$", { async: false })).toBe("<p>$x^2$</p>\n");
		} finally {
			runInContext("tool.remove(); tool.disconnectedCallback();", context);
			flushWork();
		}
	});

	// The viewer bundles the dashboard's span drawer, whose JSON views write a value nested past 1,000 levels
	// with pi-utils' iterative writer. That writer reads boxed primitives through `node:util/types`, which Bun's
	// browser target leaves without exports unless the build resolves it to the stats client's checks.
	it("shows and copies a span's raw entry nested past 1,000 levels, on one line", async () => {
		const nested = nestedChain(undefined, 2_000);
		const timestamp = "2026-01-01T00:00:01Z";
		const entry = { type: "custom", customType: "deep", id: "deep-1", parentId: null, timestamp, data: nested };
		const start = Date.parse(timestamp);
		const trace = {
			file: "main",
			title: null,
			cwd: null,
			startedAt: start,
			endedAt: start + 1_000,
			mtimeMs: start + 1_000,
			etag: "snapshot",
			tracks: [
				{
					id: "main",
					parentId: null,
					label: "main",
					agent: null,
					model: null,
					file: "main",
					spans: [
						{ id: "main:deep-1", kind: "tool", start, end: start + 500, label: "deep_tool", entryId: entry.id },
					],
					markers: [],
				},
			],
			summary: {
				wallMs: 1_000,
				modelMs: 0,
				toolMs: 500,
				idleMs: 500,
				turns: 0,
				requests: 0,
				toolCalls: 1,
				subagents: 0,
				totalTokens: 0,
				costTotal: 0,
				unpricedRequests: 0,
				toolStats: [],
			},
		} satisfies SessionTrace;
		const copied: string[] = [];
		const errors: unknown[] = [];
		const page = runViewer(
			{ header: sessionHeader, leafId: entry.id, entries: [entry], trace },
			{
				ompMarkdown: { Marked },
				hljs: { getLanguage() {}, highlight() {}, highlightAuto() {} },
				navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
				// Where React reports the render error that unmounts the trace view.
				reportError: (error: unknown) => void errors.push(error),
			},
		);
		const { document } = page;
		const status = document.getElementById("viewer-status");
		expect(status, status?.textContent ?? "").toBeNull();
		// The page gave its parsed session data to the shell's trace element, which a browser then upgrades.
		runInContext(
			`
			const placeholder = document.querySelector("omp-session-trace");
			const trace = new (customElements.get("omp-session-trace"))();
			trace.setAttribute("view", "full");
			trace.sessionData = placeholder.sessionData;
			placeholder.replaceWith(trace);
			trace.connectedCallback();
		`,
			page.context,
		);
		const click = (selector: string, text?: string) => {
			const found = [...document.querySelectorAll(`omp-session-trace ${selector}`)].find(
				element => text === undefined || element.textContent === text,
			);
			if (!found) throw new Error(`Nothing matches ${selector}; reported: ${errors.join("; ")}`);
			(found as HTMLElement).click();
		};
		try {
			await page.settle();
			click("button.traces-row");
			await page.settle();
			click(".traces-inline-detail button", "Raw entry");
			await page.settle();
			click('.traces-inline-detail button[aria-label="Copy raw JSON"]');
			click(".traces-inline-detail button", "Copy");
			await page.settle();

			const expected = stringifyJsonIteratively(entry);
			expect(errors).toEqual([]);
			const shown = document.querySelector("omp-session-trace .traces-inline-detail code")?.textContent;
			expect(shown === expected).toBe(true);
			expect(copied.length).toBe(2);
			expect(copied.every(text => text === expected)).toBe(true);
		} finally {
			runInContext("trace.remove(); trace.disconnectedCallback();", page.context);
			page.flushWork();
		}
	}, 30_000);

	// A call to a tool the viewer has no view of its own for (an MCP or extension tool) is labelled in the session
	// tree and shown in the generic card by its arguments' JSON; a session entry nests as deep as `JSON.parse` reads,
	// past the browser's `JSON.stringify`, which failed the whole page ("Failed to load viewer"). JSON can also carry
	// a `toJSON` key that is not a function, which `JSON.stringify` writes as a key like the rest: the card took
	// arguments holding one as shallow and showed `[object Object]` once `JSON.stringify` ran out of stack.
	for (const [levels, toJSONKey] of [
		[0, false],
		[50_000, false],
		[50_000, true],
	] as const) {
		it(`labels and shows a call to an unnamed tool whose arguments nest ${levels.toLocaleString("en-US")} levels${toJSONKey ? " and hold a toJSON key" : ""}`, () => {
			let args = nestedChain(undefined, levels);
			if (toJSONKey) args = { toJSON: null, ...args };
			const timestamp = "2026-01-01T00:00:01Z";
			const page = runViewer(
				{
					header: sessionHeader,
					leafId: "result-1",
					entries: [
						{
							type: "message",
							id: "assistant-1",
							parentId: null,
							timestamp,
							message: {
								role: "assistant",
								content: [{ type: "toolCall", id: "call-1", name: "inspect_deep", arguments: args }],
								stopReason: "toolUse",
								timestamp: 1,
							},
						},
						{
							type: "message",
							id: "result-1",
							parentId: "assistant-1",
							timestamp,
							message: {
								role: "toolResult",
								toolCallId: "call-1",
								toolName: "inspect_deep",
								content: [{ type: "text", text: "ok" }],
								isError: false,
								timestamp: 2,
							},
						},
					],
				},
				{ ompMarkdown: { Marked }, hljs: { getLanguage() {}, highlight() {}, highlightAuto() {} } },
			);
			const { document } = page;
			const status = document.getElementById("viewer-status");
			expect(status, status?.textContent ?? "").toBeNull();

			const json = stringifyJsonIteratively(args)!;
			const labels = [...document.querySelectorAll(".tree-role-tool")].map(element => element.textContent);
			expect(labels).toContain(`[inspect_deep: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`);

			// The page hands the card its call through the element's data key; a browser then upgrades the element.
			runInContext(
				`
				const placeholder = document.querySelector("omp-tool-view");
				const tool = new (customElements.get("omp-tool-view"))();
				tool.setAttribute("data-key", placeholder.getAttribute("data-key"));
				placeholder.replaceWith(tool);
				tool.connectedCallback();
			`,
				page.context,
			);
			try {
				page.flushWork();
				// Checked before the card opens: a card that takes such arguments as shallow indents them with
				// `JSON.stringify`, whose text grows with the square of the depth (gigabytes at 40,000 levels).
				const head = document.querySelector("omp-tool-view .tv-head") as HTMLElement | null;
				expect(head?.textContent ?? "").toContain(json.length > 96 ? `${json.slice(0, 96)}…` : json);
				head?.click();
				page.flushWork();
				const shown = document.querySelector("omp-tool-view .tv-out pre")?.textContent ?? "";
				if (levels === 0) {
					expect(shown).toBe(JSON.stringify(args, null, 2));
				} else {
					// One line, cut: the start of the arguments' JSON and an ellipsis.
					expect(shown.length).toBeLessThan(json.length);
					expect(shown === `${json.slice(0, shown.length - 1)}…`).toBe(true);
				}
			} finally {
				runInContext("tool.remove(); tool.disconnectedCallback();", page.context);
				page.flushWork();
			}
		}, 30_000);
	}

	// An extension's custom message is shown by its content, written as JSON when it is not a string; a session entry
	// nests as deep as `JSON.parse` reads, past the browser's `JSON.stringify`, which failed the whole page.
	for (const levels of [0, 50_000]) {
		it(`shows a custom message whose content nests ${levels.toLocaleString("en-US")} levels`, () => {
			const content = nestedChain(undefined, levels);
			const { document } = runViewer(
				{
					header: sessionHeader,
					leafId: "custom-1",
					entries: [
						{
							type: "custom_message",
							id: "custom-1",
							parentId: null,
							timestamp: "2026-01-01T00:00:01Z",
							customType: "probe",
							content,
							display: true,
						},
					],
				},
				{ ompMarkdown: { Marked }, hljs: { getLanguage() {}, highlight() {}, highlightAuto() {} } },
			);
			const status = document.getElementById("viewer-status");
			expect(status, status?.textContent ?? "").toBeNull();

			const shown = document.querySelector(".hook-message .markdown-content")?.textContent?.trim();
			expect(shown === stringifyJsonIteratively(content)).toBe(true);
		}, 30_000);
	}
});
