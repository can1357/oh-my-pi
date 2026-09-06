import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime(didRetry: boolean) {
	const retry = vi.fn(async () => didRetry);
	const showStatus = vi.fn();
	const setText = vi.fn();
	return {
		retry,
		showStatus,
		setText,
		runtime: {
			ctx: {
				session: { retry } as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/retry slash command", () => {
	it("clears the editor after starting a retry", async () => {
		const harness = createRuntime(true);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports when there is no failed turn to retry", async () => {
		const harness = createRuntime(false);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

function acpRuntime({
	isStreaming = false,
	retryResult = false,
	withKeepOpen = true,
}: {
	isStreaming?: boolean;
	retryResult?: boolean;
	withKeepOpen?: boolean;
}) {
	const retry = vi.fn(async () => retryResult);
	const keepTurnOpenUntilIdle = vi.fn(async () => {});
	const output = vi.fn();
	const runtime = {
		session: { isStreaming, retry },
		output,
		...(withKeepOpen ? { keepTurnOpenUntilIdle } : {}),
	} as unknown as SlashCommandRuntime;
	return { retry, keepTurnOpenUntilIdle, output, runtime };
}

describe("/retry dispatch (ACP)", () => {
	it("refuses to retry while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.retry).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before retrying");
	});

	it("reports when there is nothing to retry", async () => {
		const h = acpRuntime({ retryResult: false });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Nothing to retry.");
		expect(h.keepTurnOpenUntilIdle).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
	});

	it("announces the retry and holds the ACP turn open for the retried turn", async () => {
		const h = acpRuntime({ retryResult: true });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.output.mock.calls[0]?.[0]).toBe("Retrying the last failed turn.");
		expect(h.keepTurnOpenUntilIdle).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("returns immediately for hosts that stream the continuation themselves (RPC/TUI)", async () => {
		// RPC's `prompt` awaits this dispatcher before responding and serializes
		// later frames, so blocking here would break `RpcClient.prompt()`'s
		// documented immediate return and strand a follow-up `abort`.
		const h = acpRuntime({ retryResult: true, withKeepOpen: false });
		const result = await executeAcpBuiltinSlashCommand("/retry", h.runtime);
		expect(h.retry).toHaveBeenCalledTimes(1);
		expect(h.output.mock.calls[0]?.[0]).toBe("Retrying the last failed turn.");
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("reports a scheduled retry as agent work, and a no-op retry as local-only", async () => {
		// RPC maps a bare `{ consumed: true }` to `agentInvoked: false`. A
		// successful retry schedules an `agent.continue()` turn, so reporting
		// local-only there would have the host finalize the request while the
		// retried turn is still streaming.
		const scheduled = await executeAcpBuiltinSlashCommand("/retry", acpRuntime({ retryResult: true }).runtime);
		const noop = await executeAcpBuiltinSlashCommand("/retry", acpRuntime({ retryResult: false }).runtime);
		expect(scheduled).toEqual({ consumed: true, agentInvoked: true });
		expect(noop).toEqual({ consumed: true });
	});

	it("is advertised to ACP clients", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "retry")).toBeDefined();
	});
});
