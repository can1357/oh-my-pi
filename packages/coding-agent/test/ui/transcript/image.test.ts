import { afterEach, expect, test } from "bun:test";
import {
	createRoot,
	isUiNode,
	nativeRendering,
	setNativeRenderingForTest,
	signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bindEffects } from "../../../src/config/registry";
import { Settings } from "../../../src/config/settings";
import { cfgTuiMaxInlineImageColumns, cfgTuiMaxInlineImageRows } from "../../../src/modes/settings";
import "../../../src/ui/styles/tools/block";
import "../../../src/ui/styles/tools/read";
import "../../../src/ui/styles/transcript/exec-run";
import { readPresenter } from "../../../src/ui/tools/read";
import { ExecRun, ExecRunBlock } from "../../../src/ui/transcript/exec-run";
import { followInlineImageLimits, ImageNode } from "../../../src/ui/transcript/messages/image";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";
import { withLargeMetadata } from "../../helpers/jpeg-metadata";

const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const caps: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: "iterm",
	kittyKeyboard: true,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: { w: 10, h: 20 },
	multiplexer: null,
	textSizing: false,
	tsp: false,
	emoji: CONSERVATIVE_EMOJI,
	styledUnderlines: false,
};

let cleanup: (() => void) | undefined;
let restoreNative: boolean | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	if (restoreNative !== undefined) setNativeRenderingForTest(restoreNative);
	restoreNative = undefined;
});

function sizingSettings(viewport: () => number): Settings {
	const settings = Settings.isolated();
	const release = bindEffects(settings);
	const unfollow = followInlineImageLimits(viewport);
	cleanup = () => {
		cfgTuiMaxInlineImageColumns.override(settings, cfgTuiMaxInlineImageColumns.default);
		cfgTuiMaxInlineImageRows.override(settings, cfgTuiMaxInlineImageRows.default);
		unfollow();
		release();
	};
	return settings;
}

async function largeImage() {
	const data = await new Bun.Image(Buffer.from(RED_PNG, "base64")).resize(1200, 600).png().toBase64();
	return { data, mimeType: "image/png" };
}

function paintRows(node: UiNode): () => readonly string[] {
	const capabilities = () => caps;
	const images = new TerminalImages({ capabilities, placeholders: () => false });
	const env = staticEnvironment(currentTheme(), { images: driverImages(images, capabilities) });
	return () => paintNode(env, node, 160).rows;
}

function expectPicture(rows: readonly string[], columns: number, height: number): void {
	expect(rows).toHaveLength(height);
	expect(rows.at(-1)).toContain(`File=inline=1;width=${columns};height=${height}:`);
}

test("a mounted transcript picture follows both configured caps without remounting", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 60);
	createRoot(dispose => {
		try {
			const node = ImageNode({ image });
			if (!isUiNode(node)) throw new Error("expected an image node");
			const rows = paintRows(node);
			expectPicture(rows(), 80, 20);

			cfgTuiMaxInlineImageColumns.override(settings, 40);
			cfgTuiMaxInlineImageRows.override(settings, 10);
			expectPicture(rows(), 40, 10);

			cfgTuiMaxInlineImageRows.override(settings, 8);
			expectPicture(rows(), 32, 8);
			cfgTuiMaxInlineImageRows.override(settings, 20);
			expectPicture(rows(), 40, 10);
			cfgTuiMaxInlineImageColumns.override(settings, 0);
			expectPicture(rows(), 80, 20);
		} finally {
			dispose();
		}
	});
});

