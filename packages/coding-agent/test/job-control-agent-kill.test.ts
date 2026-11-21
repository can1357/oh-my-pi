import { describe, expect, it } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("proc://<id>/kill of a running subagent", () => {
	it("records the parent agent's kill on the child's transcript instead of a user interrupt", async () => {
		const tempDir = TempDir.createSync("@pi-agent-kill-label-");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const streaming = Promise.withResolvers<void>();
		const endedAssistants: AssistantMessage[] = [];
		const mock = createMockModel({
			responses: [
				() => {
					streaming.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const sessionManager = SessionManager.inMemory();
		const child = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		child.agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") endedAssistants.push(event.message);
		});
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: child });
		const manager = new AsyncJobManager({});
		const parent = {
			cwd: process.cwd(),
			hasUI: false,
			getAgentId: () => "Main",
			asyncJobManager: manager,
			agentRegistry: registry,
			settings: Settings.isolated({ "launch.enabled": false }),
		} as unknown as ToolSession;
		try {
			void child.prompt("work until stopped");
			await streaming.promise;

			const killed = await new ProcProtocolHandler().write(parseInternalUrl("proc://Worker/kill"), "", {
				session: parent,
			});
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Worker", status: "cancelled" }] });

			const aborted = endedAssistants.findLast(message => message.stopReason === "aborted");
			if (!aborted) throw new Error("Expected aborted assistant turn");
			expect(aborted.errorMessage).toBe("Stopped by parent agent");
			// The kill still counts as a deliberate interrupt, so runtime handling is unchanged.
			expect(isUserInterruptAbort(aborted)).toBe(true);
		} finally {
			await child.dispose();
			await manager.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});
});
