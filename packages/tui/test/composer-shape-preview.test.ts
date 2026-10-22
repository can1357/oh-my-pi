import { beforeAll, describe, expect, it } from "bun:test";
import { renderComposerShapePreview } from "../src/overlays/composer-shape-preview";
import { getComposerShapeOptions, installExtensionComposerShape } from "../src/overlays/composer-shape-registry";
import { getEditorTheme, initTheme, setTheme } from "../src/theme/theme";
import { type ComposerStyle, Editor, visibleWidth } from "../src/index";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	it("resolves transparent composer preview text away from the terminal default", async () => {
		// The built-in `light` theme leaves `text` empty; a transparent shape must
		// still emit an explicit contrast foreground instead of ESC[39m, matching
		// the live editor so the preview stays readable on a light terminal.
		await setTheme("light");
		const box = renderComposerShapePreview("box", 80).join("\n");
		expect(box).not.toContain("\x1b[39mAsk anything");
		expect(box).toMatch(/\x1b\[38[;0-9]*mAsk anything/);
	});

	it("borrows status rows from the live status source per shape layout", async () => {
		await setTheme("dark");
		// Echo mocks: the stand-in title must be forwarded as a prop to every
		// title-bearing status call, not glued onto the rendered content.
		const status = {
			getTopBorder: (_width: number, previewTitle?: string) => {
				const content = `TOPBAR ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getStandaloneTopBorder: (_width: number, previewTitle?: string) => {
				const content = `CHIP ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getBandTopBorder: (_width: number, previewTitle?: string) => {
				const content = `BAND ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			renderBottomBar: (_width: number, groups: "left" | "full", previewTitle?: string) =>
				`BOTTOM-${groups.toUpperCase()} ${previewTitle ?? ""}`,
		};

		const box = renderComposerShapePreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR"); // embedded in the top border
		expect(box).toContain("omp"); // stand-in title forwarded to the status source
		expect(box).not.toContain("BOTTOM"); // box has no standalone bottom bar
		const band = renderComposerShapePreview("band", 80, status).join("\n");
		expect(band).toContain("BAND"); // flush band row above the prompt
		expect(band).toContain("omp");
		expect(band).not.toContain("BOTTOM"); // the band replaces the bottom bar

		const claude = renderComposerShapePreview("claude", 80, status).join("\n");
		expect(claude).toContain("CHIP"); // right group chips onto the top rule
		expect(claude).toContain("omp");
		expect(claude).toContain("BOTTOM-LEFT"); // left group only on the bottom bar

		const rule = renderComposerShapePreview("rule", 80, status);
		expect(rule.join("\n")).toContain("CHIP");
		expect(rule.join("\n")).toContain("omp");
		expect(rule.join("\n")).toContain("BOTTOM-LEFT");
		expect(rule[rule.length - 2]).toBe(""); // spacer row: rule has no bottom chrome

		const pi = renderComposerShapePreview("pi", 80, status);
		expect(pi.join("\n")).not.toContain("CHIP");
		expect(pi.join("\n")).toContain("omp");
		expect(pi.join("\n")).toContain("BOTTOM-FULL"); // both groups on the bottom bar
		expect(pi[pi.length - 2]).not.toBe(""); // bottom rule already separates the bar

		const borderless = renderComposerShapePreview("borderless", 80, status).join("\n");
		expect(borderless).toContain("omp");
		expect(borderless).toContain("BOTTOM-FULL");

		for (const shape of ["field", "rail"]) {
			const rendered = renderComposerShapePreview(shape, 80, status);
			expect(rendered.join("\n")).not.toContain("CHIP");
			expect(rendered.join("\n")).toContain("omp");
			expect(rendered.join("\n")).toContain("BOTTOM-FULL");
			expect(rendered[rendered.length - 2]).toBe(""); // spacer row before the bar
		}
	});

	it("installs extension shapes into both selectors and live rendering", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: context => context.borderColor("=".repeat(context.width)),
			renderRow: context => [context.gutter + context.text + context.pad],
			renderBottom: () => undefined,
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});

		try {
			expect(getComposerShapeOptions().at(-1)).toEqual({
				value: "extension-dock",
				label: "Extension Dock",
				description: "Custom extension composer",
			});
			const rendered = renderComposerShapePreview("extension-dock", 76).join("\n");
			expect(rendered).toContain("=".repeat(76));
			expect(rendered).toContain("EXT ");
			expect(rendered).toContain("Ask anything");
		} finally {
			dispose();
		}

		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});

	it("keeps a metadata header separate from the rule in live and preview frames", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-metadata-header",
			sideBorders: false,
			verticalChrome: 3,
			statusAttachment: "top-border",
			bottomBar: "none",
			bottomBarGap: false,
			defaultPromptGutter: undefined,
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: ctx => [
				(ctx.topBorder?.content ?? "").padEnd(ctx.width),
				ctx.borderColor(ctx.box.horizontal.repeat(ctx.width)),
			],
			renderRow: ctx => [ctx.text + ctx.pad],
			renderBottom: ctx => ctx.borderColor(ctx.box.horizontal.repeat(ctx.width)),
		};
		const dispose = installExtensionComposerShape({
			label: "Metadata Header",
			description: "Header above rule",
			style,
		});
		try {
			const editor = new Editor(getEditorTheme());
			editor.setBorderStyle(style.id);
			editor.setTopBorder({ content: "workflow", width: 8 });
			editor.setMaxHeight(4);
			editor.setText("first\nsecond");
			for (const width of [12, 80]) {
				const live = editor.render(width);
				expect(live).toHaveLength(4); // three chrome rows leave one visible input row
				expect(live[0].trimEnd()).toBe("workflow");
				expect(live[1]).not.toContain("workflow");
				expect(live[2]).toContain("second");
				expect(live.every(row => !row.includes("\n"))).toBe(true);
				expect(live.map(visibleWidth)).toEqual([width, width, width, width]);
			}
			// A seven-row terminal gives the editor a three-row cap: leave the
			// host's four transcript/status rows intact, keeping the separator.
			editor.setMaxHeight(3);
			const short = editor.render(12);
			expect(short).toHaveLength(3);
			expect(short.join("\n")).not.toContain("workflow");
			expect(short[0]).toBe(short[2]);
			expect(short[1]).toContain("second");
			editor.setMaxHeight(4);
			expect(editor.render(12)[0].trimEnd()).toBe("workflow");
			const preview = renderComposerShapePreview(style.id, 80);
			expect(preview).toHaveLength(4);
			expect(preview[1]).toBe(preview[3]); // full-width separators surround the input
			expect(preview[2]).toContain("Ask anything");
			expect(preview.every(row => !row.includes("\n"))).toBe(true);
		} finally {
			dispose();
		}
	});

	it("uses the full overlay width instead of clipping the status band (issue #12500)", async () => {
		await setTheme("dark");
		const status = {
			getTopBorder: (width: number) => ({ content: "", width }),
			getStandaloneTopBorder: (width: number) => ({ content: "", width }),
			getBandTopBorder: (width: number) => ({ content: " ".repeat(width - 6) + "STATUS", width }),
			renderBottomBar: () => "",
		};

		const [statusBand] = renderComposerShapePreview("band", 200, status);

		expect(visibleWidth(statusBand ?? "")).toBe(200);
		expect(statusBand).toEndWith("STATUS");
	});
});
