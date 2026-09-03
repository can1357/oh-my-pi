import { describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { CompactMode } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const compact = vi.fn(async (_instructions?: string, _options?: CompactOptions) => {});
	const getContextUsage = vi.fn(() => undefined);
	const output = vi.fn();
	const runtime = { session: { compact, getContextUsage }, output } as unknown as SlashCommandRuntime;
	return { compact, output, runtime };
}

function tuiRuntime() {
	const handleCompactCommand = vi.fn(async () => "ok" as const);
	const setText = vi.fn();
	const showWarning = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			handleCompactCommand,
			showWarning,
		} as unknown as InteractiveModeContext,
	};
	return { handleCompactCommand, setText, showWarning, runtime };
}

describe("/compact dispatch (ACP)", () => {
	it("compacts with the configured strategy and no mode for a bare invocation", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		expect(h.compact).toHaveBeenCalledWith(undefined, undefined);
	});

	it("threads each mode subcommand into compact()", async () => {
		for (const mode of ["soft", "remote", "snapcompact"] as const satisfies readonly CompactMode[]) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(`/compact ${mode}`, h.runtime);
			expect(h.compact).toHaveBeenCalledWith(undefined, { mode });
		}
	});

	it("splits a mode from its focus instructions", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact soft focus on the parser", h.runtime);
		expect(h.compact).toHaveBeenCalledWith("focus on the parser", { mode: "soft" });
	});

	it("treats a non-mode argument as plain focus instructions (backward compatible)", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/compact summarize the auth flow", h.runtime);
		expect(h.compact).toHaveBeenCalledWith("summarize the auth flow", undefined);
	});

	it("rejects focus text on snapcompact without compacting", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/compact snapcompact keep the diffs", h.runtime);
		expect(h.compact).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("snapcompact");
	});

	it("leaves the RPC command queue free while compaction runs", async () => {
		const compactStarted = Promise.withResolvers<void>();
		const compactFinished = Promise.withResolvers<void>();
		const h = acpRuntime();
		h.compact.mockImplementation(async () => {
			compactStarted.resolve();
			await compactFinished.promise;
		});
		const backgroundTasks: Promise<void>[] = [];
		h.runtime.runCommandInBackground = task => {
			backgroundTasks.push(task());
		};

		// The dispatcher must resolve before compaction finishes so the RPC
		// serialized queue can dequeue a follow-up abort.
		const result = await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		await compactStarted.promise;
		expect(result).toEqual({ consumed: true });
		expect(h.output).not.toHaveBeenCalled();

		compactFinished.resolve();
		await Promise.all(backgroundTasks);
		expect(h.output).toHaveBeenCalledWith("Compaction complete.");
	});

	it("stays silent when compaction is cancelled by a user interrupt", async () => {
		const h = acpRuntime();
		h.compact.mockImplementation(async () => {
			throw new CompactionCancelledError(undefined, { cause: USER_INTERRUPT_LABEL });
		});
		const backgroundTasks: Promise<void>[] = [];
		h.runtime.runCommandInBackground = task => {
			backgroundTasks.push(task());
		};

		const result = await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		expect(result).toEqual({ consumed: true });
		await Promise.all(backgroundTasks);
		expect(h.output).not.toHaveBeenCalled();
	});

	it("surfaces extension cancellation instead of treating it as a user interrupt", async () => {
		const h = acpRuntime();
		h.compact.mockImplementation(async () => {
			throw new CompactionCancelledError();
		});

		await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Compaction failed: Compaction cancelled");
	});

	it("surfaces other failures behind the Compaction failed prefix", async () => {
		const h = acpRuntime();
		h.compact.mockImplementation(async () => {
			throw new Error("no model selected");
		});

		await executeAcpBuiltinSlashCommand("/compact", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Compaction failed: no model selected");
	});

	it("advertises the mode subcommands and input hint to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "compact");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[soft|remote|snapcompact] [focus]");
	});
});

describe("/compact dispatch (TUI)", () => {
	it("routes mode + focus to handleCompactCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/compact soft fix the bug", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handleCompactCommand).toHaveBeenCalledWith("fix the bug", "soft");
	});

	it("passes no mode for a bare /compact", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/compact", h.runtime);
		expect(h.handleCompactCommand).toHaveBeenCalledWith(undefined, undefined);
	});

	it("warns on snapcompact + focus text and does not compact", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/compact snapcompact keep diffs", h.runtime);
		expect(h.handleCompactCommand).not.toHaveBeenCalled();
		expect(h.showWarning).toHaveBeenCalled();
	});
});
