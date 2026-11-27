import { describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const shake = vi.fn(async (mode: ShakeMode) => ({
		mode,
		toolResultsDropped: 1,
		blocksDropped: 0,
		imagesDropped: mode === "images" ? 1 : undefined,
		tokensFreed: 100,
	}));
	const output = vi.fn();
	const runtime = { session: { shake }, output } as unknown as SlashCommandRuntime;
	return { shake, output, runtime };
}

function tuiRuntime() {
	const handleShakeCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const showWarning = vi.fn();
	const runtime = {
		ctx: {
			composer: { setText } as unknown as InteractiveModeContext["composer"],
			handleShakeCommand,
			showWarning,
		} as unknown as InteractiveModeContext,
	};
	return { handleShakeCommand, setText, showWarning, runtime };
}

describe("/shake dispatch (ACP)", () => {
	it("defaults to elide with no subcommand", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/shake", h.runtime);
		expect(h.shake).toHaveBeenCalledWith("elide");
	});

	it("parses each explicit mode", async () => {
		for (const mode of ["elide", "images", "thinking"] as const) {
			const h = acpRuntime();
			await executeAcpBuiltinSlashCommand(`/shake ${mode}`, h.runtime);
			expect(h.shake).toHaveBeenCalledWith(mode);
		}
	});

	it("rejects an unknown mode without invoking shake", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/shake bogus", h.runtime);
		expect(h.shake).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true, failed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("bogus");
	});
});

describe("/shake dispatch (TUI)", () => {
	it("routes the parsed mode to handleShakeCommand and clears the editor", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/shake images", h.runtime);
		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		expect(h.handleShakeCommand).toHaveBeenCalledWith("images");
	});

	it("defaults to elide for a bare /shake", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake", h.runtime);
		expect(h.handleShakeCommand).toHaveBeenCalledWith("elide");
	});

	it("warns on an unknown mode and does not run a shake", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake nope", h.runtime);
		expect(h.handleShakeCommand).not.toHaveBeenCalled();
		expect(h.showWarning).toHaveBeenCalled();
	});
});
describe("CommandController /shake", () => {
	it.each([
		{ thinkingBlocksDropped: 2, interruptedThinkingNotesDropped: 0, description: "2 thinking blocks" },
		{ thinkingBlocksDropped: 0, interruptedThinkingNotesDropped: 1, description: "1 interrupted-thinking note" },
	])("reports $description and rebuilds the transcript", async ({ description, ...counts }) => {
		const rebuildChatFromMessages = vi.fn();
		const refresh = vi.fn();
		const replayHistory = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: {
				shake: vi.fn(async () => ({
					mode: "thinking" as const,
					toolResultsDropped: 0,
					blocksDropped: 0,
					...counts,
					tokensFreed: 0,
				})),
			},
			rebuildChatFromMessages,
			statusLine: { refresh },
			shell: { host: { replayHistory } },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleShakeCommand("thinking");

		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(replayHistory).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(`Dropped ${description} from this session.`);
	});

	it("reports kept thinking without rebuilding the transcript", async () => {
		const rebuildChatFromMessages = vi.fn();
		const refresh = vi.fn();
		const replayHistory = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: {
				shake: vi.fn(async () => ({
					mode: "thinking" as const,
					toolResultsDropped: 0,
					blocksDropped: 0,
					thinkingBlocksDropped: 0,
					thinkingBlocksKept: 3,
					tokensFreed: 0,
				})),
			},
			rebuildChatFromMessages,
			statusLine: { refresh },
			shell: { host: { replayHistory } },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleShakeCommand("thinking");

		// Nothing changed on disk or on screen, so only the status line speaks.
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(replayHistory).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledTimes(1);
		const status = showStatus.mock.calls[0]?.[0] as string;
		expect(status).toContain("3 thinking blocks");
		expect(status).toContain("kept");
	});
});
