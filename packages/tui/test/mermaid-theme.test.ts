import { inflateSync } from "node:zlib";
import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { MermaidFigure } from "@oh-my-pi/pi-tui/chat/mermaid-figure";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { relativeLuminance, rgbToHex } from "@oh-my-pi/pi-utils/color";
import { descendants, parseXml, type XmlElement } from "@oh-my-pi/pi-utils/docx/xml";
import * as pele from "pele";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const SOURCE = `flowchart TD
subgraph Workflow
 A([Request]) --> B[Plan]
 B --> C{Review?}
 C --> D[(Store)]
 D --> E[Authored]
end
style E fill:#ff0066,stroke:#00aaff,color:#123456
`;

/** Only reads the native renderer's one-pixel RGBA PNG, not a general PNG decoder. */
function pixel(png: Uint8Array): string {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	if (view.getUint32(16) !== 1 || view.getUint32(20) !== 1 || png[24] !== 8 || png[25] !== 6) {
		throw new Error("Expected a one-pixel RGBA PNG");
	}
	const chunks: Uint8Array[] = [];
	for (let offset = 8; offset < png.length;) {
		const length = view.getUint32(offset);
		if (view.getUint32(offset + 4) === 0x49444154) chunks.push(png.subarray(offset + 8, offset + 8 + length));
		offset += length + 12;
	}
	// All PNG filter predictors are zero for the first pixel of the first row.
	const rgba = inflateSync(Buffer.concat(chunks));
	expect(rgba[4]).toBe(255);
	return rgbToHex({ r: rgba[1]!, g: rgba[2]!, b: rgba[3]! });
}

function node(root: XmlElement, id: string): XmlElement {
	const found = descendants(root, "g").find(element => element.attributes.get("data-id") === id);
	if (!found) throw new Error(`Missing node ${id}`);
	return found;
}

async function fillAt(svg: string, id: string): Promise<string> {
	const element = node(parseXml(svg), id);
	const position = /translate\(([-\d.]+)[, ]+([-\d.]+)\)/.exec(element.attributes.get("transform") ?? "");
	if (!position) throw new Error(`Missing position for ${id}`);
	const x = Number(position[1]);
	const y = Number(position[2]) - 12; // Inside every shape, above the label's ink.
	const crop = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="${x} ${y} 1 1">${svg}</svg>`;
	return pixel(await natives.rasterizeSvg(new TextEncoder().encode(crop), 1, 1, 1));
}

function geometry(svg: string): [string, [string, string][]][] {
	const root = parseXml(svg);
	return ["g", "rect", "polygon", "path", "text"].flatMap(name =>
		descendants(root, name).map(
			element =>
				[
					name,
					[...element.attributes].filter(([key]) => /^(?:x|y|width|height|rx|ry|d|points|transform)$/.test(key)),
				] as [string, [string, string][]],
		),
	);
}

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	vi.restoreAllMocks();
});

it("paints distinct readable default node categories in light and dark without moving shapes or overriding authored paint", async () => {
	const previousTheme = theme;
	const protocol = TERMINAL.imageProtocol;
	const cell = getCellDimensions();
	const rasterize = natives.rasterizeSvg;
	let captured = "";
	vi.spyOn(natives, "rasterizeSvg").mockImplementation(async (...args) => {
		if (!captured) captured = new TextDecoder().decode(args[0]);
		return rasterize(...args);
	});
	const natural = pele.render(SOURCE, {
		fontSize: 14,
		fontFamily: "sans-serif",
		responsive: false,
		autoDirection: false,
	});
	try {
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		for (const name of ["dark", "light"]) {
			const nextTheme = await getThemeByName(name);
			if (!nextTheme) throw new Error(`Missing ${name} theme`);
			setThemeInstance(nextTheme);
			captured = "";
			let changed = Promise.withResolvers<void>();
			const figure = new MermaidFigure({ onChange: () => changed.resolve() });
			try {
				figure.update(SOURCE, true);
				await changed.promise;
				changed = Promise.withResolvers<void>();
				figure.render(120);
				await changed.promise;
				const svg = captured;
				const fills = await Promise.all(["A", "B", "C", "D"].map(id => fillAt(svg, id)));
				expect(new Set(fills).size).toBe(4);
				for (const fill of fills) {
					const foreground = relativeLuminance(nextTheme.getColorHex("text"))!;
					const background = relativeLuminance(fill)!;
					expect(
						(Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
					).toBeGreaterThanOrEqual(4.5);
				}
				expect(await fillAt(svg, "E")).toBe("#ff0066");
				expect(geometry(svg)).toEqual(geometry(natural.svg));
			} finally {
				figure.dispose();
			}
		}
	} finally {
		setThemeInstance(previousTheme);
		setTerminalImageProtocol(protocol);
		setCellDimensions(cell);
	}
});
