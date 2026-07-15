import { describe, expect, it, vi } from "bun:test";
import type { CompactOptions } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import type { CompactMode } from "@pk-nerdsaver-ai/pi-coding-agent/session/compact-modes";
import { SNAPCOMPACT_RETIREMENT_ERROR } from "@pk-nerdsaver-ai/pi-coding-agent/session/compact-modes";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/types";

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
		for (const mode of ["soft", "remote"] as const satisfies readonly CompactMode[]) {
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

	it("rejects the removed snapcompact mode without compacting", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/compact snapcompact", h.runtime);
		expect(h.compact).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain(SNAPCOMPACT_RETIREMENT_ERROR);
	});

	it("advertises the mode subcommands and input hint to ACP clients", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "compact");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[soft|remote] [focus]");
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

	it("warns on the removed snapcompact mode and does not compact", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/compact snapcompact keep diffs", h.runtime);
		expect(h.handleCompactCommand).not.toHaveBeenCalled();
		expect(h.showWarning).toHaveBeenCalledWith(SNAPCOMPACT_RETIREMENT_ERROR);
	});
});
