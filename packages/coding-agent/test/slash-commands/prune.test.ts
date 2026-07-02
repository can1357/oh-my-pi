import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/types";

function acpRuntime(result: { readonly prunedCount: number; readonly tokensSaved: number }) {
	const prune = vi.fn(async () => result);
	const output = vi.fn();
	const runtime = { session: { prune }, output } as unknown as SlashCommandRuntime;
	return { output, prune, runtime };
}

function tuiRuntime(result: { readonly prunedCount: number; readonly tokensSaved: number }) {
	const prune = vi.fn(async () => result);
	const rebuildChatFromMessages = vi.fn();
	const requestRender = vi.fn();
	const setText = vi.fn();
	const showStatus = vi.fn();
	const statusLineInvalidate = vi.fn();
	const updateEditorTopBorder = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			rebuildChatFromMessages,
			session: { prune },
			showStatus,
			statusLine: { invalidate: statusLineInvalidate } as unknown as InteractiveModeContext["statusLine"],
			ui: { requestRender } as unknown as InteractiveModeContext["ui"],
			updateEditorTopBorder,
		} as unknown as InteractiveModeContext,
	};
	return {
		prune,
		rebuildChatFromMessages,
		requestRender,
		runtime,
		setText,
		showStatus,
		statusLineInvalidate,
		updateEditorTopBorder,
	};
}

describe("/prune dispatch (ACP)", () => {
	it("runs session pruning and reports saved tokens", async () => {
		const h = acpRuntime({ prunedCount: 2, tokensSaved: 1234 });

		const result = await executeAcpBuiltinSlashCommand("/prune", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.prune).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Prune complete. Pruned 2 tool results, saved 1234 tokens.");
	});

	it("reports when no stale tool results exist", async () => {
		const h = acpRuntime({ prunedCount: 0, tokensSaved: 0 });

		await executeAcpBuiltinSlashCommand("/prune", h.runtime);

		expect(h.output).toHaveBeenCalledWith("Prune complete. No stale tool results found.");
	});

	it("is advertised to ACP clients without an input hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "prune");
		expect(advertised).toBeDefined();
		expect(advertised?.input).toBeUndefined();
	});
});

describe("/prune dispatch (TUI)", () => {
	it("clears the editor, prunes, rebuilds visible context, and shows status", async () => {
		const h = tuiRuntime({ prunedCount: 1, tokensSaved: 512 });

		const handled = await executeBuiltinSlashCommand("/prune", h.runtime);

		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.prune).toHaveBeenCalledTimes(1);
		expect(h.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Prune complete. Pruned 1 tool result, saved 512 tokens.");
		expect(h.statusLineInvalidate).toHaveBeenCalledTimes(1);
		expect(h.updateEditorTopBorder).toHaveBeenCalledTimes(1);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not rebuild the transcript when pruning is a no-op", async () => {
		const h = tuiRuntime({ prunedCount: 0, tokensSaved: 0 });

		await executeBuiltinSlashCommand("/prune", h.runtime);

		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Prune complete. No stale tool results found.");
	});
});
