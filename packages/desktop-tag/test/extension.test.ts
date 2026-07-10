import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import desktopTagExtension, { parseCommandArgs } from "../src/extension";

function createFakeApi(): ExtensionAPI {
	return {
		setLabel: mock(() => {}),
		registerCommand: mock(() => {}),
		registerShortcut: mock(() => {}),
		registerTool: mock(() => {}),
		registerFlag: mock(() => {}),
		getFlag: mock(() => undefined),
		on: mock(() => {}),
		sendMessage: mock(() => {}),
		sendUserMessage: mock(() => {}),
		appendEntry: mock(() => {}),
		getActiveTools: mock(() => []),
		setActiveTools: mock(() => {}),
	} as unknown as ExtensionAPI;
}

describe("desktopTagExtension", () => {
	it("registers command and shortcut", () => {
		const api = createFakeApi();
		desktopTagExtension(api);

		expect(api.setLabel).toHaveBeenCalledWith("Desktop Tag");
		expect(api.registerCommand).toHaveBeenCalled();
		expect(api.registerShortcut).toHaveBeenCalled();
	});
});

describe("tag command arguments", () => {
	it("uses a useful screen request when /tag has no arguments", () => {
		expect(parseCommandArgs("   ")).toEqual({
			mode: "screen",
			request: "Describe what is on my screen.",
		});
	});

	it("preserves an explicit mode while defaulting an omitted request", () => {
		expect(parseCommandArgs("window")).toEqual({
			mode: "window",
			request: "Describe what is on my screen.",
		});
	});

	it("parses signed region coordinates and a trailing request", () => {
		expect(parseCommandArgs("region -1920 -240 1920 1080 inspect this monitor")).toEqual({
			mode: "region",
			region: { x: -1920, y: -240, width: 1920, height: 1080 },
			request: "inspect this monitor",
		});
	});

	it("defaults the request after valid region coordinates", () => {
		expect(parseCommandArgs("region 10 20 300 200")).toEqual({
			mode: "region",
			region: { x: 10, y: 20, width: 300, height: 200 },
			request: "Describe what is on my screen.",
		});
	});

	it.each([
		"region",
		"region 1 2 3",
		"region nope 2 300 200",
		"region 1 Infinity 300 200",
		"region 1 2 0 200",
		"region 1 2 300 -1",
	])("rejects invalid region coordinates with usage guidance: %s", args => {
		expect(() => parseCommandArgs(args)).toThrow("Usage: /tag region <x> <y> <width> <height> [request]");
	});
});

describe("region overlay", () => {
	it("provides four numeric fields and includes the region in capture payloads", async () => {
		const html = await Bun.file(new URL("../src/overlay.html", import.meta.url)).text();

		expect(html).toContain('id="region-inputs" class="region-inputs hidden" disabled');
		for (const field of ["x", "y", "width", "height"]) {
			expect(html).toContain(`type="number" id="region-${field}"`);
		}
		expect(html).toContain("regionInputsEl.disabled = !regionMode");
		expect(html).toContain("request: requestEl.value.trim()");
		expect(html).not.toContain("userRequest: requestEl.value.trim()");
		expect(html).toContain("payload.region = region");
		expect(html).toContain("valueAsNumber");
	});
});
