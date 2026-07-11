import { describe, expect, test } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_SCHEMA_TOKENS,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/mode";

describe("tool discovery schema-token budget (U9)", () => {
	test("auto stays off when both count and schema spend are under budget", () => {
		const settings = Settings.isolated({});
		expect(resolveEffectiveToolDiscoveryMode(settings, 10, 1_000)).toBe("off");
	});

	test("auto flips to mcp-only when schema spend crosses the budget despite a small tool count", () => {
		const settings = Settings.isolated({});
		expect(resolveEffectiveToolDiscoveryMode(settings, 10, TOOL_DISCOVERY_AUTO_SCHEMA_TOKENS + 1)).toBe("mcp-only");
	});

	test("count threshold keeps working without schema info", () => {
		const settings = Settings.isolated({});
		expect(resolveEffectiveToolDiscoveryMode(settings, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});

	test("explicit off wins over the schema budget", () => {
		const settings = Settings.isolated({ "tools.discoveryMode": "off" });
		expect(resolveEffectiveToolDiscoveryMode(settings, 100, 1_000_000)).toBe("off");
	});
});
