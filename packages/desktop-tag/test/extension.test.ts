import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import desktopTagExtension, {
	parseCommandArgs,
	parseTelegramCommandArgs,
	warnIfTelegramUnconfigured,
} from "../src/extension";

interface CommandSpec {
	description?: string;
	handler: (...args: unknown[]) => unknown;
	getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label?: string }> | null;
}

interface RegisteredCommandCapture {
	name: string;
	spec: CommandSpec;
}

/** Commands registered since the last createFakeApi() call. */
const registeredCommands: RegisteredCommandCapture[] = [];

function createFakeApi(): ExtensionAPI {
	registeredCommands.length = 0;
	return {
		setLabel: mock(() => {}),
		registerCommand: mock((name: string, spec: CommandSpec) => {
			registeredCommands.push({ name, spec });
		}),
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
		expect(api.registerShortcut).toHaveBeenCalledWith("ctrl+alt+t", expect.any(Object));
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
describe("telegram command registration", () => {
	it("registers a /telegram command with description, handler and argument completions", () => {
		const api = createFakeApi();
		desktopTagExtension(api);

		const telegram = registeredCommands.find(cmd => cmd.name === "telegram");
		expect(telegram).toBeDefined();
		expect(telegram?.spec.description).toBe("Telegram capture gateway daemon: /telegram on|off|status");
		expect(typeof telegram?.spec.handler).toBe("function");
		expect(typeof telegram?.spec.getArgumentCompletions).toBe("function");

		// Completions surface only valid action prefixes.
		const complete = telegram?.spec.getArgumentCompletions;
		expect(complete?.("s")?.map(item => item.value)).toEqual(["status"]);
		expect(complete?.("")).not.toBeNull();
		expect(complete?.("xyz")).toBeNull();
	});
});

describe("telegram command arguments", () => {
	it.each([
		["", "status"],
		["status", "status"],
		["STATUS", "status"],
		["on", "on"],
		["start", "on"],
		["off", "off"],
		["stop", "off"],
		["  on  extra", "on"],
	] as const)("parses %s -> %s", (args, expected) => {
		expect(parseTelegramCommandArgs(args)).toBe(expected);
	});

	it("rejects an unknown token with usage guidance", () => {
		expect(() => parseTelegramCommandArgs("bogus")).toThrow(TypeError);
		expect(() => parseTelegramCommandArgs("bogus")).toThrow("Usage: /telegram <on|off|status>");
	});
});

describe("warnIfTelegramUnconfigured", () => {
	it("notifies warning when Telegram config is disabled/missing, regardless of .env existence", async () => {
		const notifications: Array<{ message: string; type: string }> = [];
		await warnIfTelegramUnconfigured((message, type) => {
			notifications.push({ message, type });
		});
		expect(notifications.length).toBe(1);
		expect(notifications[0].type).toBe("warning");
		expect(notifications[0].message).toContain("No Telegram capture config visible");
	});
});
