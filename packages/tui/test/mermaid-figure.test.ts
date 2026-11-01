import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { MermaidFigure, resolveMermaidDiagram } from "@oh-my-pi/pi-tui/chat/mermaid-figure";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { descendants, parseXml, type XmlElement, type XmlNode } from "@oh-my-pi/pi-utils/docx/xml";
import * as pele from "pele";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };

/** Keep invalid/source fallback assertions independent of the optional ASCII adapter. */
function sourceMarkdown(text: string): Markdown {
	return new Markdown(text, 0, 0, { ...getMarkdownTheme(), resolveMermaidAscii: undefined });
}

/** Kitty placement is the actual image box reserved in the terminal, not a layout estimate. */
function placementRows(rows: readonly string[]): number {
	const match = /c=(\d+),r=(\d+)/.exec(rows.join("\n"));
	if (!match) throw new Error("No Kitty image placement");
	return Number(match[2]);
}

function svgNode(svg: XmlElement, id: string): XmlElement {
	const node = descendants(svg, "g").find(element => element.attributes.get("data-id") === id);
	if (!node) throw new Error(`SVG has no node ${id}`);
	return node;
}

/** Decode XML once, treating positioned line breaks as whitespace, not inline span boundaries. */
function svgLabel(node: XmlElement): string {
	let previousY: number | undefined;
	const text = (child: XmlNode): string => {
		if (child.kind === "text") return child.value;
		const y = child.attributes.get("y");
		const nextY = y === undefined ? previousY : Number(y);
		const newLine =
			(nextY !== undefined && previousY !== undefined && nextY !== previousY) ||
			Number(child.attributes.get("dy") ?? 0) !== 0;
		previousY = nextY;
		return (newLine ? " " : "") + child.children.map(text).join("");
	};
	return descendants(node, "text").map(text).join(" ").replace(/\s+/g, " ").trim();
}

/** Inline CSS overrides presentation attributes independently of declaration/attribute ordering. */
function svgProperty(element: XmlElement, property: string): string | undefined {
	let value = element.attributes.get(property);
	for (const declaration of (element.attributes.get("style") ?? "").split(";")) {
		const colon = declaration.indexOf(":");
		if (declaration.slice(0, colon).trim() === property) value = declaration.slice(colon + 1).trim();
	}
	return value;
}

function repeatLines(count: number, line: (index: number) => string): string {
	return Array.from({ length: count }, (_, index) => line(index)).join("\n");
}