test("a read picture draws once beneath the details card and only while images are on", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	createRoot(dispose => {
		try {
			const path = "/tmp/read.png";
			const call = new ToolCall({ id: "read", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{
					content: [
						{ type: "image", ...image },
						{ type: "text", text: "Picture detail" },
					],
				},
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const rows = paintRows(node);
			const drawn = rows();
			const graphics = drawn.findIndex(row => row.includes("File=inline=1;width=40;height=10:"));
			expect(graphics).toBeGreaterThan(0);
			expect(drawn.slice(0, graphics).join("\n")).toContain("Picture detail");
			expect(drawn.filter(row => row.includes("File=inline=1;"))).toHaveLength(1);

			call.setShowImages(false);
			const hidden = rows().join("\n");
			expect(hidden).toContain("Picture detail");
			expect(hidden).not.toContain("File=inline=1;");
		} finally {
			dispose();
		}
	});
});

test.each([
	["jpeg", "jpeg"],
	["webp", "webp"],
	["jpeg with its SOF behind large metadata", "jpeg-metadata"],
] as const)("a %s tool result draws inline instead of its placeholder", async (_label, format) => {
	const source = new Bun.Image(Buffer.from(RED_PNG, "base64")).resize(1200, 600);
	const data =
		format === "webp"
			? await source.webp().toBase64()
			: format === "jpeg"
				? await source.jpeg().toBase64()
				: withLargeMetadata(Buffer.from(await source.jpeg().bytes())).toString("base64");
	const mimeType = format === "webp" ? "image/webp" : "image/jpeg";
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	createRoot(dispose => {
		try {
			const call = new ToolCall({ id: "shot", name: "eval", args: {} });
			call.updateResult({ content: [{ type: "image", data, mimeType }] }, false);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const drawn = paintRows(node)().join("\n");
			expect(drawn).toContain("File=inline=1;width=40;height=10:");
			expect(drawn).not.toContain("[Image:");
		} finally {
			dispose();
		}
	});
});

test("a bash run paints a capped picture or its placeholder according to the terminal and display setting", async () => {
	const image = await largeImage();
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	createRoot(dispose => {
		try {
			const run = new ExecRun({ kind: "bash", source: "print-picture" });
			run.setComplete(0, false, { images: [image] });
			const node = ExecRunBlock({ run });
			if (!isUiNode(node)) throw new Error("expected a bash run node");
			const rows = paintRows(node);
			const drawn = rows().join("\n");
			expect(drawn).toContain("File=inline=1;width=40;height=10:");
			expect(drawn).not.toContain("[Image:");

			const plain = paintNode(staticEnvironment(currentTheme()), node, 160).rows.join("\n");
			expect(plain).toContain("[Image: [image/png] 1200x600]");
			expect(plain).not.toContain("File=inline=1;");

			run.setComplete(0, false, { images: [image], showImages: false });
			const hidden = rows().join("\n");
			expect(hidden).toContain("[Image: [image/png] 1200x600]");
			expect(hidden).not.toContain("File=inline=1;");
		} finally {
			dispose();
		}
	});
});

test("a native file preview has a height limit but its fallback blob has no max box", () => {
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageColumns.override(settings, 40);
	cfgTuiMaxInlineImageRows.override(settings, 10);
	restoreNative = nativeRendering();
	setNativeRenderingForTest(true);
	createRoot(dispose => {
		try {
			const path = "/tmp/read.png";
			const call = new ToolCall({ id: "read", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{ content: [{ type: "image", mimeType: "image/png", data: RED_PNG }], details: { mediaPath: path } },
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const env = staticEnvironment(currentTheme());

			expect(describeTree(node, env)).toMatchObject({
				c: [expect.objectContaining({ k: "media", p: { max: { h: "10lines" }, path } })],
			});
			cfgTuiMaxInlineImageRows.override(settings, 0);
			expect(describeTree(node, env)).toMatchObject({
				c: [expect.objectContaining({ k: "media", p: { max: { h: "30lines" }, path } })],
			});

			setNativeRenderingForTest(false);
			const [image] = node.children();
			if (!image) throw new Error("expected a fallback image");
			expect(describeTree(image, env)).toEqual({
				k: "image",
				p: { role: "omp.tool.read.image", alt: expect.any(String), blob: expect.any(String), w: 1, h: 1 },
			});
		} finally {
			dispose();
		}
	});
});

test("a native read puts the capped non-image file preview before its content and footer", () => {
	const settings = sizingSettings(() => 50);
	cfgTuiMaxInlineImageRows.override(settings, 12);
	restoreNative = nativeRendering();
	setNativeRenderingForTest(true);
	createRoot(dispose => {
		try {
			const path = "/tmp/report.pdf";
			const call = new ToolCall({ id: "pdf", name: "read", args: { path }, presenter: readPresenter });
			call.updateResult(
				{
					content: [{ type: "text", text: "Extracted page" }],
					details: { mediaPath: path, resolvedPath: path },
				},
				false,
			);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("expected a tool node");
			const env = staticEnvironment(currentTheme());

			expect(node.children().map(child => child.kind)).toEqual(["media", "code", "text"]);
			expect(describeTree(node.children()[0]!, env)).toEqual({
				k: "media",
				key: "media",
				p: { path, max: { h: "12lines" } },
			});

			setNativeRenderingForTest(false);
			expect(node.children().map(child => child.kind)).toEqual(["code", "text"]);
		} finally {
			dispose();
		}
	});
});

test("a row cap of zero follows sixty percent of the viewport", async () => {
	const image = await largeImage();
	const viewport = signal(21);
	const settings = sizingSettings(viewport);
	cfgTuiMaxInlineImageRows.override(settings, 0);
	createRoot(dispose => {
		try {
			const node = ImageNode({ image });
			if (!isUiNode(node)) throw new Error("expected an image node");
			const rows = paintRows(node);
			expectPicture(rows(), 48, 12);

			viewport.set(34);
			expectPicture(rows(), 80, 20);
			cfgTuiMaxInlineImageRows.override(settings, 30);
			expectPicture(rows(), 80, 20);
		} finally {
			dispose();
		}
	});
});
