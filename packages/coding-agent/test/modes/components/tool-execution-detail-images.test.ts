import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { Image, ImageBudget, ImageGrid, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const CHANGED_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const originalProtocol = TERMINAL.imageProtocol;

const nestedDetails = {
	xdev: {
		tool: "generate_image",
		mode: "execute",
		inner: { images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }] },
	},
};

const ui = {
	requestRender: vi.fn(),
	requestComponentRender: vi.fn(),
	resetDisplay: vi.fn(),
};

const mountedComponents: ToolExecutionComponent[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
	setTerminalImageProtocol(ImageProtocol.Kitty);
});

afterEach(() => {
	for (const component of mountedComponents) component.stopAnimation();
	mountedComponents.length = 0;
	setTerminalImageProtocol(originalProtocol);
	resetSettingsForTest();
});

afterAll(() => {
	setTerminalImageProtocol(originalProtocol);
	resetSettingsForTest();
});

describe("ToolExecutionComponent detail images", () => {
	const mount = (details: unknown, showImages = true) => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image", content: "{}" },
			{ showImages, useBuiltInRenderer: false },
			undefined,
			ui,
		);
		component.updateResult({ content: [{ type: "text", text: "Provider: fal" }], details }, false);
		mountedComponents.push(component);
		return component;
	};
	const mountWithBudget = (budget: ImageBudget, details: unknown) => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image", content: "{}" },
			{ showImages: true, useBuiltInRenderer: false },
			undefined,
			{ ...ui, imageBudget: budget },
		);
		component.updateResult({ content: [{ type: "text", text: "Provider: fal" }], details }, false);
		mountedComponents.push(component);
		return component;
	};

	const renderWithBudget = (component: ToolExecutionComponent, budget: ImageBudget): string => {
		budget.beginPass();
		const rendered = component.render(80).join("\n");
		budget.endPass();
		return rendered;
	};

	it("renders inline images from an xd:// dispatched tool's nested details", () => {
		const component = mount(nestedDetails);

		expect(component.children.filter(child => child instanceof Image)).toHaveLength(1);
	});

	it("renders inline images from top-level details", () => {
		const component = mount({ images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }] });

		expect(component.children.filter(child => child instanceof Image)).toHaveLength(1);
	});
	it("does not expose a normal-screen mouse target without a gallery host", () => {
		const component = mount(nestedDetails);

		expect(component.hasMouseTargets()).toBe(false);
	});
	it("ignores metadata-only and malformed nested detail entries while rendering valid images", () => {
		const component = mount({
			xdev: {
				tool: "generate_image",
				mode: "execute",
				inner: {
					images: [
						null,
						{},
						{ mimeType: "image/png", path: "/tmp/generated.png" },
						{ data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
				},
			},
		});

		expect(component.children.filter(child => child instanceof Image)).toHaveLength(1);
	});

	it("mounts multiple result images in one ImageGrid", () => {
		const component = mount({
			xdev: {
				tool: "generate_image",
				mode: "execute",
				inner: {
					images: [
						{ data: TINY_PNG_BASE64, mimeType: "image/png" },
						{ data: TINY_PNG_BASE64, mimeType: "image/png" },
					],
				},
			},
		});

		const grid = component.children.find(child => child instanceof ImageGrid);
		expect(grid).toBeInstanceOf(ImageGrid);
		expect(grid instanceof ImageGrid ? grid.children : []).toHaveLength(2);
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);
	});
	it("keeps a final mixed-image block live until Kitty conversion and seal settle", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image", content: "{}" },
			{ showImages: true, useBuiltInRenderer: false },
			undefined,
			ui,
		);
		mountedComponents.push(component);
		component.updateResult(
			{
				content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
				details: { images: [{ data: TINY_PNG_BASE64, mimeType: "image/jpeg" }] },
			},
			false,
		);

		// The PNG can paint immediately, but the JPEG must not let this final
		// result commit before its Kitty conversion rebuilds the ImageGrid.
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(1);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isTranscriptBlockFinalized()).toBe(false);
	});

	it("starts Kitty conversion when protocol discovery promotes an existing result", () => {
		setTerminalImageProtocol(null);
		const component = mount({ images: [{ data: TINY_PNG_BASE64, mimeType: "image/jpeg" }] });
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		setTerminalImageProtocol(ImageProtocol.Kitty);
		component.invalidate();
		expect(component.isTranscriptBlockFinalized()).toBe(false);
	});

	it("announces nested images as text when the terminal has no image protocol", () => {
		setTerminalImageProtocol(null);
		const component = mount(nestedDetails);

		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("image/png");
	});

	it("renders no image component when showImages is off", () => {
		const component = mount(nestedDetails, false);
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);
	});
	it("purges a rendered image when visibility is disabled and a replacement uses fresh payload", () => {
		const budget = new ImageBudget(8, vi.fn());
		const component = mountWithBudget(budget, {
			images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		const first = renderWithBudget(component, budget);
		const firstId = first.match(/i=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		component.setShowImages(false);
		expect([...budget.takePurgeIds()]).toEqual([Number(firstId)]);
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);

		component.updateResult(
			{
				content: [{ type: "text", text: "Provider: fal" }],
				details: { images: [{ data: CHANGED_PNG_BASE64, mimeType: "image/png" }] },
			},
			false,
		);
		component.setShowImages(true);

		const replacement = renderWithBudget(component, budget);
		const replacementId = replacement.match(/i=(\d+)/)?.[1];
		expect(replacementId).toBeDefined();
		expect(replacementId).not.toBe(firstId);
		const replacementTransmits = [...budget.takeTransmits()];
		expect(replacementTransmits).toHaveLength(1);
		expect(replacementTransmits[0]).toContain(CHANGED_PNG_BASE64);
		expect(replacementTransmits[0]).not.toContain(TINY_PNG_BASE64);
	});

	it("purges a rendered image when the terminal image protocol disappears", () => {
		const budget = new ImageBudget(8, vi.fn());
		const component = mountWithBudget(budget, {
			images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		const first = renderWithBudget(component, budget);
		const firstId = first.match(/i=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		setTerminalImageProtocol(null);
		component.invalidate();
		expect([...budget.takePurgeIds()]).toEqual([Number(firstId)]);
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);

		setTerminalImageProtocol(ImageProtocol.Kitty);
		component.invalidate();
		const restored = renderWithBudget(component, budget);
		const restoredId = restored.match(/i=(\d+)/)?.[1];
		expect(restoredId).toBeDefined();
		expect(restoredId).not.toBe(firstId);
		expect([...budget.takeTransmits()]).toHaveLength(1);
	});

	it("reuses the same image id and transmit for an unchanged same-index snapshot", () => {
		const budget = new ImageBudget(8, vi.fn());
		const details = { images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }] };
		const component = mountWithBudget(budget, details);

		const first = renderWithBudget(component, budget);
		const firstId = first.match(/i=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		component.updateResult({ content: [{ type: "text", text: "Provider: fal" }], details }, false);
		const second = renderWithBudget(component, budget);
		expect(second.match(/i=(\d+)/)?.[1]).toBe(firstId);
		expect([...budget.takeTransmits()]).toEqual([]);
		expect([...budget.takePurgeIds()]).toEqual([]);
	});

	it("purges the old id and transmits a fresh id when a same-index payload changes", () => {
		const budget = new ImageBudget(8, vi.fn());
		const component = mountWithBudget(budget, {
			images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		const first = renderWithBudget(component, budget);
		const firstId = first.match(/i=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		component.updateResult(
			{
				content: [{ type: "text", text: "Provider: fal" }],
				details: { images: [{ data: CHANGED_PNG_BASE64, mimeType: "image/png" }] },
			},
			false,
		);
		expect([...budget.takePurgeIds()]).toEqual([Number(firstId)]);

		const second = renderWithBudget(component, budget);
		const secondId = second.match(/i=(\d+)/)?.[1];
		expect(secondId).toBeDefined();
		expect(secondId).not.toBe(firstId);
		expect([...budget.takeTransmits()]).toHaveLength(1);
	});
	it("appends a custom generate_image result's detail images after renderer content", () => {
		const tool = {
			label: "GenerateImage",
			mergeCallAndResult: imageGenTool.mergeCallAndResult,
			renderCall: imageGenTool.renderCall,
			renderResult: imageGenTool.renderResult,
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"generate_image",
			{ subject: "a massive stylized dire wolf" },
			{ showImages: true, useBuiltInRenderer: false },
			tool,
			ui,
		);
		mountedComponents.push(component);
		component.updateResult(
			{
				content: [{ type: "text", text: "Provider: fal\nModel: fal-ai/nano-banana-pro" }],
				details: {
					provider: "fal",
					model: "fal-ai/nano-banana-pro",
					entryId: "nano-banana-pro",
					imageStats: [
						{
							path: "/tmp/omp-image-1.png",
							width: 1536,
							height: 2752,
							sizeBytes: 5_400_000,
							mimeType: "image/png",
						},
						{
							path: "/tmp/omp-image-2.png",
							width: 1536,
							height: 2752,
							sizeBytes: 5_400_000,
							mimeType: "image/png",
						},
					],
					images: [
						{ data: TINY_PNG_BASE64, mimeType: "image/png" },
						{ data: CHANGED_PNG_BASE64, mimeType: "image/png" },
					],
				},
			},
			false,
		);

		const finalChild = component.children.at(-1);
		expect(finalChild).toBeInstanceOf(ImageGrid);
		expect(finalChild instanceof ImageGrid ? finalChild.children : []).toHaveLength(2);
		expect(component.children.indexOf(finalChild!)).toBe(component.children.length - 1);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("nano-banana-pro");
	});
	it("opens the image gallery from an inline image click", () => {
		const openImageGallery = vi.fn();
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image", content: "{}" },
			{ showImages: true, useBuiltInRenderer: false },
			undefined,
			{ ...ui, openImageGallery, allowInlineImageClicks: true },
		);
		mountedComponents.push(component);
		component.updateResult(
			{
				content: [{ type: "text", text: "Provider: fal" }],
				details: { images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }] },
			},
			false,
		);

		const rendered = component.render(80);
		const imageRow = rendered.findIndex(line => line.includes("\x1b_G"));
		expect(component.hasMouseTargets()).toBe(true);
		expect(imageRow).toBeGreaterThanOrEqual(0);
		expect(
			component.routeMouse(
				{
					button: 0,
					col: 0,
					row: imageRow,
					release: false,
					wheel: null,
					motion: false,
					leftClick: true,
				},
				imageRow,
				0,
			),
		).toBe(true);
		expect(openImageGallery).toHaveBeenCalledTimes(1);
		const [images, initialIndex] = openImageGallery.mock.calls[0] as [readonly unknown[], number];
		expect(images).toHaveLength(1);
		expect(initialIndex).toBe(0);
	});

	it("purges a removed same-index payload without leaving a transmit or image child", () => {
		const budget = new ImageBudget(8, vi.fn());
		const component = mountWithBudget(budget, {
			images: [{ data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		const first = renderWithBudget(component, budget);
		const firstId = first.match(/i=(\d+)/)?.[1];
		expect(firstId).toBeDefined();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		component.updateResult({ content: [{ type: "text", text: "Provider: fal" }] }, false);
		expect([...budget.takePurgeIds()]).toEqual([Number(firstId)]);
		expect(component.children.filter(child => child instanceof Image)).toHaveLength(0);
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("renders the generate_image block on the direct custom-tool path", () => {
		const tool = {
			label: "GenerateImage",
			mergeCallAndResult: imageGenTool.mergeCallAndResult,
			renderCall: imageGenTool.renderCall,
			renderResult: imageGenTool.renderResult,
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"generate_image",
			{ subject: "a massive stylized dire wolf" },
			{ useBuiltInRenderer: false },
			tool,
			ui,
		);
		mountedComponents.push(component);
		component.updateResult(
			{
				content: [{ type: "text", text: "Provider: fal\nModel: fal-ai/nano-banana-pro" }],
				details: {
					provider: "fal",
					model: "fal-ai/nano-banana-pro",
					entryId: "nano-banana-pro",
					imageStats: [
						{
							path: "/tmp/omp-image-1.png",
							width: 1536,
							height: 2752,
							sizeBytes: 5_400_000,
							mimeType: "image/png",
						},
					],
				},
				isError: false,
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("nano-banana-pro");
		expect(rendered).not.toContain("GenerateImage");
	});
	it("keeps the mounted image model in a streamed xd:// result header", async () => {
		const mountedImageTool = {
			...imageGenTool,
		} as unknown as AgentTool;
		const writeTool = {
			label: "Write",
			mergeCallAndResult: writeToolRenderer.mergeCallAndResult,
			renderCall: writeToolRenderer.renderCall,
			renderResult: writeToolRenderer.renderResult,
			session: {
				xdev: {
					mountedNames: new Set(["generate_image"]),
					tools: new Map([["generate_image", mountedImageTool]]),
				},
			},
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image", content: JSON.stringify({ model: "flux-schnell" }) },
			{ useBuiltInRenderer: false },
			writeTool,
			ui,
		);
		mountedComponents.push(component);
		component.updateResult(
			{
				content: [{ type: "text", text: "Generating image via fal (fal-ai/flux/schnell)…" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						args: { model: "flux-schnell" },
					},
				},
				isError: false,
			},
			true,
		);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("Image: flux-schnell");
		expect(rendered).not.toContain("Image: image");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
	});
});
