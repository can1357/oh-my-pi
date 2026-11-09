import { afterEach, beforeEach, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "../src/components/markdown";
import { ImageBudget, withImageRenderContext } from "../src/components/image";
import { releaseMathImageOwner, withMathImageOwner } from "../src/components/math-image";
import { setMathImageRenderer } from "../src/math-image-renderer";
import { setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { initThemeSync } from "../src/theme/theme";
import { defaultMarkdownTheme } from "./test-themes";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { getCellDimensions, setCellDimensions } from "../src/terminal-capabilities";
import { theme } from "../src/theme/theme";
import { spyOn } from "bun:test";
import { getMarkdownTheme } from "../src/theme/theme";
import { setInlineImageMaxColumns } from "../src/render/render-utils";
import { directPlacementLift, parseKittyDirectPlacementLine } from "../src/terminal-capabilities";
withoutTerminalMultiplexer();
const graphics = getKittyGraphics();

const protocol = TERMINAL.imageProtocol;
let markdown: Markdown;
let completion = Promise.withResolvers<void>();
let budget: ImageBudget;
const svg = {
	svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="1ex" height="1ex"><rect width="10" height="10" fill="white"/></svg>',
	widthEx: 1,
	heightEx: 1,
};
function render(width = 80) {
	budget.beginPass();
	try {
		return withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
			withMathImageOwner(
				markdown,
				() => completion.resolve(),
				() => markdown.render(width),
			),
		);
	} finally {
		budget.endPass();
	}
}
beforeEach(() => {
	initThemeSync();
	completion = Promise.withResolvers<void>();
	budget = new ImageBudget(16, () => {});
	TERMINAL.imageProtocol = ImageProtocol.Kitty;
	setChatTranscriptDisplayPreferences({ renderMath: true, showImages: true });
	setMathImageRenderer({ id: "markdown-contract", render: () => svg });
	markdown = new Markdown("before\n\n$$x+y=1$$\n\nafter", 0, 0, defaultMarkdownTheme);
});
beforeEach(() => setKittyGraphics({ unicodePlaceholders: true }));
afterEach(() => {
	releaseMathImageOwner(markdown);
	setMathImageRenderer(undefined);
	setChatTranscriptDisplayPreferences({ renderMath: false });
	TERMINAL.imageProtocol = protocol;
});
afterEach(() => setKittyGraphics(graphics));
it("replaces display in place after pending fallback and preserves source", async () => {
	expect(render().join("\n")).toContain("x+y=1");
	expect(markdown.mathImagesPending).toBe(true);
	expect(markdown.getMathImageStableSource()).toBe("before\n\n");
	await completion.promise;
	const rows = render();
	expect(rows.join("\n")).not.toContain("x+y=1");
	expect(rows[0]).toContain("before");
	expect(rows.at(-1)).toContain("after");
	expect(render()).toBe(rows);
});
it("retains failed Unicode without retry and releases the source barrier", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "failure",
		render: () => {
			calls++;
			throw Error("bad formula");
		},
	});
	render();
	await completion.promise;
	expect(render().join("\n")).toContain("x+y=1");
	render();
	expect(calls).toBe(1);
	expect(markdown.getMathImageStableSource()).toBe("before\n\n$$x+y=1$$\n\nafter");
});
it("component opt-out and code do not schedule work", () => {
	let calls = 0;
	setMathImageRenderer({
		id: "excluded",
		render: () => {
			calls++;
			return svg;
		},
	});
	markdown.setMathImagesAllowed(false);
	render();
	markdown.setMathImagesAllowed(true).setText("`$x$`\n\n```tex\n$$x$$\n```");
	render();
	expect(markdown.mathImagesPending).toBe(false);
	expect(calls).toBe(0);
});
it("keeps inline punctuation and multiple formulas on the same row", async () => {
	markdown.setText("before $x+y=1$, after $z$!");
	render();
	await completion.promise;
	while (true) {
		completion = Promise.withResolvers<void>();
		render();
		if (!markdown.mathImagesPending) break;
		await completion.promise;
	}
	const rows = render();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toContain("before ");
	expect(rows[0]).toContain(", after ");
	expect(rows[0]).toContain("!");
	expect(rows[0]).not.toContain("x+y=1");
	expect(rows[0]).not.toContain("\x1b]66;");
});
it("inline unsupported transports remain Unicode without conversions", () => {
	markdown.setText("before $x+y=1$, after");
	TERMINAL.imageProtocol = ImageProtocol.Iterm2;
	expect(render()[0]).toContain("before x+y=1, after");
	expect(markdown.mathImagesPending).toBe(false);
});
it("narrow and tall inline formulas settle to Unicode", async () => {
	setMathImageRenderer({ id: "tall", render: () => ({ ...svg, heightEx: 4 }) });
	markdown.setText("before $x+y=1$, after");
	render(12);
	await completion.promise;
	expect(render(12).join("\n")).toContain("x+y=1");
	expect(markdown.mathImagesPending).toBe(false);
});
for (const protocol of [ImageProtocol.Kitty, ImageProtocol.Iterm2]) {
	it(`replaces nested display math in place on ${JSON.stringify(protocol)}`, async () => {
		TERMINAL.imageProtocol = protocol;
		markdown.setText("> - before\n>\n>   $$x+y=1$$\n>\n>   after");
		render();
		await completion.promise;
		const rows = render();
		expect(rows.join("\n")).not.toContain("x+y=1");
		expect(rows.join("\n")).toContain("before");
		expect(rows.join("\n")).toContain("after");
	});
}
it("global image policy restores Unicode on a cache hit", async () => {
	render();
	await completion.promise;
	expect(render().join("\n")).not.toContain("x+y=1");
	setChatTranscriptDisplayPreferences({ showImages: false });
	expect(render().join("\n")).toContain("x+y=1");
});
it("open speculative streaming math never schedules a raster", () => {
	markdown.transientRenderCache = true;
	markdown.setText("before $x+y");
	render();
	expect(markdown.mathImagesPending).toBe(false);
});
it("Sixel keeps Unicode until both raster and transport encoding settle", async () => {
	TERMINAL.imageProtocol = ImageProtocol.Sixel;
	render();
	await completion.promise;
	completion = Promise.withResolvers<void>();
	const first = render();
	while (markdown.mathImagesPending) {
		await completion.promise;
		completion = Promise.withResolvers<void>();
		render();
	}
	const rows = render();
	expect(rows.join("\n")).not.toContain("x+y=1");
	expect(rows.join("\n")).toContain("before");
	expect(rows.join("\n")).toContain("after");
	expect(first.length).toBeGreaterThan(0);
});
it("retypesets changed ink and cell geometry instead of replaying stale graphics", async () => {
	const requests: { inkHex: string; cellWidthPx: number; maxWidthPx: number }[] = [];
	setMathImageRenderer({
		id: "context",
		render: request => {
			requests.push(request);
			return svg;
		},
	});
	const originalCell = getCellDimensions();
	const ink = spyOn(theme, "getColorHex");
	try {
		ink.mockReturnValue("#ffffff");
		render();
		await completion.promise;
		render();
		completion = Promise.withResolvers<void>();
		ink.mockReturnValue("#ff0000");
		expect(render().join("\n")).toContain("x+y=1");
		await completion.promise;
		render();
		completion = Promise.withResolvers<void>();
		setCellDimensions({ widthPx: 12, heightPx: 24 });
		render(40);
		await completion.promise;
		render(40);
		expect(requests.map(request => request.inkHex)).toEqual(["#ffffff", "#ff0000", "#ff0000"]);
		expect(requests[2].cellWidthPx).toBe(12);
		expect(requests[2].maxWidthPx).toBe(480);
	} finally {
		ink.mockRestore();
		setCellDimensions(originalCell);
	}
});
it("replays frozen math placement across append-only streaming deltas", async () => {
	markdown.transientRenderCache = true;
	markdown.setText("before\n\n$$x$$\n\n" + "ordinary prose paragraph.\n\n".repeat(80) + "tail");
	render();
	await completion.promise;
	const image = render().find(row => TERMINAL.isImageLine(row));
	expect(image).toBeDefined();
	for (let i = 0; i < 10; i++) {
		markdown.setText(
			markdown.getMathImageStableSource() +
				"$$x$$\n\n" +
				"ordinary prose paragraph.\n\n".repeat(80) +
				"tail" +
				" more".repeat(i + 1),
		);
		expect(render().find(row => TERMINAL.isImageLine(row))).toBe(image);
	}
});
it("budget suppression selects only Unicode rather than generic image labels", async () => {
	render();
	await completion.promise;
	render();
	const admission = spyOn(budget, "observe").mockReturnValue(true);
	try {
		const rows = render().join("\n");
		expect(rows).toContain("x+y=1");
		expect(rows).not.toContain("[image:");
		expect(rows).not.toContain("\u{10eeee}");
	} finally {
		admission.mockRestore();
	}
});
it("tall own-line display after list prose is requested as display", async () => {
	const modes: boolean[] = [];
	setMathImageRenderer({
		id: "list-display",
		render: request => {
			modes.push(request.display);
			return { ...svg, heightEx: 4 };
		},
	});
	markdown.setText("- As $x$, it converges to the prior:\n  $$\\frac{a}{b}=q$$");
	render();
	await completion.promise;
	while (true) {
		completion = Promise.withResolvers<void>();
		render();
		if (!markdown.mathImagesPending) break;
		await completion.promise;
	}
	expect(modes).toContain(true);
	expect(render().filter(row => TERMINAL.isImageLine(row)).length).toBeGreaterThan(0);
});
it("feature off preserves existing inline Unicode soft-break shape", () => {
	setChatTranscriptDisplayPreferences({ renderMath: false });
	for (const source of [
		"As shown:\n$$\\frac{a}{b}=c$$\nso it holds.",
		"- As shown:\n  $$\\frac{a}{b}=c$$\n  so it holds.",
	]) {
		markdown.setText(source);
		const text = render().join("\n");
		expect(text).toContain("a/b=c");
		expect(text).not.toContain("───");
		expect(render().length).toBe(3);
	}
});
for (const transport of [ImageProtocol.Kitty, ImageProtocol.Iterm2, ImageProtocol.Sixel]) {
	it(`direct display transport stays raw through list/quote ${JSON.stringify(transport)}`, async () => {
		TERMINAL.imageProtocol = transport;
		setKittyGraphics({ unicodePlaceholders: false });
		setMathImageRenderer({ id: "direct-tall", render: () => ({ ...svg, heightEx: 4 }) });
		markdown.setText("> - before\n>\n>   $$x$$\n>\n>   after");
		render();
		await completion.promise;
		while (true) {
			completion = Promise.withResolvers<void>();
			render();
			if (!markdown.mathImagesPending) break;
			await completion.promise;
		}
		const row = render().find(row => row.startsWith("\x1b7"));
		expect(row).toBeDefined();
		expect(row).toContain("\x1b8\r");
		expect(row).toContain("│");
		expect(directPlacementLift(row!)).toBeGreaterThan(0);
		expect(row).toContain("\x1b[5G");
		if (transport === ImageProtocol.Kitty) expect(parseKittyDirectPlacementLine(row!)).not.toBeNull();
	});
}
it("cached production-theme list preserves earlier placement on pre-completion redraw", async () => {
	markdown = new Markdown("- first $x$\n- second prose", 0, 0, getMarkdownTheme());
	markdown.transientRenderCache = true;
	render();
	await completion.promise;
	const image = render().find(row => TERMINAL.isImageLine(row));
	markdown.setText("- first $x$\n- second prose\n- third $y$\n- fourth prose");
	render();
	expect(render().find(row => TERMINAL.isImageLine(row))).toBe(image);
});
it("longer non-append replacement releases obsolete source barrier", async () => {
	render();
	await completion.promise;
	render();
	markdown.setText("replacement prose without any math, longer than the previous source");
	expect(render().join("\n")).toContain("replacement prose");
	expect(markdown.mathImagesPending).toBe(false);
	expect(markdown.getMathImageStableSource()).toContain("replacement prose");
});
it("zero column cap is unlimited for display and inline math", async () => {
	setInlineImageMaxColumns(0);
	try {
		render();
		await completion.promise;
		expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);
	} finally {
		setInlineImageMaxColumns(100);
	}
});
it("table cells use graphic geometry when sizing their columns", async () => {
	markdown.setText("| $x$ |\n| --- |\n| ordinary |");
	render();
	await completion.promise;
	while (true) {
		completion = Promise.withResolvers<void>();
		render();
		if (!markdown.mathImagesPending) break;
		await completion.promise;
	}
	expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);
});
for (const source of [
	"**before $x$, after**",
	"# before $x$, after",
	"[before $x$, after](https://example.com)",
	"> before **$x$**, after",
]) {
	it(`restores enclosing foreground after inline graphic ${source}`, async () => {
		markdown = new Markdown(source, 0, 0, getMarkdownTheme());
		render();
		await completion.promise;
		const row = render().find(row => TERMINAL.isImageLine(row));
		expect(row).toBeDefined();
		const after = row!.split("\x1b[39;59m")[1];
		expect(after).toMatch(/^\x1b\[/);
	});
}
it("document replacement before conversion cancels stale repaint and pending source", async () => {
	let calls = 0;
	setMathImageRenderer({
		id: "removed",
		render: () => {
			calls++;
			return svg;
		},
	});
	render();
	markdown.setText("replacement without math but longer than old formula source and trailing prose");
	render();
	expect(markdown.mathImagesPending).toBe(false);
	expect(markdown.getMathImageStableSource()).toContain("replacement");
	expect(calls).toBe(0);
});
it("append grammar change removes old math observations and restores source", async () => {
	markdown.setText("before $x$");
	markdown.transientRenderCache = true;
	render();
	await completion.promise;
	render();
	const observe = spyOn(budget, "observe");
	const release = spyOn(budget, "release");
	try {
		markdown.setText("before $x$123");
		const rows = render();
		expect(rows.join("\n")).toContain("before $x$123");
		expect(observe).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalled();
		expect(markdown.getMathImageStableSource()).toBe("before $x$123");
	} finally {
		observe.mockRestore();
		release.mockRestore();
	}
});
it("documented direct host receives actual completion repaint", async () => {
	const done = Promise.withResolvers<void>();
	let repaints = 0;
	const context = {
		budget,
		requestRender: () => {
			repaints++;
			done.resolve();
		},
	};
	const first = withImageRenderContext(context, () => markdown.render(80));
	expect(first.join("\n")).toContain("x+y=1");
	await done.promise;
	expect(repaints).toBeGreaterThan(0);
	expect(withImageRenderContext(context, () => markdown.render(80)).some(row => TERMINAL.isImageLine(row))).toBe(true);
});
for (const [source, column] of [
	["> $$x$$", 2],
	["- $$x$$", 2],
	["> - $$x$$", 4],
] as const) {
	it(`single-row direct display preserves nested column ${source}`, async () => {
		setKittyGraphics({ unicodePlaceholders: false });
		markdown.setText(source);
		render();
		await completion.promise;
		const row = render().find(row => row.startsWith("\x1b7"));
		expect(row).toBeDefined();
		expect(row).toContain("\x1b8\r");
		expect(parseKittyDirectPlacementLine(row!)?.column).toBe(column);
	});
}
it("append invalidation releases only the missing duplicate occurrence", async () => {
	markdown.setText("$x$ and $x$");
	markdown.transientRenderCache = true;
	render();
	await completion.promise;
	render();
	const release = spyOn(budget, "release");
	const observe = spyOn(budget, "observe");
	try {
		markdown.setText("$x$ and $x$123");
		const rows = render();
		expect(rows.join("\n")).toContain("$x$123");
		expect(release).toHaveBeenCalledTimes(1);
		expect(new Set(observe.mock.calls.map(call => call[0])).size).toBe(1);
	} finally {
		release.mockRestore();
		observe.mockRestore();
	}
});
it("repeated identical list invalidations retain only current observations", async () => {
	let source = "- first $x$";
	markdown = new Markdown(source, 0, 0, getMarkdownTheme());
	markdown.transientRenderCache = true;
	render();
	await completion.promise;
	render();
	for (let i = 0; i < 20; i++) {
		source += "\n- $x$";
		markdown.setText(source);
		render();
		source += "123";
		markdown.setText(source);
		render();
	}
	const observe = spyOn(budget, "observe");
	try {
		render();
		expect(new Set(observe.mock.calls.map(call => call[0])).size).toBe(1);
	} finally {
		observe.mockRestore();
	}
});
for (const [source, prefix] of [
	["> $$x$$", " │ "],
	["- outer\n\n  > $$x$$", "   │ "],
] as const) {
	it(`direct suffix has one outer-to-inner prefix ${source}`, async () => {
		setKittyGraphics({ unicodePlaceholders: false });
		markdown = new Markdown(source, 1, 0, defaultMarkdownTheme);
		setMathImageRenderer({ id: "prefix-order", render: () => ({ ...svg, heightEx: 4 }) });
		render();
		await completion.promise;
		const rows = render();
		const graphic = rows.find(row => row.startsWith("\x1b7"));
		expect(graphic).toBeDefined();
		expect(graphic!.split("\r")).toHaveLength(2);
		expect(stripVTControlCharacters(graphic!.split("\r")[1])).toBe(prefix);
		const reserved = rows.find(row => !TERMINAL.isImageLine(row) && row.includes("│"));
		expect(reserved && stripVTControlCharacters(reserved).startsWith(prefix)).toBe(true);
	});
}
for (const source of ["| $x$ |\n| --- |\n| first |", "- Before $x$:\n  $$y$$\n  after"]) {
	it(`canonical identities survive append ${source}`, async () => {
		markdown = new Markdown(source, 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		render();
		await completion.promise;
		while (true) {
			completion = Promise.withResolvers<void>();
			render();
			if (!markdown.mathImagesPending) break;
			await completion.promise;
		}
		const images = render().filter(row => TERMINAL.isImageLine(row));
		expect(images.length).toBeGreaterThan(0);
		const release = spyOn(budget, "release");
		try {
			markdown.setText(source + (source.startsWith("|") ? "\n| other |" : " continued"));
			const next = render();
			expect(release).not.toHaveBeenCalled();
			expect(next.some(row => row === images[0])).toBe(true);
			budget.limitResidentImages();
			expect(budget.takePurgeIds()).toEqual([]);
		} finally {
			release.mockRestore();
		}
	});
}
