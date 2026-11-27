/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { clearCopiedCode, markCodeCopied, setCodeCopyEnabled, setLinkSchemes } from "@oh-my-pi/pi-tui/term/painters/md";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { CODE_COPY_ACT_PREFIX, codeBlockHash, renderMarkdown } from "../../src/text/markdown";
import { loadThemeSync } from "../../src/theme";

const theme = loadThemeSync("dark");

test("md paints its source at the block width and repaints as the source grows", () => {
	const text = signal("# Title\n\nSome **bold** text and [a link](https://e.com/x");
	const env = staticEnvironment(theme);
	const tree = <md text={text} stream />;
	expect(renderBlock(tree as never, 30, { env }).rows).toEqual(renderMarkdown(text(), 30, { theme, stream: true }));
	text.set(`${text()}).\n\n- item`);
	expect(renderBlock(tree as never, 30, { env }).rows).toEqual(renderMarkdown(text(), 30, { theme, stream: true }));
});

test("md draws nothing for blank text", () => {
	const env = staticEnvironment(theme);
	expect(renderBlock((<md text="  " />) as never, 30, { env }).rows).toEqual([]);
});

test("md draws registered link schemes as labels whose cells are hits carrying the href", () => {
	const env = staticEnvironment(theme);
	const tree = <md text="Open [the demo](demo:x) now" />;
	expect(renderBlock(tree as never, 40, { env }).rows[0]).toContain("(demo:x)");
	setLinkSchemes(["demo"]);
	try {
		const block = renderBlock(tree as never, 40, { env });
		expect(block.rows[0]).not.toContain("\x1b]8;");
		expect(block.rows[0]!.replace(/\x1b\[[\d;:]*m/g, "").trimEnd()).toBe("Open the demo now");
		expect(block.hits?.map(({ row, col, width, item }) => ({ row, col, width, item }))).toEqual([
			{ row: 0, col: 5, width: 8, item: "demo:x" },
		]);
	} finally {
		setLinkSchemes([]);
	}
});

test("md draws clickable code-copy buttons with action hits and reactive [Copied] feedback", () => {
	const env = staticEnvironment(theme);
	const code = "const x = 1;  ";
	const tree = <md text={`\`\`\`ts\n${code}\n\`\`\``} />;
	setCodeCopyEnabled(true);
	try {
		const hash = codeBlockHash(code);
		const block = renderBlock(tree as never, 40, { env });
		expect(block.rows[0]).not.toContain("\x1b]8;");
		expect(block.rows[0]!.replace(/\x1b\[[\d;:]*m/g, "").trimEnd()).toBe(`\`\`\`ts${" ".repeat(29)}[Copy]`);
		expect(block.hits?.map(({ row, col, width, act }) => ({ row, col, width, act }))).toEqual([
			{ row: 0, col: 34, width: 6, act: `${CODE_COPY_ACT_PREFIX}${hash}` },
		]);

		markCodeCopied(hash, 0);
		const copied = renderBlock(tree as never, 40, { env });
		expect(copied.rows[0]!.replace(/\x1b\[[\d;:]*m/g, "").trimEnd()).toBe(`\`\`\`ts${" ".repeat(27)}[Copied]`);
		expect(copied.hits?.map(({ row, col, width, act }) => ({ row, col, width, act }))).toEqual([
			{ row: 0, col: 32, width: 8, act: `${CODE_COPY_ACT_PREFIX}${hash}` },
		]);
	} finally {
		clearCopiedCode();
		setCodeCopyEnabled(false);
	}
});
