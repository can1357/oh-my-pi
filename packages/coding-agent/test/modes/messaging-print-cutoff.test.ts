import { afterEach, expect, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	MessagingService,
	type MessagingHost,
	type RemoteDelivery,
	type SessionListing,
} from "../../src/messaging/service";
import * as transport from "../../src/messaging/transport";
import { SessionManager } from "../../src/session/session-manager";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import * as messagingHost from "../../src/session/messaging-host";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

afterEach(() => vi.restoreAllMocks());

test("enabled print closes inbound admission before draining and prints its own answer, not a later message turn", async () => {
	const ordering: string[] = [];
	const output: string[] = [];
	const ownAnswer = assistant("CLI answer");
	const laterAnswer = assistant("answer to another session");
	let lastAssistant = ownAnswer;
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	vi.spyOn(messagingHost, "bindSessionMessaging").mockImplementation(async (_session, opts) => {
		expect(opts.directPrint).toBe(false);
		expect(opts.claimNames).toBe(false);
		ordering.push("bind");
		return {
			ready: () => ordering.push("ready"),
			stopReceiving: () => {
				ordering.push("cutoff");
			},
			dispose: async () => {
				ordering.push("messaging-dispose");
			},
		};
	});
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: (error?: Error) => void) => {
		output.push(String(chunk));
		callback?.();
		return true;
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const session = {
		settings: Settings.isolated(),
		extensionRunner: undefined,
		messaging: {},
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		agent: { hasQueuedMessages: () => false },
		hasPendingAsyncWork: () => false,
		sessionManager: {
			getHeader: () => undefined,
			setSessionName: async () => {
				ordering.push("name");
			},
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			ordering.push("subscribe");
			subscriber = listener;
			return () => {};
		},
		prompt: async (_text: string, opts: { onPromptAdmitted?: () => void }) => {
			ordering.push("prompt");
			opts.onPromptAdmitted?.();
			subscriber?.({ type: "agent_start" });
			subscriber?.({ type: "agent_end", messages: [ownAnswer], yielded: true });
			return true;
		},
		waitForIdle: async () => {
			ordering.push("drain");
			lastAssistant = laterAnswer;
			subscriber?.({ type: "agent_start" });
			subscriber?.({ type: "agent_end", messages: [laterAnswer], yielded: true });
		},
		getLastAssistantMessage: () => lastAssistant,
		setTextOutputCommitted: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {
			ordering.push("session-dispose");
		},
	} as unknown as AgentSession;
	const exitCode = await runPrintMode(session, { mode: "text", name: "release", initialMessage: "answer me" });
	expect(exitCode).toBe(0);
	expect(output.join("")).toBe("CLI answer\n");
	expect(ordering.indexOf("subscribe")).toBeLessThan(ordering.indexOf("ready"));
	expect(ordering.indexOf("ready")).toBeLessThan(ordering.indexOf("prompt"));
	expect(ordering.indexOf("cutoff")).toBeLessThan(ordering.indexOf("drain"));
	expect(ordering.indexOf("cutoff")).toBeLessThan(ordering.indexOf("session-dispose"));
	expect(ordering.indexOf("messaging-dispose")).toBeGreaterThan(ordering.indexOf("drain"));
});

