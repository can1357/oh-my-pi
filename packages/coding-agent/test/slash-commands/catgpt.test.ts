import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const output = vi.fn();
	return {
		setText,
		showStatus,
		showError,
		present,
		output,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
				showError,
				present,
				sessionManager: {
					getCwd: vi.fn(() => process.cwd()),
				} as unknown as InteractiveModeContext["sessionManager"],
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("catgpt slash commands", () => {
	it("should execute /catgpt-fast and invoke handler", async () => {
		const harness = createRuntime();
		// Mock fetch globally
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => {
			return {
				ok: true,
				json: async () => ({
					choices: [{ message: { content: "Fast answer response" } }],
				}),
			} as Response;
		});

		try {
			const handled = await executeBuiltinSlashCommand("/catgpt-fast Tell me about fast mode", harness.runtime);
			expect(handled).toBe(true);
			expect(harness.setText).toHaveBeenCalledWith("");
			expect(globalThis.fetch).toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("should execute /catgpt-pro and invoke handler", async () => {
		const harness = createRuntime();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => {
			return {
				ok: true,
				json: async () => ({
					choices: [{ message: { content: "Pro answer response" } }],
				}),
			} as Response;
		});

		try {
			const handled = await executeBuiltinSlashCommand("/catgpt-pro Do deep thinking", harness.runtime);
			expect(handled).toBe(true);
			expect(harness.setText).toHaveBeenCalledWith("");
			expect(globalThis.fetch).toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
