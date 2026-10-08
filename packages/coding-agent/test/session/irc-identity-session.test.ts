import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";

// These tests use only the synthetic stream function. No provider request or task is started.
describe("IRC identity through AgentSession", () => {
	it("persists both parent IDs and a same-ID peer through the real message_end path", async () => {
		using temp = TempDir.createSync("@omp-irc-session-");
		const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		const manager = SessionManager.inMemory(temp.path());
		const recipient = "IrcIdentityRecipient";
		const parent = "IrcIdentityParent";
		const first: IrcMessage = { id: "same-id", from: parent, to: recipient, body: "synthetic update", ts: 42 };
		let session: AgentSession | undefined;
		const mock = createMockModel({
			provider: "openai", id: "synthetic-irc-model",
			responses: [async () => {
				await session!.deliverIrcMessage(first);
				await session!.deliverIrcMessage(first);
				await session!.deliverIrcMessage({ ...first, id: "second-id" });
				await session!.deliverIrcMessage({ ...first, from: "IrcIdentityPeer" });
				return { content: ["synthetic initial response"] };
			}],
			handler: { content: ["synthetic final response"] },
		});
		const agent = new Agent({
			getApiKey: () => "synthetic-key",
			initialState: { model: mock.model, tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const registry = AgentRegistry.global();
		try {
			session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: new ModelRegistry(auth), agentId: recipient });
			const ref = registry.register({ id: recipient, displayName: "synthetic recipient", kind: "sub", parentId: parent, session });
			try {
				await session.prompt("synthetic initial request");
				await session.waitForIdle();
				const saved = manager.cloneCurrentSession({ persist: false });
				expect(saved.hasReceivedIrcMessage(parent, "same-id")).toBe(true);
				expect(saved.hasReceivedIrcMessage(parent, "second-id")).toBe(true);
				expect(saved.hasReceivedIrcMessage("IrcIdentityPeer", "same-id")).toBe(true);
				const incoming = saved.getEntries().filter(entry =>
					(entry.type === "message" && entry.message.role === "user" && "ircSource" in entry.message) ||
					(entry.type === "custom_message" && entry.customType === "irc:incoming"),
				);
				expect(incoming).toHaveLength(3);
				const provider = convertToLlm(saved.buildSessionContext().messages);
				expect(provider.filter(message => message.role === "user" && "ircSource" in message)).toHaveLength(2);
				const peerMessages = provider.filter(message =>
					message.role === "developer" &&
					JSON.stringify(message.content).includes("IrcIdentityPeer"),
				);
				expect(peerMessages).toHaveLength(1);
				expect(peerMessages[0]?.attribution).toBe("agent");
				const providerView = mock.calls.at(-1)!.context.messages;
				expect(providerView.filter(message => message.role === "user" && "ircSource" in message)).toHaveLength(2);
				const callCount = mock.calls.length;
				await session.deliverIrcMessage(first);
				await session.deliverIrcMessage({ ...first, id: "second-id" });
				await session.deliverIrcMessage({ ...first, from: "IrcIdentityPeer" });
				expect(agent.peekSteeringQueue()).toEqual([]);
				expect(session.drainPendingIrcInboxMessages(recipient)).toEqual([]);
				expect(mock.calls).toHaveLength(callCount);
			} finally { registry.unregister(recipient, ref); }
		} finally {
			await session?.dispose();
			auth.close();
		}
	});

	it("public custom-message dispatch persists source without promoting developer content to a user", async () => {
		using temp = TempDir.createSync("@omp-irc-source-");
		const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		const manager = SessionManager.inMemory(temp.path());
		const mock = createMockModel({ provider: "openai", id: "synthetic-source-model", handler: { content: ["unused"] } });
		const agent = new Agent({ initialState: { model: mock.model, tools: [], messages: [] }, convertToLlm, streamFn: mock.stream });
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: new ModelRegistry(auth) });
		try {
			await session.sendCustomMessage({ customType: "synthetic-source", content: "synthetic custom body", display: true, attribution: "agent", steeringSource: "irc:advisor" });
			const restored = manager.cloneCurrentSession({ persist: false }).buildSessionContext().messages;
			expect(restored[0]).toMatchObject({ role: "custom", steeringSource: "irc:advisor" });
			expect(convertToLlm(restored)[0]).toMatchObject({ role: "developer", attribution: "agent" });
			expect(mock.calls).toEqual([]);
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
