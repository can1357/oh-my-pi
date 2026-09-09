import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/jpeg",
};
const originalProtocol = TERMINAL.imageProtocol;

describe("Tool image rendering", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(() => {
			throw new TypeError("synchronous image conversion failure");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("omits restored tool-result images when conversion throws synchronously", () => {
		let imageUpdates = 0;
		const component = new AssistantMessageComponent(undefined, false, () => imageUpdates++);

		component.setToolResultImages("restored-read", [IMAGE]);
		expect(imageUpdates).toBe(0);
	});

	it("omits live tool-result images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent("read", { path: "repro.jpg" }, {}, undefined, {
			requestRender,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});

		component.updateResult({ content: [IMAGE] }, false);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("surfaces images returned through xdev write results", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image" },
			{ showImages: true },
			undefined,
			{
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				resetDisplay: vi.fn(),
			},
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Generated 1 image" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						inner: {
							images: [{ data: IMAGE.data, mimeType: "image/png" }],
						},
					},
				},
			},
			false,
		);

		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});
});
