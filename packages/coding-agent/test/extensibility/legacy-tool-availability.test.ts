import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { createBashToolDefinition, createCodingTools } from "../../src/extensibility/legacy-pi-coding-agent-shim";

describe("legacy tool availability (#11591)", () => {
	test("a standalone legacy bash definition omits the sqlite3-to-read steer", () => {
		// A legacy extension registering only bash supplies no `read` tool.
		// The factory session reports exactly the tool it created, so the
		// read-gated steer must stay silent instead of naming an
		// unregistered tool (Codex P2 3986069142).
		const bash = createBashToolDefinition(os.tmpdir());
		expect(bash.description).not.toContain("sqlite3");
	});
	test("a bundled legacy bash definition keeps the sqlite3-to-read steer", () => {
		// createCodingTools always registers read alongside bash, so the
		// bundle session must report read active and the read-gated steer
		// must render (Codex P2 3986602647).
		const tools = createCodingTools(os.tmpdir());
		const bash = tools.find(tool => tool.name === "bash");
		expect(bash?.description).toContain("sqlite3");
	});
});
