import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { FenceFigure } from "@oh-my-pi/pi-tui/chat/fence-figure";
import { FigureMarkdown } from "@oh-my-pi/pi-tui/chat/figure-markdown";
import { resolveMermaidDiagram } from "@oh-my-pi/pi-tui/chat/mermaid-figure";
import { setSvgFigureRendering, svgFigureRendering } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { hasMermaidFence, splitFigureFences } from "@oh-my-pi/pi-tui/chat/svg-source";
import { setTableCharts, tableChartMode } from "@oh-my-pi/pi-tui/chat/table-chart";
import { Image, ImageBudget, renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { setImageBlobWriter } from "@oh-my-pi/pi-tui/prompt/image-references";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme, setMarkdownMermaidRendering } from "@oh-my-pi/pi-tui/theme";
import type { ToolFigure } from "@oh-my-pi/pi-tui/tools/renderer";
import * as pele from "pele";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const NORMAL = "flowchart LR\n  A[Start] --> B[Review] --> C[Ship]\n";
const TINY = "flowchart LR\n  A[One]\n";
const LARGE = `flowchart TD\n${Array.from({ length: 110 }, (_, index) => `  N${index}[Stage ${index}]`).join("\n")}\n${Array.from({ length: 109 }, (_, index) => `  N${index} --> N${index + 1}`).join("\n")}\n`;
const SVG = '<svg viewBox="0 0 160 40"><rect width="160" height="40" fill="#3b82f6"/></svg>';
const CELL = { widthPx: 16, heightPx: 32 };
const originalProtocol = TERMINAL.imageProtocol;
const originalCell = { ...getCellDimensions() };
const originalGraphics = { ...getKittyGraphics() };
const originalNative = isNativeRendering();
const originalSvg = svgFigureRendering();
const originalCharts = tableChartMode();
let originalMermaid = true;
const mounted = new Set<{ dispose(): void }>();

type Consumer = FigureMarkdown | AssistantMessageComponent;

class Changes {
	#version = 0;
	#next = Promise.withResolvers<void>();

	get version(): number {
		return this.#version;
	}

	notify = (): void => {
		this.#version++;
		const previous = this.#next;
		this.#next = Promise.withResolvers<void>();
		previous.resolve();
	};

	async after(version: number): Promise<void> {
		if (version === this.#version) await this.#next.promise;
	}
}

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function fence(source: string): string {
	return `\`\`\`mermaid\n${source}\`\`\``;
}

function figure(text: string, changes: Changes, budget?: ImageBudget, charts = false): FigureMarkdown {
	const component = new FigureMarkdown(text, {
		markdown: source => new Markdown(source, 1, 0, getMarkdownTheme()),
		charts,
		budget,
		onChange: changes.notify,
	});
	mounted.add(component);
	return component;
}

function assistant(
	source: AssistantMessage | undefined,
	changes: Changes,
	budget?: ImageBudget,
): AssistantMessageComponent {
	const component = new AssistantMessageComponent(source, false, changes.notify, [], budget);
	mounted.add(component);
	return component;
}

async function settle(component: Consumer, changes: Changes, width = 80): Promise<readonly string[]> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const version = changes.version;
		const rows = component.render(width);
		const pending =
			component instanceof AssistantMessageComponent ? component.isTranscriptBlockPending() : component.pending;
		if (!pending) return rows;
		await changes.after(version);
	}
	throw new Error("figure did not settle after its change notifications");
}

const plain = (rows: readonly string[]): string => Bun.stripANSI(rows.join("\n"));
const hasImage = (rows: readonly string[]): boolean => rows.some(row => TERMINAL.isImageLine(row));

function expectNormalAscii(rows: readonly string[]): void {
	const text = plain(rows);
	for (const label of ["Start", "Review", "Ship"]) expect(text).toContain(label);
	expect(text).not.toContain("-->");
	expect(text).not.toContain("```mermaid");
}

/** Count the image's complete reserved footprint, not just its protocol-bearing last row. */
function reservedImageRows(rows: readonly string[]): number {
	const image = rows.find(row => TERMINAL.isImageLine(row));
	expect(image).toBeDefined();
	const imageRows = Number(/,r=(\d+)/.exec(image!)?.[1]);
	expect(imageRows).toBeGreaterThan(0);
	return imageRows;
}

beforeAll(async () => {
	await initTheme(false);
	originalMermaid = getMarkdownTheme().resolveMermaidAscii !== undefined;
});

