// The advisor's full-transcript replays re-send the entire primary history and
// force the provider to re-prefill from the system prompt. Until now none of
// the reset paths logged anything, making production replay storms
// undiagnosable. These tests pin the observability contract: every reset path
// emits a structured debug event, and the delivered-prefix path reports which
// message diverged and which fields changed.
import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

import {
	type AdvisorAgent,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorRuntimeHost,
} from "../../src/advisor/runtime";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

function hasResetReason(details: unknown, reason: string): details is { reason: string } {
	return typeof details === "object" && details !== null && "reason" in details && details.reason === reason;
}

describe("advisor context reset observability", () => {
	it("logs the diverging message and differing fields when the delivered prefix changes", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const messages: AgentMessage[] = [userMessage("turn one body", 1), userMessage("turn two body", 2)];
			const prompts: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async (input: string) => {
					prompts.push(input);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);

			runtime.onTurnEnd();
			expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);

			// Replace a delivered message with a changed clone, then grow the tail.
			messages[0] = userMessage("turn one body EDITED", 1);
			messages.push(userMessage("turn three body", 3));
			runtime.onTurnEnd();
			expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);

			const events = debugSpy.mock.calls.map(call => ({ message: call[0], details: call[1] }));
			const divergence = events.find(event => event.message === "advisor delivered prefix changed");
			expect(divergence).toBeDefined();
			const divergenceDetails = divergence?.details as { index: number; differingFields: string[] };
			expect(divergenceDetails.index).toBe(0);
			expect(divergenceDetails.differingFields).toContain("content");

			const reset = events.find(
				event =>
					event.message === "advisor context reset" &&
					(event.details as { reason: string }).reason === "delivered-prefix-changed",
			);
			expect(reset).toBeDefined();
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("logs the caller-supplied reason on external reset (compaction/shake/prune triggers)", () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const agent: AdvisorAgent = {
				prompt: async () => {},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const host: AdvisorRuntimeHost = {
				snapshotMessages: () => [],
				enqueueAdvice: () => {},
			};
			const runtime = new AdvisorRuntime(agent, host);

			runtime.reset("auto-compaction");

			const events = debugSpy.mock.calls.map(call => ({ message: call[0], details: call[1] }));
			const reset = events.find(
				event =>
					event.message === "advisor context reset" &&
					(event.details as { reason: string }).reason === "auto-compaction",
			);
			expect(reset).toBeDefined();
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("logs quarantine reset reasons while preserving the retry limit", async () => {
		const recoveryLogged = Promise.withResolvers<void>();
		const exhaustedLogged = Promise.withResolvers<void>();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation((message, details) => {
			if (message !== "advisor context reset") return;
			if (hasResetReason(details, "quarantine-recovery")) recoveryLogged.resolve();
			if (hasResetReason(details, "quarantine-retry-exhausted")) exhaustedLogged.resolve();
		});
		try {
			const messages: AgentMessage[] = [userMessage("turn body", 1)];
			let agentResetCalls = 0;
			const failures: unknown[] = [];
			const agent: AdvisorAgent = {
				prompt: async () => {
					throw new AdvisorOutputQuarantinedError("quarantined");
				},
				abort: () => {},
				reset: () => {
					agentResetCalls++;
				},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
				notifyFailure: error => failures.push(error),
			});

			runtime.onTurnEnd();
			await recoveryLogged.promise;
			runtime.onTurnEnd();
			await exhaustedLogged.promise;

			const events = debugSpy.mock.calls.map(call => ({ message: call[0], details: call[1] }));
			expect(
				events.some(
					event =>
						event.message === "advisor context reset" && hasResetReason(event.details, "quarantine-recovery"),
				),
			).toBe(true);
			expect(
				events.some(
					event =>
						event.message === "advisor context reset" &&
						hasResetReason(event.details, "quarantine-retry-exhausted"),
				),
			).toBe(true);
			expect(agentResetCalls).toBe(2);
			expect(failures).toHaveLength(1);
			expect(failures[0]).toBeInstanceOf(AdvisorOutputQuarantinedError);
		} finally {
			debugSpy.mockRestore();
		}
	});
});
