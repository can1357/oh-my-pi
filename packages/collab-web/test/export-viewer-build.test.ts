import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { HTMLElement, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { Marked, type MarkedExtension } from "@oh-my-pi/pi-utils/marked";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildExportViewer, type ExportViewerMetadata } from "../scripts/build-export-viewer";

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
			await expect(buildExportViewer({ outDir, metadataPath, check: true })).rejects.toThrow("metadata is stale");
			expect(await Bun.file(metadataPath).text()).toBe(original);
			expect(await fs.readFile(path.join(outDir, metadata.file))).toEqual(bytes);
		}, 30_000);
	}

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
		const { document, window } = parseHTML(
			'<html><head><style id="custom-theme">:root { --accent: red; }</style></head><body><p id="viewer-status">Loading viewer…</p><script id="session-data"></script></body></html>',
		);
		const sessionData = document.getElementById("session-data");
		if (!sessionData) throw new Error("Missing test session data");
		sessionData.textContent = Buffer.from(
			JSON.stringify({
				header: {
					type: "session",
					version: 3,
					id: "shared-runtime",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp",
				},
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
			}),
		).toBase64();
		Object.defineProperty(window, "location", { value: new URL("https://example.test/export.html") });
		const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
		Object.defineProperty(window, "matchMedia", { value: matchMedia });

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
		const elements = new Map<string, typeof HTMLElement>();
		const scheduled: Array<() => void> = [];
		const flushWork = () => {
			while (scheduled.length > 0) scheduled.shift()?.();
		};
		const context = createContext({
			window,
			document,
			HTMLElement: class extends HTMLElement {
				constructor() {
					super("omp-tool-view", document);
				}
			},
			customElements: {
				get: (name: string) => elements.get(name),
				define: (name: string, element: typeof HTMLElement) => elements.set(name, element),
			},
			ompMarkdown: { Marked: SharedMarked },
			hljs,
			URL,
			URLSearchParams,
			TextDecoder,
			Uint8Array,
			atob,
			navigator: window.navigator,
			localStorage: { getItem: () => null, setItem() {} },
			matchMedia,
			getComputedStyle: (element: HTMLElement) => element.style,
			// Drive React's scheduled work explicitly; ignore transcript layout-only scroll timers.
			setImmediate: (callback: () => void) => scheduled.push(callback),
			setTimeout: () => 0,
			clearTimeout() {},
			queueMicrotask: (callback: () => void) => scheduled.push(callback),
			performance,
			console,
		});
		runInContext(bytes.toString("utf8"), context);
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
});
