import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import {
	extensionLinkAt,
	restyleExtensionLink,
	setExtensionLinks,
	stripExtensionLinkMarkers,
} from "@oh-my-pi/pi-tui/render/extension-links";
import { setTerminalTextSizing } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

// The registry is process-wide: start and leave every test with nothing claimed.
beforeEach(() => {
	setExtensionLinks([], false);
});
afterEach(() => {
	setExtensionLinks([], false);
});

const render = (text: string, width = 80) => new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
const plain = (line: string) => Bun.stripANSI(line);

/** Every cell of `rows` mapped to the extension link drawn there, as `row:col=url` runs. */
function linkCells(rows: readonly string[]): string[] {
	const runs: string[] = [];
	rows.forEach((row, index) => {
		const width = Bun.stringWidth(row);
		let open: { start: number; url: string } | undefined;
		for (let col = 0; col <= width; col++) {
			const url = col < width ? extensionLinkAt(row, col) : undefined;
			if (url === open?.url) continue;
			if (open) runs.push(`${index}:${open.start}-${col - 1}=${open.url}`);
			open = url === undefined ? undefined : { start: col, url };
		}
	});
	return runs;
}

describe("extension-owned links", () => {
	const text = "Open [the details](demo:open/7) or [the docs](https://example.com/docs).";

	it("draws exactly as any other link while no extension claims the scheme", () => {
		expect(plain(render(text)[0]!)).toContain("the details (demo:open/7)");
	});

	it("drops the URL suffix for a claimed scheme and leaves other links alone", () => {
		setExtensionLinks(["demo"], false);
		const row = plain(render(text)[0]!);
		expect(row).toContain("Open the details or the docs (https://example.com/docs).");
		// Without click routing there is nothing to hit-test, and no hyperlink the terminal could open.
		expect(render(text)[0]).not.toContain("demo:open/7");
	});

	it("maps exactly the label's cells to the URL while clicks are routed, across a wrapped label", () => {
		setExtensionLinks(["demo"], true);
		expect(linkCells(render(text))).toEqual(["0:5-15=demo:open/7"]);

		const wrapped = render("Some words before [a much longer link label](demo:open/8) after", 30);
		const rows = wrapped.map(plain);
		const cells = linkCells(wrapped);
		// Each run covers the label text on its row, nothing else.
		for (const run of cells) {
			const [, rowIndex, start, end] = /^(\d+):(\d+)-(\d+)=/.exec(run)!;
			expect("a much longer link label").toContain(rows[Number(rowIndex)]!.slice(Number(start), Number(end) + 1));
		}
		expect(cells.length).toBe(2);
		expect(cells.every(run => run.endsWith("=demo:open/8"))).toBe(true);
	});

	it("strips only omp's link markers from what the terminal receives, even once unclaimed", () => {
		setExtensionLinks(["demo"], true);
		const rows = render(
			"Some words before [a much longer link label](demo:open/8) then [docs](https://example.com)",
			30,
		);
		const out = rows.map(stripExtensionLinkMarkers);
		expect(out.join("")).not.toContain("demo:open/8");
		expect(out.join("|")).toContain("https://example.com");
		expect(out.map(plain)).toEqual(rows.map(plain));
		// The unstripped rows still locate the click.
		expect(linkCells(rows).length).toBe(2);
		// A row drawn while the scheme was claimed must not leak its URL after the claim is gone.
		setExtensionLinks([], false);
		expect(rows.map(stripExtensionLinkMarkers)).toEqual(out);
		// A hyperlink omp did not mark is kept, whatever its scheme.
		const foreign = "See \x1b]8;;demo:open/7\x07the details\x1b]8;;\x07.";
		expect(stripExtensionLinkMarkers(foreign)).toBe(foreign);
	});

	it("stops matching rows drawn for a scheme that is no longer claimed", () => {
		setExtensionLinks(["demo"], true);
		const rows = render(text);
		setExtensionLinks(["other"], true);
		expect(linkCells(rows)).toEqual([]);
	});

	it("redraws a live streaming reply's links when click routing turns on", () => {
		const streaming = new Markdown("", 0, 0, getMarkdownTheme());
		streaming.transientRenderCache = true;
		const first = `${text}\n\nSecond paragraph`;
		setExtensionLinks(["demo"], false);
		streaming.setText(first);
		streaming.render(80);
		setExtensionLinks(["demo"], true);
		// Same text and width: the per-instance cache must not hand back the unrouted rows.
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
		setExtensionLinks(["demo"], false);
		streaming.render(80);
		setExtensionLinks(["demo"], true);
		// Grown text: the streamed prefix rows were drawn unrouted and must be redrawn.
		streaming.setText(`${first} grows.\n\nThird`);
		expect(linkCells(streaming.render(80))).toEqual(["0:5-15=demo:open/7"]);
	});

	it("keeps a sized H1 heading's extension link clickable", () => {
		setExtensionLinks(["demo"], true);
		setTerminalTextSizing(true);
		try {
			expect(linkCells(render("# Open [the details](demo:open/7)"))).toEqual(["0:5-15=demo:open/7"]);
			// A heading with no extension link is still drawn sized.
			expect(render("# Open the details")[0]).toContain("\x1b]66;");
		} finally {
			setTerminalTextSizing(false);
		}
	});

	it("highlights only the hovered link's label, on every row a wrapped label reaches", () => {
		setExtensionLinks(["demo"], true);
		const mark = (label: string) => `[${Bun.stripANSI(label)}]`;
		const rows = render("Some words [a much longer link label](demo:open/8) and [other](demo:open/9) end", 30);
		const hovered = rows.map(row => Bun.stripANSI(restyleExtensionLink(row, "demo:open/8", mark)));
		// Each row's part of the wrapped label is highlighted, and nothing else.
		expect(hovered.join("|").match(/\[[^\]]*\]/g)).toEqual(["[a much longer link]", "[label]"]);
		// The highlight leaves the click mapping intact.
		const restyled = rows.map(row => restyleExtensionLink(row, "demo:open/8", label => `\x1b[7m${label}\x1b[27m`));
		expect(linkCells(restyled)).toEqual(linkCells(rows));
		// A link whose scheme is not claimed is never restyled.
		const web = render("[docs](https://example.com)")[0]!;
		expect(restyleExtensionLink(web, "https://example.com", mark)).toBe(web);
	});
});