test("accepted print turns can send real replies after cutoff and before full binding disposal", async () => {
	const temp = TempDir.createSync("@print-outbound-drain-");
	const dir = temp.join("inboxes");
	const publish = transport.publishInbox;
	const list = transport.listInboxEntries;
	const request = transport.requestInbox;
	vi.spyOn(transport, "publishInbox").mockImplementation((handler, opts) => publish(handler, { ...opts, dir }));
	vi.spyOn(transport, "listInboxEntries").mockImplementation(opts => list({ ...opts, dir }));
	vi.spyOn(transport, "requestInbox").mockImplementation((entry, payload, opts) =>
		request(entry, payload, { ...opts, dir }),
	);
	vi.spyOn(transport, "messagingRegistryDir").mockReturnValue(dir);
	const replies: RemoteDelivery[] = [];
	const peerHost: MessagingHost = {
		sessionId: () => "peer",
		cwd: () => temp.path(),
		directPrint: false,
		sessionName: () => "peer",
		titleSource: () => "user",
		isBusy: () => false,
		isReceivingSuspended: () => false,
		isSessionTransitioning: () => false,
		permissionClass: () => "bypass",
		onPolicyInputsChange: () => () => {},
		pendingRemoteCount: () => replies.length,
		deliverRemote: async batch => {
			replies.push(...batch);
			return true;
		},
		showNotice: () => {},
		deliverNotice: async () => true,
		askApproval: undefined,
		currentRelayChain: () => [],
		lastFinished: () => undefined,
	};
	const peer = await MessagingService.start(peerHost, Settings.isolated());
	peer.markReady();
	const manager = SessionManager.inMemory(temp.path());
	const accepted: RemoteDelivery[] = [];
	const output: string[] = [];
	let target: SessionListing | undefined;
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	let current: MessagingService | undefined;
	const answer = assistant("CLI answer");
	const session = {
		settings: Settings.isolated({ "messaging.enabled": true }),
		sessionManager: manager,
		extensionRunner: undefined,
		isStreaming: false,
		isSubagent: false,
		isMessagingReceivingSuspended: false,
		isSessionTransitioning: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		agent: { hasQueuedMessages: () => false },
		hasPendingAsyncWork: () => false,
		permissionClass: () => "bypass",
		get messaging() {
			return current;
		},
		setMessaging: (service: MessagingService | undefined) => {
			current = service;
		},
		registerSessionChangeCallback: () => () => {},
		refreshBaseSystemPrompt: async () => {},
		deliverRemoteMessages: async (batch: readonly RemoteDelivery[]) => {
			accepted.push(...batch);
			return true;
		},
		pendingRemoteCount: () => accepted.length,
		emitNotice: () => {},
		currentRelayChain: () => [],
		lastFinished: () => undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			subscriber = listener;
			return () => {};
		},
		prompt: async (_text: string, opts: { onPromptAdmitted?: () => void }) => {
			expect(process.env.OMP_MESSAGING_SOCKET).toBeUndefined();
			expect(process.env.OMP_MESSAGING_TOKEN).toBeUndefined();
			expect(Bun.env.OMP_MESSAGING_SOCKET).toBeUndefined();
			expect(Bun.env.OMP_MESSAGING_TOKEN).toBeUndefined();
			target = (await peer.listSessions())[0];
			expect((await peer.send(target!, "accepted autonomous work", { notifyWhenIdle: false })).ok).toBe(true);
			opts.onPromptAdmitted?.();
			subscriber?.({ type: "agent_start" });
			subscriber?.({ type: "agent_end", messages: [answer], yielded: true });
			return true;
		},
		waitForIdle: async () => {
			expect(current).toBeDefined();
			expect(accepted.map(item => item.body)).toEqual(["accepted autonomous work"]);
			expect(await peer.send(target!, "new work after cutoff", { notifyWhenIdle: false })).toEqual({
				ok: false,
				text: "Failed to send to release: the session is no longer running.",
			});
			const remote = (await current!.listSessions())[0];
			expect((await current!.send(remote, "reply from accepted turn", { notifyWhenIdle: false })).ok).toBe(true);
			expect(replies.map(item => item.body)).toEqual(["reply from accepted turn"]);
		},
		getLastAssistantMessage: () => answer,
		setTextOutputCommitted: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {},
	} as unknown as AgentSession;
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: (error?: Error) => void) => {
		output.push(String(chunk));
		callback?.();
		return true;
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		expect(await runPrintMode(session, { mode: "text", name: "release", initialMessage: "answer me" })).toBe(0);
		expect(output.join("")).toBe("CLI answer\n");
		expect(current).toBeUndefined();
	} finally {
		await current?.close();
		await peer.close();
		await manager.close();
		await temp.remove();
	}
});
