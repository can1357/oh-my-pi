// Issue #11347: with fetch.enabled=false the runtime gates reject URL reads,
// but the model-facing copy still advertises them. When disabled, the read
// description and path schema must not mention web URL reads.
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

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
