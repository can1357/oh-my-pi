import { describe, expect, it, vi } from "bun:test";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime({
	isStreaming = false,
	isGeneratingHandoff = false,
	handoffResult,
	handoffError,
}: {
	isStreaming?: boolean;
	isGeneratingHandoff?: boolean;
	handoffResult?: unknown;
	handoffError?: Error;
}) {
	const handoff = vi.fn(async () => {
		if (handoffError) throw handoffError;
		return handoffResult;
	});
	const output = vi.fn();
	const runtime = {
		session: { isStreaming, isGeneratingHandoff, handoff },
		output,
	} as unknown as SlashCommandRuntime;
	return { handoff, output, runtime };
}

describe("/handoff dispatch (ACP)", () => {
	it("refuses to hand off while streaming", async () => {
		const h = acpRuntime({ isStreaming: true });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.handoff).not.toHaveBeenCalled();
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("before handing off");
	});

	it("refuses to hand off while a handoff is already generating", async () => {
		const h = acpRuntime({ isGeneratingHandoff: true });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.handoff).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Handoff generation is already in progress.");
	});

	it("passes focus instructions through, undefined when bare", async () => {
		const h1 = acpRuntime({ handoffResult: { document: "doc" } });
		await executeAcpBuiltinSlashCommand("/handoff focus on auth", h1.runtime);
		expect(h1.handoff).toHaveBeenCalledWith("focus on auth");

		const h2 = acpRuntime({ handoffResult: { document: "doc" } });
		await executeAcpBuiltinSlashCommand("/handoff", h2.runtime);
		expect(h2.handoff).toHaveBeenCalledWith(undefined);
	});

	it("leaves the RPC command queue free while handoff generation runs", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffFinished = Promise.withResolvers<{ document: string }>();
		const h = acpRuntime({});
		h.handoff.mockImplementation(async () => {
			handoffStarted.resolve();
			return await handoffFinished.promise;
		});
		const backgroundTasks: Promise<void>[] = [];
		h.runtime.runCommandInBackground = task => {
			backgroundTasks.push(task());
		};

		const result = await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		await handoffStarted.promise;
		expect(result).toEqual({ consumed: true });
		expect(h.output).not.toHaveBeenCalled();

		handoffFinished.resolve({ document: "doc" });
		await Promise.all(backgroundTasks);
		expect(h.output).toHaveBeenCalledWith("Context handed off and compacted in place.");
	});

	it("reports success as a single line and never reports a saved path", async () => {
		// `SessionHandoff` only writes the document to disk under
		// `options.autoTriggered`, which the user-invoked path never passes, so
		// `savedPath` is unreachable here even when the type allows it.
		const h = acpRuntime({ handoffResult: { document: "doc", savedPath: "/tmp/handoff.md" } });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledTimes(1);
		expect(h.output).toHaveBeenCalledWith("Context handed off and compacted in place.");
	});

	it("reports cancellation when the handoff resolves undefined", async () => {
		const h = acpRuntime({ handoffResult: undefined });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff cancelled.");
	});

	it("reports cancellation without the failed prefix when the handoff throws cancellation", async () => {
		const h = acpRuntime({ handoffError: new Error("Handoff cancelled") });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff cancelled.");
	});

	it("stays silent when the owning turn was cancelled by the user", async () => {
		// ACP `session/cancel` aborts with USER_INTERRUPT_LABEL, which
		// `throwIfHandoffAborted` rethrows verbatim. The turn has already
		// resolved as `cancelled`, so any output here would be an out-of-turn
		// chunk reporting a false failure.
		const h = acpRuntime({ handoffError: new Error(USER_INTERRUPT_LABEL) });
		const result = await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
	});

	it("surfaces other failures behind the Handoff failed prefix", async () => {
		const h = acpRuntime({ handoffError: new Error("Nothing to hand off (no messages yet)") });
		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Handoff failed: Nothing to hand off (no messages yet)");
	});

	it("is advertised with the focus hint and the ACP description", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "handoff");
		expect(advertised?.input?.hint).toBe("[focus instructions]");
		expect(advertised?.description).toBe("Summarize the session into a handoff document and compact in place");
	});
});