describe("source-preserving Mermaid figures", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCell: CellDimensions;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		originalCell = { ...getCellDimensions() };
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions(CELL);
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
		setKittyGraphics(originalGraphics);
	});

	it("preserves CSS-variable expressions as literal diagram labels while resolving paint", () => {
		const diagram = resolveMermaidDiagram('flowchart LR\n Literal["var(--fg) + var(--missing, red)"]')!;
		const prepared = parseXml(prepareSvg(diagram.svg, { fg: "#eeeeee", accent: "#ff8800" }));
		expect(svgLabel(svgNode(prepared, "Literal"))).toBe("var(--fg) + var(--missing, red)");
		expect(prepared.attributes.get("fill")).toBe("#eeeeee");
	});

	it("enforces the source limit in UTF-8 bytes at the multibyte boundary", () => {
		const syntax = "%% \nflowchart LR\n ByteA[Within budget] --> ByteB[Done]";
		const remaining = 64 * 1024 - Buffer.byteLength(syntax);
		const comment = "界".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
		const source = syntax.replace("%% ", `%% ${comment}`);
		expect(Buffer.byteLength(source)).toBe(64 * 1024);
		const accepted = resolveMermaidDiagram(source)!;
		expect(svgLabel(svgNode(parseXml(accepted.svg), "ByteA"))).toBe("Within budget");
		const oversized = `${source}\n%% 界`;
		expect(oversized.length).toBeLessThan(64 * 1024);
		expect(resolveMermaidDiagram(oversized)).toBeNull();
	});

	it("preserves decoded label words across wrapping, original source, authored styles and late-bound themes", () => {
		const source =
			'%% authored-style regression\r\nflowchart LR\r\n A["Original & label"] --> B[Done]\r\n classDef authored fill:#ff0066,stroke:#00aaff,color:#123456,font-weight:bold,font-size:28px\r\n class A authored\r\n';
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("Styled graph did not resolve");
		expect(diagram.source).toBe(source);
		const svg = parseXml(diagram.svg);
		const authored = svgNode(svg, "A");
		const shape = descendants(authored, "rect")[0];
		const label = descendants(authored, "text")[0];
		if (!shape || !label) throw new Error("Styled node has no shape or label");
		// Pele may wrap at the authored 28px font size. The words and decoded
		// ampersand must survive; their XML escaping and text-span boundaries need not.
		expect(svgLabel(authored)).toBe("Original & label");
		expect(svgLabel(svgNode(svg, "B"))).toBe("Done");
		expect(svgProperty(shape, "fill")).toBe("#ff0066");
		expect(svgProperty(shape, "stroke")).toBe("#00aaff");
		expect(svgProperty(label, "fill")).toBe("#123456");
		expect(svgProperty(label, "font-weight")).toBe("bold");
		expect(svgProperty(label, "font-size")).toBe("28px");
		expect(Number.parseFloat(svgProperty(svg, "font-size") ?? "")).toBe(14);
		const dark = prepareSvg(diagram.svg, { fg: "#eeeeee", surface: "#111111", muted: "#aaaaaa", border: "#888888" });
		const light = prepareSvg(diagram.svg, { fg: "#111111", surface: "#eeeeee", muted: "#555555", border: "#777777" });
		const darkSvg = parseXml(dark);
		const lightSvg = parseXml(light);
		expect(svgProperty(darkSvg, "fill")).toBe("#eeeeee");
		expect(svgProperty(lightSvg, "fill")).toBe("#111111");
		for (const prepared of [darkSvg, lightSvg]) {
			const node = svgNode(prepared, "A");
			const preparedShape = descendants(node, "rect")[0];
			const preparedLabel = descendants(node, "text")[0];
			if (!preparedShape || !preparedLabel) throw new Error("Prepared node has no shape or label");
			expect(svgLabel(node)).toBe("Original & label");
			expect(svgProperty(preparedShape, "fill")).toBe("#ff0066");
			expect(svgProperty(preparedShape, "stroke")).toBe("#00aaff");
			expect(svgProperty(preparedLabel, "fill")).toBe("#123456");
			expect(svgProperty(preparedLabel, "font-weight")).toBe("bold");
			expect(svgProperty(preparedLabel, "font-size")).toBe("28px");
		}
		expect(dark).not.toContain("var(");
		expect(light).not.toContain("var(");
	});

	it("does not turn authored links and remote images into active SVG resources", () => {
		const source = `flowchart LR
 A@{ img: "https://untrusted.example/image.png", label: "Remote node", w: 60, h: 60 } --> B[Safe]
 click A "https://untrusted.example/open"
`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("Graph with disabled resources did not resolve");
		expect(diagram.svg).not.toMatch(/<(?:a|image)\b|\b(?:xlink:)?href=/);
		expect(diagram.source).toContain("https://untrusted.example/image.png");
	});

	it("rejects invalid source, oversized source and expanded edge limits while preserving the original fallback", async () => {
		const invalid = "flowchart LR\n Invalid[unterminated fallback";
		expect(resolveMermaidDiagram(invalid)).toBeNull();
		const oversized = `flowchart LR\n%% ${"x".repeat(64 * 1024)}`;
		expect(resolveMermaidDiagram(oversized)).toBeNull();
		const left = Array.from({ length: 26 }, (_, index) => `Left${index}`).join(" & ");
		const right = Array.from({ length: 26 }, (_, index) => `Right${index}`).join(" & ");
		expect(resolveMermaidDiagram(`flowchart LR\n ${left} --> ${right}`)).toBeNull();

		const figure = new MermaidFigure({ onChange: () => {}, markdown: sourceMarkdown });
		try {
			figure.update(invalid, true);
			await Promise.resolve();
			const rendered = figure.render(100);
			expect(figure.render(100)).toEqual(rendered);
			expect(figure.pending).toBe(false);
			expect(rendered.some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(rendered).toEqual(sourceMarkdown(`\`\`\`mermaid\n${invalid}\n\`\`\``).render(100));
		} finally {
			figure.dispose();
		}
	});

	it.each([
		["class", `classDiagram\n${repeatLines(513, index => `A --> B : link${index}`)}`],
		["er", `erDiagram\n${repeatLines(513, index => `A ||--o{ B : link${index}`)}`],
		[
			"c4",
			`C4Context\nPerson(a, "A")\n${repeatLines(
				513,
				index => `Person(b${index}, "B ${index}")\nRel(a, b${index}, "link${index}")`,
			)}`,
		],
		["sankey", `sankey-beta\n${repeatLines(513, () => "A,B,1")}`],
		["state", `stateDiagram-v2\nstate Outer {\n${repeatLines(513, index => `A --> B : nested${index}`)}\n}`],
		["sequence", `sequenceDiagram\n${repeatLines(513, index => `A->>B: signal${index}`)}`],
		["gitGraph", `gitGraph\n${repeatLines(514, index => `commit id: "revision${index}"`)}`],
		["journey", `journey\nsection Steps\n${repeatLines(514, index => `Step${index}: 3: Actor`)}`],
		["timeline", `timeline\nPeriod\n${repeatLines(513, index => `: event${index}`)}`],
		["mindmap", `mindmap\n Root\n${repeatLines(513, index => `  Child${index}`)}`],
		["treeView", `treeView-beta\nroot/\n${repeatLines(513, index => `    child${index}`)}`],
		["ishikawa", `ishikawa\nEffect\n${repeatLines(513, index => ` Cause${index}`)}`],
		[
			"railroad",
			`railroad-beta\nRule = sequence(${Array.from({ length: 128 }, () => 'optional(terminal("x"))').join(",")});`,
		],
	])("rejects parsed %s diagrams with more than 512 relationships", (kind, source) => {
		expect(source.length).toBeLessThan(64 * 1024);
		expect(resolveMermaidDiagram(source)).toBeNull();
		// The real parser must accept the fixture; unsupported syntax would
		// otherwise satisfy the same null-result assertion.
		expect(pele.parse(source)).toMatchObject({ type: kind });
	});

	it("renders 512 class relationships without counting arrow-looking comments or labels", () => {
		const source = `%% ${"A --> B ".repeat(600)}\r\nclassDiagram\r\n${repeatLines(
			512,
			index => `A --> B : link${index} --> literal`,
		).replaceAll("\n", "\r\n")}\r\n`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit class relationships did not resolve");
		expect(diagram.source).toBe(source);
		expect(diagram.svg).toContain("link511");
	});

	it("renders exactly 512 expanded flowchart relationships but rejects another fan-out", () => {
		const left = Array.from({ length: 16 }, (_, index) => `BoundaryLeft${index}`).join(" & ");
		const right = Array.from({ length: 32 }, (_, index) => `BoundaryRight${index}`).join(" & ");
		const diagram = resolveMermaidDiagram(`flowchart LR\n${left} --> ${right}`);
		if (!diagram) throw new Error("At-limit expanded flowchart did not resolve");
		expect(diagram.svg).toContain("BoundaryRight31");
		expect(resolveMermaidDiagram(`flowchart LR\n${left} --> ${right} & BoundaryRight32`)).toBeNull();
	});

	it("does not charge sequence notes, activation or control frames against 512 signal relationships", () => {
		const source = `sequenceDiagram
autonumber
participant A
participant B
activate A
loop Control frame, not a signal
${repeatLines(512, index => `A->>B: boundaryMessage${index}`)}
end
deactivate A
note over A,B: literal --> note, not a signal
`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit sequence signals did not resolve");
		expect(diagram.svg).toContain("boundaryMessage511");
		expect(diagram.source).toBe(source);
	});

	it("allows 512 railroad connections after expanding optional bypass tracks", () => {
		const elements = Array.from({ length: 127 }, () => 'optional(terminal("x"))');
		elements.push('terminal("a")', 'terminal("b")', 'terminal("c")');
		const source = `railroad-beta\nBoundaryRule = sequence(${elements.join(",")});`;
		const diagram = resolveMermaidDiagram(source);
		if (!diagram) throw new Error("At-limit expanded railroad tracks did not resolve");
		expect(diagram.svg).toContain("BoundaryRule");
		expect(diagram.source).toBe(source);
	});

	it("keeps a complete tall graph while bounding its terminal preview to the viewport", async () => {
		const source = `flowchart TD\n${Array.from(
			{ length: 140 },
			(_, index) => `N${index}[Step ${index}] --> N${index + 1}[Step ${index + 1}]`,
		).join("\n")}`;
		let changed = Promise.withResolvers<void>();
		const figure = new MermaidFigure({
			markdown: sourceMarkdown,
			onChange: () => changed.resolve(),
		});
		try {
			figure.update(source, true);
			await changed.promise;
			const diagram = resolveMermaidDiagram(source);
			if (!diagram) throw new Error("Tall graph did not resolve");
			expect(diagram?.height).toBeGreaterThan(8000);
			expect(diagram?.svg).toContain("Step 140");
			expect(diagram?.source).toBe(source);
			changed = Promise.withResolvers<void>();
			figure.render(100);
			await changed.promise;
			const rows = figure.render(100);
			expect(placementRows(rows)).toBeLessThanOrEqual(Math.max(1, Math.floor((process.stdout.rows || 24) * 0.8)));
			expect(figure.pending).toBe(false);
		} finally {
			figure.dispose();
		}
	});

	it("keeps streaming source as Markdown and displays only the latest completed revision", async () => {
		let changed = Promise.withResolvers<void>();
		const figure = new MermaidFigure({
			markdown: sourceMarkdown,
			onChange: () => {
				changed.resolve();
				changed = Promise.withResolvers<void>();
			},
		});
		try {
			const streaming = "flowchart LR\n A[Streaming engine fixture] -->";
			figure.update(streaming, false);
			expect(figure.render(100)).toEqual(sourceMarkdown(`\`\`\`mermaid\n${streaming}\n\`\`\``).render(100));
			await Promise.resolve();
			expect(figure.pending).toBe(false);
			figure.update("flowchart LR\n A[Superseded complete] --> B", true);
			figure.update("flowchart LR\n A[Latest complete] --> C", true);
			let rows: readonly string[];
			for (;;) {
				const next = changed.promise;
				rows = figure.render(100);
				if (!figure.pending) break;
				await next;
			}
			expect(rows.some(row => TERMINAL.isImageLine(row))).toBe(true);
			setTerminalImageProtocol(null);
			const fallback = Bun.stripANSI(figure.render(100).join("\n"));
			expect(fallback).toContain("A[Latest complete] --> C");
			expect(fallback).not.toContain("Superseded complete");
			expect(fallback).not.toContain("Streaming engine fixture");
		} finally {
			figure.dispose();
		}
	});

	it("discards a native raster that lands after its Mermaid view was disposed", async () => {
		const png = await natives.rasterizeSvg(
			new TextEncoder().encode('<svg width="10" height="20"><rect width="10" height="20" fill="red"/></svg>'),
			10,
			20,
			1,
		);
		const delayed = Promise.withResolvers<Uint8Array>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(natives, "rasterizeSvg").mockImplementation(() => {
			started.resolve();
			return delayed.promise;
		});
		let notifications = 0;
		const figure = new MermaidFigure({
			onChange: () => {
				notifications++;
			},
		});
		figure.update("flowchart LR\n A[Late-raster disposal fixture] --> B", true);
		await Promise.resolve();
		figure.render(100);
		await started.promise;
		const notificationsBeforeDisposal = notifications;
		figure.dispose();
		delayed.resolve(png);
		await delayed.promise;
		await Promise.resolve();
		expect(figure.render(100)).toEqual([]);
		expect(figure.pending).toBe(false);
		expect(notifications).toBe(notificationsBeforeDisposal);
	});
});
