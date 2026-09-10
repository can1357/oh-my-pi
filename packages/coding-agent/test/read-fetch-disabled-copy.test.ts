// Issue #11347: with fetch.enabled=false the runtime gates reject URL reads,
// but the model-facing copy still advertises them. When disabled, the read
// description and path schema must not mention web URL reads.
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WebSearchTool, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";

function createSession(fetchEnabled: boolean): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "fetch.enabled": fetchEnabled, "images.autoResize": false }),
		getImageAttachments: () => [],
	} as unknown as ToolSession;
}

describe("read URL copy follows fetch.enabled", () => {
	test("disabled: description does not advertise web URL reads", () => {
		const tool = new ReadTool(createSession(false));
		expect(tool.description).not.toContain("web URLs");
		expect(tool.description).not.toContain("for web content");
	});

	test("disabled: path schema does not advertise URL input", () => {
		const tool = new ReadTool(createSession(false));
		expect(JSON.stringify(tool.parameters.toJsonSchema())).not.toContain("or URL");
	});

	test("enabled: description still advertises web URL reads", () => {
		const tool = new ReadTool(createSession(true));
		expect(tool.description).toContain("web URLs");
	});
});

describe("web_search read-URL handoff follows fetch.enabled", () => {
	test("disabled: description does not steer into the blocked read-URL route", () => {
		const tool = new WebSearchTool(createSession(false));
		expect(tool.description).not.toContain("`read` URL directly");
	});

	test("enabled: description keeps the read-URL handoff", () => {
		const tool = new WebSearchTool(createSession(true));
		expect(tool.description).toContain("`read` URL directly");
	});
});

describe("web_search custom-tool copy without a global store", () => {
	test("renders without throwing when Settings.init() never ran", () => {
		// The global settings proxy throws outside a session; the singleton
		// copy must fall back instead of breaking embedder session creation.
		const description: string = webSearchCustomTool.description;
		expect(description).toContain("Web search");
	});
});