beforeEach(() => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setCellDimensions(CELL);
	setKittyGraphics({ unicodePlaceholders: false });
	setNativeRendering(false);
	setMarkdownMermaidRendering(true);
	setSvgFigureRendering(true);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const component of mounted) component.dispose();
	mounted.clear();
	setTerminalImageProtocol(originalProtocol);
	setCellDimensions(originalCell);
	setKittyGraphics(originalGraphics);
	setNativeRendering(originalNative);
	setMarkdownMermaidRendering(originalMermaid);
	setSvgFigureRendering(originalSvg);
	setTableCharts(originalCharts);
});

describe("source-preserving figure fence segmentation", () => {
	it("lifts only completed top-level Mermaid fences and preserves authored line endings", () => {
		const source = "flowchart LR\r\n  A[One] --> B[Two]  \r\n";
		const text = `Before\r\n\r\n~~~ MERMAID title\r\n${source}~~~~\r\nAfter`;
		expect(hasMermaidFence(text)).toBe(true);
		expect(splitFigureFences(text, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: "Before\r\n\r\n" },
			{ kind: "mermaid", source, closed: true },
			{ kind: "markdown", text: "After" },
		]);
		const open = `Before\n\`\`\`\`mermaid\n${NORMAL}\`\`\`\n`;
		expect(splitFigureFences(open, { svg: true, mermaid: true })).toEqual([{ kind: "markdown", text: open }]);
	});

	it("leaves nested, quoted, indented, disabled and mismatched Mermaid fences as prose", () => {
		for (const text of [
			`\`\`\`\`markdown\n${fence(NORMAL)}\n\`\`\`\``,
			"    ```mermaid\n    flowchart LR\n    A --> B\n    ```",
			"> ```mermaid\n> flowchart LR\n> A --> B\n> ```",
			"- item\n\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```",
			"1. item\n\n   ~~~mermaid\n   flowchart LR\n   A --> B\n   ~~~",
			"<div>\n```mermaid\nflowchart LR\nA --> B\n```\n</div>",
			`~~~mermaid\n${NORMAL}\`\`\``,
			`\`\`\`mermaid\n${NORMAL}~~~`,
		]) {
			expect(splitFigureFences(text, { svg: true, mermaid: true })).toEqual([{ kind: "markdown", text }]);
		}
		const text = fence(NORMAL);
		expect(splitFigureFences(text, { svg: true, mermaid: false })).toEqual([{ kind: "markdown", text }]);
		expect(hasMermaidFence("```mermaidx\n``` ")).toBe(false);
	});

	it("still lifts a top-level fence after a finished list", () => {
		const prefix = "- list item\n\n";
		expect(splitFigureFences(`${prefix}${fence(NORMAL)}`, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: prefix },
			{ kind: "mermaid", source: NORMAL, closed: true },
		]);
	});

	it("keeps old SVG partial-fence behavior and gates the two languages independently", () => {
		const svg = `Before\n~~~svg\n${SVG}\n~~~\n`;
		expect(splitFigureFences(svg, { svg: true, mermaid: false })).toEqual([
			{ kind: "markdown", text: "Before\n" },
			{ kind: "svg", source: `${SVG}\n`, closed: true },
		]);
		expect(splitFigureFences("```svg\n<svg>", { svg: true, mermaid: false })).toEqual([
			{ kind: "svg", source: "<svg>", closed: false },
		]);
		expect(splitFigureFences(`${svg}${fence(NORMAL)}`, { svg: false, mermaid: true })).toEqual([
			{ kind: "markdown", text: svg },
			{ kind: "mermaid", source: NORMAL, closed: true },
		]);
	});
});

