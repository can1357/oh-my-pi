import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/mode";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(settings: Settings, toolCount = 0): "off" | "mcp-only" | "all" {
		return resolveEffectiveToolDiscoveryMode(settings, toolCount);
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true → mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	it("default settings resolve to all (lean prompt, everything discoverable)", () => {
		const s = Settings.isolated({});
		expect(s.get("tools.discoveryMode")).toBe("all");
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("explicit auto stays off at the threshold", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "auto" });
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD)).toBe("off");
	});

	it("explicit auto enables mcp-only above the threshold", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "auto" });
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});
});
