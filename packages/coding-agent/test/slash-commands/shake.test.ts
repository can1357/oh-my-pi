import { describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
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
			editor: { setText } as unknown as InteractiveModeContext["editor"],
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
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("bogus");
	});

	it("is advertised to ACP clients with the mode hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "shake");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("[elide|images|thinking]");
	});

	it("advertises /shake images as the image-stripping path and no longer advertises /drop-images", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(c => c.name === "shake")).toBe(true);
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(c => c.name === "drop-images")).toBe(false);
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
	it("reports thinking-only drops and rebuilds the transcript", async () => {
		const rebuildChatFromMessages = vi.fn();
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: {
				shake: vi.fn(async () => ({
					mode: "thinking" as const,
					toolResultsDropped: 0,
					blocksDropped: 0,
					thinkingBlocksDropped: 2,
					tokensFreed: 0,
				})),
			},
			rebuildChatFromMessages,
			statusLine: { invalidate },
			ui: { requestRender },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleShakeCommand("thinking");

		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Dropped 2 thinking blocks from this session.");
	});
});
