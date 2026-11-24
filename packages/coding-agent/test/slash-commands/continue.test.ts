import { describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const model = { api: "mock", provider: "mock", id: "mock-model" } as unknown as Model;

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(stopReason: AssistantMessage["stopReason"], additions?: Partial<AssistantMessage>) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
		...additions,
	} as AssistantMessage;
}

function createTuiRuntime(options: { isStreaming?: boolean; resumed?: boolean; messages?: unknown[] }) {
	const continueInterrupted = vi.fn(() => options.resumed ?? false);
	const resume = vi.fn(async () => {});
	const setText = vi.fn();
	const showError = vi.fn();
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			session: {
				isStreaming: options.isStreaming ?? false,
				continueInterrupted,
				resume,
				messages: options.messages ?? [],
			} as unknown as InteractiveModeContext["session"],
			composer: { setText } as unknown as InteractiveModeContext["composer"],
			showError,
			showStatus,
		} as unknown as InteractiveModeContext,
	} satisfies TuiSlashCommandRuntime;
	return { continueInterrupted, resume, setText, showError, showStatus, runtime };
}

describe("/continue slash command (TUI)", () => {
	it("continues from context through the shared resume path when the last turn is complete", async () => {
		const harness = createTuiRuntime({ resumed: false, messages: [userMessage("hi"), assistant("stop")] });

		const handled = await executeBuiltinSlashCommand("/continue", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.continueInterrupted).toHaveBeenCalledTimes(1);
		expect(harness.resume).toHaveBeenCalledTimes(1);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("resumes an interrupted turn without surfacing an error", async () => {
		const harness = createTuiRuntime({ resumed: true });

		const handled = await executeBuiltinSlashCommand("/continue", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.continueInterrupted).toHaveBeenCalledTimes(1);
		expect(harness.resume).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
	});

	it("reports the busy state instead of nothing-to-continue while streaming", async () => {
		const harness = createTuiRuntime({ isStreaming: true });

		await executeBuiltinSlashCommand("/continue", harness.runtime);

		expect(harness.continueInterrupted).not.toHaveBeenCalled();
		expect(harness.resume).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
		expect((harness.showStatus.mock.calls[0]?.[0] as string) ?? "").toContain("Busy");
	});

	it("describes resumability from the live transcript", () => {
		const spec = BUILTIN_LIFECYCLE_SLASH_COMMANDS.find(c => c.name === "continue");
		if (!spec?.getTuiAutocompleteDescription) throw new Error("/continue has no autocomplete description");

		const settled = createTuiRuntime({ messages: [userMessage("hi"), assistant("stop")] });
		const interrupted = createTuiRuntime({
			messages: [userMessage("hi"), assistant("aborted", { errorMessage: USER_INTERRUPT_LABEL })],
		});

		expect(spec.getTuiAutocompleteDescription(settled.runtime)).toBe(
			"Continue: nothing interrupted — continues from context",
		);
		expect(spec.getTuiAutocompleteDescription(interrupted.runtime)).toBe("Continue: resumable interrupted turn");
	});
});

function acpRuntime({ isStreaming = false, resumed = false }: { isStreaming?: boolean; resumed?: boolean }) {
	const continueInterrupted = vi.fn(() => resumed);
	const resume = vi.fn(async () => {});
	const keepTurnOpenUntilIdle = vi.fn(async () => {});
	const output = vi.fn();
	return {
		continueInterrupted,
		resume,
		keepTurnOpenUntilIdle,
		output,
		runtime: {
			session: { isStreaming, continueInterrupted, resume },
			output,
			keepTurnOpenUntilIdle,
		} as unknown as SlashCommandRuntime,
	};
}

describe("/continue dispatch (ACP)", () => {
	it("refuses to continue while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });

		const result = await executeAcpBuiltinSlashCommand("/continue", h.runtime);

		expect(h.continueInterrupted).not.toHaveBeenCalled();
		expect(h.resume).not.toHaveBeenCalled();
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before continuing");
		expect(result).toEqual({ consumed: true, failed: true });
	});

	it("continues from context and keeps its ACP turn open when there is nothing interrupted", async () => {
		const h = acpRuntime({ resumed: false });

		const result = await executeAcpBuiltinSlashCommand("/continue", h.runtime);

		expect(h.resume).toHaveBeenCalledTimes(1);
		expect(h.output).not.toHaveBeenCalled();
		expect(h.keepTurnOpenUntilIdle).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("announces the continuation and holds the ACP turn open", async () => {
		const h = acpRuntime({ resumed: true });

		const result = await executeAcpBuiltinSlashCommand("/continue", h.runtime);

		expect(h.output).toHaveBeenCalledWith("Continuing the interrupted turn.");
		expect(h.keepTurnOpenUntilIdle).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true, agentInvoked: true });
	});

	it("is advertised to ACP clients", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "continue")).toBeDefined();
	});
});