describe("graphical Mermaid presentation", () => {
	for (const [name, source] of [
		["normal", NORMAL],
		["large", LARGE],
		["tiny", TINY],
	] as const) {
		it(`draws a bounded ${name} preview between the surrounding prose`, async () => {
			if (name === "large") expect(resolveMermaidDiagram(source)!.height).toBeGreaterThan(8000);
			const changes = new Changes();
			const component = figure(`Prose before.\n\n${fence(source)}\n\nProse after.`, changes);
			const rows = await settle(component, changes);
			const imageRows = reservedImageRows(rows);
			expect(imageRows).toBeLessThanOrEqual(Math.max(1, Math.floor((process.stdout.rows || 24) * 0.8)));
			expect(plain(rows)).toContain("Prose before.");
			expect(plain(rows)).toContain("Prose after.");
		});
	}

	it("renders assistant thinking, prose and figures without changing the original source", async () => {
		const changes = new Changes();
		const body = `Before diagram.\n\n${fence(NORMAL)}\n\nAfter diagram.`;
		const original = message(body);
		original.content = [
			{ type: "thinking", thinking: "Reasoning before the answer." },
			{ type: "text", text: "Earlier content block." },
			...original.content,
			{ type: "text", text: "Later content block." },
		];
		const persisted = JSON.stringify(original);
		const component = assistant(original, changes);
		const rows = await settle(component, changes);
		expect(hasImage(rows)).toBe(true);
		expect(plain(rows)).toContain("Reasoning before the answer.");
		expect(plain(rows)).toContain("Earlier content block.");
		expect(plain(rows)).toContain("Later content block.");
		expect(JSON.stringify(original)).toBe(persisted);
		const native = component.describe();
		expect(
			native.c?.filter(child => "k" in child && child.k === "md").map(child => ("p" in child ? child.p : undefined)),
		).toContainEqual({ text: body });
	});

	it.each([
		["LF", "\n"],
		["CRLF", "\r\n"],
		["CR", "\r"],
	])("previews %s fences without changing authored line endings or trailing blank lines", async (name, ending) => {
		const source = `flowchart LR${ending}  Source${name}[Preview ${name}] --> End[Preserved]${ending}${ending}`;
		const body = `~~~mermaid${ending}${source}~~~`;
		const changes = new Changes();
		const original = message(body);
		const persisted = JSON.stringify(original);
		const component = assistant(original, changes);
		expect(hasImage(await settle(component, changes))).toBe(true);
		expect(JSON.stringify(original)).toBe(persisted);
		expect(splitFigureFences(body, { svg: false, mermaid: true })).toEqual([
			{ kind: "mermaid", source, closed: true },
		]);
	});

	it("holds a preview pending until its raster lands", async () => {
		const changes = new Changes();
		const component = figure(fence(TINY), changes);
		await Promise.resolve();
		const rows = component.render(80);
		expect(hasImage(rows)).toBe(false);
		expect(component.pending).toBe(true);
		expect(hasImage(await settle(component, changes))).toBe(true);
	});

	it("draws completed Mermaid fences with SIXEL", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const changes = new Changes();
		const component = figure(fence(NORMAL), changes);
		await settle(component, changes);
		const rows = renderForScrollback(() => component.render(80));
		expect(hasImage(rows)).toBe(true);
		expect(component.pending).toBe(false);
	});

	it.each(["markdown", "assistant"] as const)(
		"shows %s previews without writing files or adding links",
		async kind => {
			const writer = vi.fn(() => ({ displayPath: "/unexpected-mermaid-preview.png" }));
			const disposeWriter = setImageBlobWriter(writer);
			applyHyperlinkSetting("always");
			const changes = new Changes();
			const text = fence(NORMAL);
			const component = kind === "markdown" ? figure(text, changes) : assistant(message(text), changes);
			try {
				const rows = await settle(component, changes);
				expect(hasImage(rows)).toBe(true);
				component.invalidate();
				const repainted = await settle(component, changes);
				expect(hasImage(repainted)).toBe(true);
				expect(repainted.join("\n")).not.toContain("\x1b]8;");
				expect(writer).not.toHaveBeenCalled();
			} finally {
				disposeWriter();
				applyHyperlinkSetting("auto");
			}
		},
	);

	it.each(["layout", "raster"] as const)("uses existing Markdown ASCII when %s rendering fails", async failure => {
		const source = `%% ${failure}-fallback fixture\n${NORMAL}`;
		if (failure === "layout") {
			vi.spyOn(pele, "render").mockImplementation(() => {
				throw new Error("layout unavailable");
			});
		} else {
			vi.spyOn(natives, "rasterizeSvg").mockRejectedValue(new Error("raster unavailable"));
		}
		const changes = new Changes();
		const component = figure(fence(source), changes);
		const rows = await settle(component, changes);
		expect(rows).toEqual(new Markdown(fence(source), 1, 0, getMarkdownTheme()).render(80));
		expect(hasImage(rows)).toBe(false);
		expectNormalAscii(rows);
		expect(component.pending).toBe(false);
	});

	it("replaces evicted Mermaid previews with ASCII without writing files", async () => {
		const writer = vi.fn(() => ({ displayPath: "/unexpected-mermaid-fallback.png" }));
		const disposeWriter = setImageBlobWriter(writer);
		applyHyperlinkSetting("always");
		const changes = new Changes();
		const budget = new ImageBudget(1);
		const component = figure(`${fence(NORMAL)}\n\nBetween diagrams.\n\n${fence(TINY)}`, changes, budget);
		try {
			await settle(component, changes);
			budget.beginPass();
			component.render(80);
			expect(budget.endPass()).toBe(true);
			budget.beginPass();
			const demoted = component.render(80);
			expect(budget.endPass()).toBe(false);
			expect(demoted.filter(row => TERMINAL.isImageLine(row))).toHaveLength(1);
			expect(plain(demoted)).toContain("Between diagrams.");
			expectNormalAscii(demoted);
			expect(demoted.join("\n")).not.toContain("\x1b]8;");
			expect(writer).not.toHaveBeenCalled();
			expect(component.pending).toBe(false);
		} finally {
			disposeWriter();
			applyHyperlinkSetting("auto");
		}
	});

	it("releases a replaced Mermaid raster instead of evicting an older scrollback image", async () => {
		const changes = new Changes();
		const budget = new ImageBudget(2);
		const png = await natives.rasterizeSvg(new TextEncoder().encode(SVG), 160, 40, 1);
		const archived = new Image(
			Buffer.from(png).toString("base64"),
			"image/png",
			{ fallbackColor: text => text },
			{ budget, imageKey: "archived-before-mermaid" },
			{ widthPx: 160, heightPx: 40 },
		);
		const component = figure(fence(NORMAL), changes, budget);
		budget.beginPass();
		const archivedRows = archived.render(80);
		const oldRows = await settle(component, changes);
		expect(budget.endPass()).toBe(false);
		budget.takeTransmits();
		budget.limitResidentImages();
		const archivedId = Number(/,i=(\d+)/.exec(archivedRows.join(""))?.[1]);
		const oldId = Number(/,i=(\d+)/.exec(oldRows.join(""))?.[1]);
		expect(budget.takePurgeIds()).toEqual([]);

		component.setText(fence(TINY));
		budget.beginPass();
		expect(hasImage(await settle(component, changes))).toBe(true);
		expect(budget.endPass()).toBe(false);
		budget.takeTransmits();
		budget.limitResidentImages();
		expect(budget.takePurgeIds()).toEqual([oldId]);
		expect(budget.shouldTransmit(archivedId)).toBe(false);
	});

	it("does not couple Mermaid graphics to renderSvg and removes figures when Mermaid rendering is disabled", async () => {
		setSvgFigureRendering(false);
		const changes = new Changes();
		const component = assistant(message(fence(NORMAL)), changes);
		expect(hasImage(await settle(component, changes))).toBe(true);
		setMarkdownMermaidRendering(false);
		component.invalidate();
		const disabled = component.render(80);
		expect(hasImage(disabled)).toBe(false);
		expect(plain(disabled)).toContain("```mermaid");
		expect(plain(disabled)).toContain("A[Start] --> B[Review]");
		expect(component.isTranscriptBlockPending()).toBe(false);
	});

	it("reconciles Mermaid settings inside an existing mixed SVG figure block", async () => {
		const changes = new Changes();
		const component = assistant(message(`${fence(NORMAL)}\n\n\`\`\`svg\n${SVG}\n\`\`\``), changes);
		expect((await settle(component, changes)).filter(row => TERMINAL.isImageLine(row))).toHaveLength(2);
		setMarkdownMermaidRendering(false);
		component.invalidate();
		const rows = await settle(component, changes);
		expect(rows.filter(row => TERMINAL.isImageLine(row))).toHaveLength(1);
		expect(plain(rows)).toContain("```mermaid");
	});

	it.each([
		["no graphics", null],
		["iTerm2", ImageProtocol.Iterm2],
	] as const)("uses existing Markdown ASCII for FigureMarkdown with %s", async (_name, protocol) => {
		setTerminalImageProtocol(protocol);
		const changes = new Changes();
		const text = fence(NORMAL);
		const component = figure(text, changes);
		const rows = await settle(component, changes);
		expect(rows).toEqual(new Markdown(text, 1, 0, getMarkdownTheme()).render(80));
		expect(hasImage(rows)).toBe(false);
		expectNormalAscii(rows);
		expect(component.pending).toBe(false);
	});

	it("keeps unsupported-graphics, hidden-image and native assistant paths original-source/ASCII", async () => {
		for (const mode of ["no-graphics", "iTerm2", "hidden-images", "native"] as const) {
			setTerminalImageProtocol(
				mode === "no-graphics" ? null : mode === "iTerm2" ? ImageProtocol.Iterm2 : ImageProtocol.Kitty,
			);
			setNativeRendering(mode === "native");
			const changes = new Changes();
			const text = fence(NORMAL);
			const original = message(text);
			const component = assistant(original, changes);
			if (mode === "hidden-images") component.setImagesVisible(false);
			const rows = component.render(80);
			await Promise.resolve();
			expect(hasImage(rows)).toBe(false);
			expect(component.isTranscriptBlockPending()).toBe(false);
			expectNormalAscii(rows);
			expect(component.describe().c).toContainEqual(expect.objectContaining({ k: "md", p: { text } }));
			expect(original.content).toEqual([{ type: "text", text }]);
			component.dispose();
		}
	});

	it("keeps streaming and cancelled unclosed fences as prose and holds a closed fence pending until its raster lands", async () => {
		const changes = new Changes();
		const component = assistant(undefined, changes);
		const open = `Before.\n\n\`\`\`mermaid\n${NORMAL}`;
		component.updateContent(message(open), { transient: true });
		const streaming = component.render(80);
		await Promise.resolve();
		expect(hasImage(streaming)).toBe(false);
		expect(component.isTranscriptBlockPending()).toBe(false);
		component.updateContent({ ...message(open), stopReason: "aborted" });
		component.markTranscriptBlockFinalized();
		expect(hasImage(component.render(80))).toBe(false);
		expect(component.isTranscriptBlockPending()).toBe(false);

		const completed = assistant(undefined, changes);
		completed.updateContent(message(`${open}\`\`\``), { transient: true });
		completed.markTranscriptBlockFinalized();
		expect(completed.isTranscriptBlockFinalized()).toBe(true);
		expect(completed.isTranscriptBlockPending()).toBe(true);
		const rows = await settle(completed, changes);
		expect(hasImage(rows)).toBe(true);
		expect(completed.isTranscriptBlockPending()).toBe(false);
	});

	it("falls back for invalid source and cannot resurrect a replaced or disposed queued diagram", async () => {
		const changes = new Changes();
		const component = figure(fence(NORMAL), changes);
		component.setText(fence("not a diagram {{{\n"));
		const failed = await settle(component, changes);
		expect(hasImage(failed)).toBe(false);
		expect(plain(failed)).toContain("not a diagram {{{");
		expect(component.pending).toBe(false);

		const disposedChanges = new Changes();
		const disposed = figure(fence(TINY), disposedChanges);
		disposed.dispose();
		await Promise.resolve();
		expect(disposedChanges.version).toBe(0);
		expect(disposed.pending).toBe(false);
	});

	it("keeps SVG and table figures in their authored order alongside prose", async () => {
		setTableCharts("always");
		const changes = new Changes();
		const table = `| Section | Time |
|---|---|
| generate_analysis | **10879 ms (98.6%)** |
| git_commit | 20.5 ms |
| collect_context | 1.2 s |
| everything else | <10 ms each |`;
		const component = figure(`Before.\n\n\`\`\`svg\n${SVG}\n\`\`\`\n\n${table}\n\nAfter.`, changes, undefined, true);
		const rows = await settle(component, changes);
		const rendered = rows.map(row => Bun.stripANSI(row));
		const tableStart = rendered.findIndex(row => row.includes("Section"));
		const tableEnd = rendered.findLastIndex(row => row.includes("everything else"));
		const after = rendered.findIndex(row => row.includes("After."));
		expect(tableStart).toBeGreaterThan(0);
		expect(tableEnd).toBeGreaterThan(tableStart);
		expect(after).toBeGreaterThan(tableEnd);
		// Require each real figure branch, rather than an aggregate protocol-line count.
		expect(hasImage(rows.slice(0, tableStart))).toBe(true);
		expect(hasImage(rows.slice(tableEnd + 1, after))).toBe(true);
		expect(component.pending).toBe(false);
		expect(plain(rows)).toContain("Before.");
	});

	it("intentionally preserves tool-fence Mermaid ASCII behavior independently of image visibility and renderSvg", () => {
		setSvgFigureRendering(false);
		const authored = { lang: "mermaid", source: NORMAL, closed: true } satisfies ToolFigure;
		expect(FenceFigure.draws(authored, { showImages: false })).toBe(true);
		const component = new FenceFigure("mermaid", { onChange: () => {} });
		mounted.add(component);
		component.update(authored);
		const rows = component.render(80);
		expect(hasImage(rows)).toBe(false);
		expect(plain(rows)).toContain("Start");
		expect(plain(rows)).not.toContain("```mermaid");
		expect(component.pending).toBe(false);
		expect(FenceFigure.draws({ ...authored, closed: false }, { showImages: true })).toBe(false);
		setMarkdownMermaidRendering(false);
		expect(FenceFigure.draws(authored, { showImages: true })).toBe(false);
	});
});
