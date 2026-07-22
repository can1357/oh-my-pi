import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

function createHarness() {
	const showStatus = vi.fn();
	const setText = vi.fn();
	const getCwd = vi.fn(() => process.cwd());

	const ctx = {
		collabGuest: false,
		showStatus,
		editor: { setText },
		sessionManager: { getCwd },
		settings: { get: vi.fn() },
	} as unknown as InteractiveModeContext;

	return { runtime: { ctx }, showStatus, setText };
}

describe("/graphtree slash command", () => {
	it("renders graph tree status output", async () => {
		const { runtime, showStatus } = createHarness();
		await executeBuiltinSlashCommand("/graphtree", runtime);
		expect(showStatus).toHaveBeenCalled();
		const outputText = showStatus.mock.calls[0][0];
		expect(outputText).toContain("Fractal GraphTree Workflows");
	});

	it("renders help output on /graphtree help", async () => {
		const { runtime, showStatus } = createHarness();
		await executeBuiltinSlashCommand("/graphtree help", runtime);
		expect(showStatus).toHaveBeenCalled();
		const outputText = showStatus.mock.calls[0][0];
		expect(outputText).toContain("Fractal GraphTree Workflow Commands:");
		expect(outputText).toContain("/graphtree init");
		expect(outputText).toContain("/graphtree run");
	});

	it("returns a prompt object for multi-agent execution on /graphtree run", async () => {
		const { runtime } = createHarness();
		const result = await executeBuiltinSlashCommand("/graphtree run refactor system authentication", runtime);
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result).toContain("FRACTAL GRAPHTREE MULTI-AGENT WORKFLOW");
		expect(result).toContain("refactor system authentication");
	});
});
