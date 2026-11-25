import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

describe("IrcBridge disposal queue ownership", () => {
	afterEach(() => AgentRegistry.resetGlobalForTests());
	it("persists its pre-brief follow-up while leaving independently queued IRC for its owner", async () => {
		let disposed = false;
		const unrelated: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "saved restart input",
			display: true,
			timestamp: 1,
		};
		let followUps: AgentMessage[] = [unrelated];
		const persisted: unknown[] = [];
		const host = {
			agent: {
				followUp: (message: AgentMessage) => followUps.push(message),
				peekFollowUpQueue: () => followUps,
				replaceQueue: (_name: string, messages: AgentMessage[]) => {
					followUps = messages;
				},
			},
			sessionManager: { appendCustomMessageEntry: (...args: unknown[]) => persisted.push(args) },
			isRestartDraining: () => false,
			isDisposed: () => disposed,
			isStreaming: () => false,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
		} as unknown as IrcBridgeHost;
		AgentRegistry.global().register({
			id: "Child",
			displayName: "task",
			kind: "sub",
			status: "running",
			parentId: "Main",
			session: {} as AgentSession,
		});
		AgentRegistry.global().get("Child")!.initialPromptPending = true;
		const bridge = new IrcBridge(host);
		await bridge.deliver({ id: "before-brief", from: "Main", to: "Child", body: "parent instruction", ts: 2 });
		expect(followUps).toHaveLength(2);
		disposed = true;
		bridge.flushPending();
		expect(followUps).toEqual([unrelated]);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "before-brief" })]));
		bridge.flushPending();
		expect(persisted).toHaveLength(1);
	});
});
