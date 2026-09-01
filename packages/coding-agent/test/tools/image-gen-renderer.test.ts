import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { imageGenToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/image-gen-renderer";
import { type Component, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const originalProtocol = TERMINAL.imageProtocol;

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	settings.clearOverride("terminal.showImages");
	setTerminalImageProtocol(originalProtocol);
});

afterAll(() => {
	resetSettingsForTest();
});

async function darkTheme() {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("imageGenToolRenderer hyperlinks", () => {
	it("links each generated image path to a file URI with dimensions outside the link", async () => {
		settings.override("tui.hyperlinks", "always");
		const uiTheme = await darkTheme();
		const imagePath = path.resolve("/var/folders/ab/omp-image-1234.png");
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Provider: fal\nModel: nano-banana-pro" }],
				details: {
					provider: "fal",
					model: "nano-banana-pro",
					entryId: "nano-banana-pro",
					costUsd: 0.0123,
					imageStats: [
						{
							path: imagePath,
							width: 1536,
							height: 2752,
							sizeBytes: 5_480_000,
							mimeType: "image/png",
						},
					],
				},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			undefined,
		);

		const rendered = component.render(120).join("\n");
		// The generated file must be an OSC 8 file hyperlink.
		expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(imagePath).href);
		// Link text is the shortened path only — dimensions stay outside the link.
		expect(extractLinkTexts(rendered).some(text => text.includes("omp-image-1234.png"))).toBe(true);
		for (const linkText of extractLinkTexts(rendered)) {
			expect(linkText).not.toContain("1536x2752");
		}
		// Dimensions + size, provider/model meta, and cost still render in the block.
		const text = Bun.stripANSI(rendered);
		expect(text).toContain("1536x2752");
		expect(text).toContain("5.2MB");
		expect(text).toContain("fal");
		expect(text).toContain("nano-banana-pro");
		expect(text).toContain("$0.0123");
	});

	it("preserves provider-reported prose (revisedPrompt + responseText) as notes", async () => {
		settings.override("tui.hyperlinks", "always");
		const uiTheme = await darkTheme();
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Provider: openai" }],
				details: {
					provider: "openai",
					model: "gpt-5.5",
					revisedPrompt: "A crisp portrait of a tabby cat.",
					responseText: "Generated with care.\nSecond line intact.",
					imageStats: [
						{ path: path.resolve("/var/folders/ab/omp-image-55.png"), sizeBytes: 1024, mimeType: "image/png" },
					],
				},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			undefined,
		);

		const text = Bun.stripANSI(component.render(120).join("\n"));
		expect(text).toContain("Revised prompt");
		expect(text).toContain("A crisp portrait of a tabby cat.");
		expect(text).toContain("Response");
		expect(text).toContain("Generated with care.");
		expect(text).toContain("Second line intact.");
	});

	it("renders legacy details without imageStats and still shows provider/model", async () => {
		settings.override("tui.hyperlinks", "always");
		const uiTheme = await darkTheme();
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Provider: gemini\nModel: gemini-3-pro-image-preview" }],
				details: { provider: "gemini", model: "gemini-3-pro-image-preview" },
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			undefined,
		);

		const text = Bun.stripANSI(component.render(120).join("\n"));
		expect(text).toContain("gemini-3-pro-image-preview");
	});

	it("renders an error result with the surfaced error detail", async () => {
		settings.override("tui.hyperlinks", "always");
		const uiTheme = await darkTheme();
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Quality is not supported by gpt-image-2 via fal." }],
				details: { provider: "fal" },
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			undefined,
		);

		const text = Bun.stripANSI(component.render(120).join("\n"));
		expect(text).toContain("Quality is not supported");
	});

	it("names the requested model when an error result has no details", async () => {
		const uiTheme = await darkTheme();
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "image generation failed" }],
				details: undefined,
				isError: true,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ model: "gpt-image-2" },
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("gpt-image-2");
	});
	it("explains missing preview when image details have no imageStats", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		try {
			const uiTheme = await darkTheme();
			const component: Component = imageGenToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Provider: fal" }],
					details: {
						provider: "fal",
						model: "nano-banana-pro",
						images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
					},
					isError: false,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				undefined,
			);

			expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("inline preview unavailable");
		} finally {
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("explains when an inline preview is unavailable", async () => {
		const previousProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		try {
			const uiTheme = await darkTheme();
			const component: Component = imageGenToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "Provider: fal" }],
					details: {
						provider: "fal",
						model: "nano-banana-pro",
						imageStats: [
							{
								path: "/tmp/omp-image-1.png",
								width: 1,
								height: 1,
								sizeBytes: 70,
								mimeType: "image/png",
							},
						],
						images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
					},
					isError: false,
				},
				{ expanded: false, isPartial: false },
				uiTheme,
				undefined,
			);

			expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("inline preview unavailable");
		} finally {
			setTerminalImageProtocol(previousProtocol);
		}
	});

	it("explains when inline preview is disabled in settings", async () => {
		settings.override("terminal.showImages", false);
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const uiTheme = await darkTheme();
		const component: Component = imageGenToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Provider: fal" }],
				details: {
					provider: "fal",
					model: "nano-banana-pro",
					imageStats: [
						{
							path: "/tmp/omp-image-1.png",
							width: 1,
							height: 1,
							sizeBytes: 70,
							mimeType: "image/png",
						},
					],
					images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
				},
				isError: false,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			undefined,
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain(
			"inline preview unavailable — terminal.showImages is off",
		);
	});
});
