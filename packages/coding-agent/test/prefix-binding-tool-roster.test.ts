import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function createPrefixBindingModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

interface TestSession {
	session: AgentSession;
	contexts: Message[][];
	systemPrompts: string[][];
	promptCacheKeys: (string | undefined)[];
	rebuild: Mock<(toolNames: string[]) => Promise<string>>;
}

function newSession(
	model: Model,
	options: {
		beforeAgentStartSystemPrompt?: string[];
		sessionManager?: SessionManager;
		/** Runs after a request captured its prompt, before its reply starts. */
		beforeRequest?: () => Promise<void>;
		/** Prompt-cache key inherited from the session a fork was taken from. */
		forkPromptCacheKey?: string;
	} = {},
): TestSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const toolRegistry = new Map<string, AgentTool>([
		[read.name, read],
		[bash.name, bash],
	]);
	const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
	const contexts: Message[][] = [];
	const systemPrompts: string[][] = [];
	const promptCacheKeys: (string | undefined)[] = [];
	const rebuilder = {
		async rebuildSystemPrompt(toolNames: string[]): Promise<string> {
			return `tools:${toolNames.join(",")}`;
		},
	};
	const rebuild = vi.spyOn(rebuilder, "rebuildSystemPrompt");
	const agent = new Agent({
		getApiKey: () => "test-key",
		promptCacheKey: options.forkPromptCacheKey,
		initialState: {
			model,
			systemPrompt: ["initial"],
			tools: [read],
			// A resumed session restores the transcript before it is constructed (sdk.ts).
			messages: options.sessionManager ? options.sessionManager.buildSessionContext().messages : [],
		},
		convertToLlm,
		streamFn: async (requestModel, context, streamOptions) => {
			contexts.push([...context.messages]);
			systemPrompts.push([...(context.systemPrompt ?? [])]);
			promptCacheKeys.push(streamOptions?.promptCacheKey);
			await options.beforeRequest?.();
			return mock.stream(requestModel, context, streamOptions);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry,
		builtInToolNames: ["read", "bash"],
		providerPromptCacheKeySource: options.forkPromptCacheKey ? "fork" : undefined,
		extensionRunner: options.beforeAgentStartSystemPrompt
			? ({
					emitBeforeAgentStart: async () => ({ systemPrompt: options.beforeAgentStartSystemPrompt }),
					emit: async () => undefined,
				} as unknown as ExtensionRunner)
			: undefined,
		rebuildSystemPrompt: async toolNames => ({
			systemPrompt: [await rebuilder.rebuildSystemPrompt(toolNames)],
		}),
	});
	return { session, contexts, systemPrompts, promptCacheKeys, rebuild };
}

function providerText(messages: Message[]): string {
	return messages
		.flatMap(message =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
}

describe("prefix-bound tool roster changes", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	it("freezes the prompt after a prefix-bound turn", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");
		const promptBeforeRosterChange = [...harness.session.agent.state.systemPrompt];
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange);
		expect(harness.session.agent.state.systemPrompt).toEqual(promptBeforeRosterChange);
	});

	// Subagent task prompts are direct user-role prompts attributed to the parent agent.
	for (const attribution of ["user", "agent"] as const) {
		it(`delivers one hidden roster notice with the next ${attribution}-attributed prompt`, async () => {
			const harness = newSession(createPrefixBindingModel());
			sessions.push(harness.session);
			await harness.session.setActiveToolPresentation(["read"], []);
			await harness.session.prompt("first");
			await harness.session.setActiveToolPresentation(["read", "bash"], []);

			await harness.session.prompt("second", { attribution });

			const notices = harness.session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-roster-notice",
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				details: { added: ["bash"], removed: [] },
				display: false,
				attribution: "agent",
			});
			const secondRequest = providerText(harness.contexts[1]);
			expect(secondRequest).toContain("Tool availability changed.");
			expect(secondRequest).toContain("Now available: bash.");
			expect(secondRequest.match(/Tool availability changed\./g)).toHaveLength(1);
		});
	}

	it("rebuilds a prefix-bound prompt when the roster changes before the first turn", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange + 1);
		expect(harness.session.agent.state.systemPrompt).toEqual(["tools:read,bash"]);
	});

	describe("after a resume", () => {
		/** Transcript of a process that sent its first turn with `toolNames` active. */
		async function liveTranscript(toolNames = ["read", "bash"]): Promise<{
			sessionManager: SessionManager;
			replyEntryId: string;
			systemPrompt: string[];
		}> {
			const sessionManager = SessionManager.inMemory();
			const live = newSession(createPrefixBindingModel(), { sessionManager });
			sessions.push(live.session);
			await live.session.setActiveToolPresentation(toolNames, []);
			await live.session.prompt("first");
			const reply = sessionManager
				.getEntries()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!reply) throw new Error("live turn persisted no reply");
			return { sessionManager, replyEntryId: reply.id, systemPrompt: live.systemPrompts[0]! };
		}

		it("sends the first request with the prompt the transcript was sent with when a tool registers late", async () => {
			const transcript = await liveTranscript();
			const resumed = newSession(createPrefixBindingModel(), { sessionManager: transcript.sessionManager });
			sessions.push(resumed.session);
			// The new process builds its startup prompt before a lazily registered
			// tool (an extension or MCP server) joins, then that tool registers
			// before the first request.
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.setActiveToolPresentation(["read", "bash"], []);

			await resumed.session.prompt("second");

			expect(resumed.systemPrompts[0]).toEqual(transcript.systemPrompt);
			expect(providerText(resumed.contexts[0])).not.toContain("Tool availability changed.");
		});

		it("keeps a fork's inherited prompt-cache key when the late rebuild restores the transcript's prompt", async () => {
			const transcript = await liveTranscript();
			const resumed = newSession(createPrefixBindingModel(), {
				sessionManager: transcript.sessionManager,
				forkPromptCacheKey: "parent-cache-key",
			});
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.setActiveToolPresentation(["read", "bash"], []);

			await resumed.session.prompt("second");

			expect(resumed.systemPrompts[0]).toEqual(transcript.systemPrompt);
			expect(resumed.promptCacheKeys[0]).toBe("parent-cache-key");
		});

		it("keeps the prompt frozen after a resumed request when /tree returns to the restored reply", async () => {
			const transcript = await liveTranscript();
			const resumed = newSession(createPrefixBindingModel(), { sessionManager: transcript.sessionManager });
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.prompt("second");
			// The restored reply is the newest again, but this process already sent its prompt.
			await resumed.session.navigateTree(transcript.replyEntryId);

			await resumed.session.setActiveToolPresentation(["read", "bash"], []);
			await resumed.session.prompt("third");

			expect(resumed.systemPrompts[1]).toEqual(resumed.systemPrompts[0]);
			expect(providerText(resumed.contexts[1])).toContain("Tool availability changed.");
		});

		it("freezes a roster rebuild that finishes after the first resumed request", async () => {
			const transcript = await liveTranscript();
			const resumed = newSession(createPrefixBindingModel(), { sessionManager: transcript.sessionManager });
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			// A background roster change (e.g. an MCP refresh) starts its rebuild
			// before the first request and finishes after that request was sent.
			const rebuildGate = Promise.withResolvers<void>();
			resumed.rebuild.mockImplementationOnce(async toolNames => {
				await rebuildGate.promise;
				return `tools:${toolNames.join(",")}`;
			});
			const rosterChange = resumed.session.setActiveToolPresentation(["read", "bash"], []);
			await resumed.session.prompt("second");
			rebuildGate.resolve();
			await rosterChange;

			await resumed.session.prompt("third");

			expect(resumed.systemPrompts[1]).toEqual(resumed.systemPrompts[0]);
			expect(providerText(resumed.contexts[1])).toContain("Tool availability changed.");
		});

		it("freezes a roster rebuild that commits after the first resumed request captured its prompt", async () => {
			const transcript = await liveTranscript();
			let lateRegistration: Promise<void> | undefined;
			const resumed = newSession(createPrefixBindingModel(), {
				sessionManager: transcript.sessionManager,
				// Provider setup (credentials, a Bedrock round trip) runs between the
				// prompt capture and the reply; a tool registers meanwhile.
				beforeRequest: async () => {
					lateRegistration ??= resumed.session.setActiveToolPresentation(["read", "bash"], []);
					await lateRegistration;
				},
			});
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.prompt("second");

			await resumed.session.prompt("third");

			expect(resumed.systemPrompts[1]).toEqual(resumed.systemPrompts[0]);
			expect(providerText(resumed.contexts[1])).toContain("Tool availability changed.");
		});

		it("keeps the transcript's prompt when a tool installed since that run registers late", async () => {
			const transcript = await liveTranscript(["read"]);
			const resumed = newSession(createPrefixBindingModel(), { sessionManager: transcript.sessionManager });
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.setActiveToolPresentation(["read", "bash"], []);

			await resumed.session.prompt("second");

			expect(resumed.systemPrompts[0]).toEqual(transcript.systemPrompt);
			expect(providerText(resumed.contexts[0])).toContain("Now available: bash.");
		});

		it("keeps the transcript's prompt when a late tool was frozen out mid-conversation", async () => {
			const sessionManager = SessionManager.inMemory();
			const live = newSession(createPrefixBindingModel(), { sessionManager });
			sessions.push(live.session);
			await live.session.setActiveToolPresentation(["read"], []);
			await live.session.prompt("first");
			await live.session.setActiveToolPresentation(["read", "bash"], []);
			await live.session.prompt("second");
			const resumed = newSession(createPrefixBindingModel(), { sessionManager });
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.setActiveToolPresentation(["read", "bash"], []);

			await resumed.session.prompt("third");

			expect(live.systemPrompts[1]).toEqual(["tools:read"]);
			expect(resumed.systemPrompts[0]).toEqual(live.systemPrompts[1]);
		});

		it.each([
			{
				path: "a before-model-call gate stops it",
				stopBeforeDispatch: (session: AgentSession) => {
					session.agent.addBeforeModelCall(() => ({ stop: true, reason: "gated" }));
				},
			},
			{
				path: "its credential lookup fails",
				stopBeforeDispatch: (session: AgentSession) => {
					session.agent.getApiKey = () => {
						throw new Error("no credentials");
					};
				},
			},
		])(
			"keeps the transcript's prompt when a call captured a newer prompt but $path",
			async ({ stopBeforeDispatch }) => {
				const sessionManager = SessionManager.inMemory();
				const live = newSession(createPrefixBindingModel(), { sessionManager });
				sessions.push(live.session);
				await live.session.setActiveToolPresentation(["read"], []);
				await live.session.prompt("first");
				// A forced refresh moves the base to a prompt no reply was produced under.
				await live.session.setActiveToolPresentation(["read", "bash"], []);
				await live.session.refreshBaseSystemPrompt();
				stopBeforeDispatch(live.session);
				await live.session.prompt("second").catch(() => undefined);
				const resumed = newSession(createPrefixBindingModel(), { sessionManager });
				sessions.push(resumed.session);
				await resumed.session.setActiveToolPresentation(["read"], []);
				await resumed.session.setActiveToolPresentation(["read", "bash"], []);

				await resumed.session.prompt("third");

				expect(live.systemPrompts).toEqual([["tools:read"]]);
				expect(resumed.systemPrompts[0]).toEqual(["tools:read"]);
				expect(providerText(resumed.contexts[0])).toContain("Now available: bash.");
			},
		);

		it("keeps the startup prompt for a transcript recorded without a prompt digest", async () => {
			const transcript = await liveTranscript();
			// Transcripts written before prompt digests were recorded hold only the messages.
			const sessionManager = SessionManager.inMemory();
			for (const entry of transcript.sessionManager.getEntries()) {
				if (entry.type !== "message") continue;
				const { message } = entry;
				if (message.role === "user" || message.role === "assistant") sessionManager.appendMessage(message);
			}
			const resumed = newSession(createPrefixBindingModel(), { sessionManager });
			sessions.push(resumed.session);
			await resumed.session.setActiveToolPresentation(["read"], []);
			await resumed.session.setActiveToolPresentation(["read", "bash"], []);

			await resumed.session.prompt("second");

			expect(resumed.systemPrompts[0]).toEqual(["tools:read"]);
			expect(providerText(resumed.contexts[0])).toContain("Now available: bash.");
		});

		/** Kept out of the test body so no strong local binding outlives the capture. */
		function weakRefToRestoredReply(session: AgentSession): WeakRef<object> {
			const reply = session.agent.state.messages.findLast(message => message.role === "assistant");
			if (!reply) throw new Error("resumed session restored no reply");
			return new WeakRef(reply);
		}

		it("releases the restored reply when disposed before its first request", async () => {
			const transcript = await liveTranscript();
			const resumed = newSession(createPrefixBindingModel(), { sessionManager: transcript.sessionManager });
			const reply = weakRefToRestoredReply(resumed.session);
			for (const session of sessions.splice(0)) await session.dispose();

			await resumed.session.dispose();

			// A WeakRef target stays alive until the current task ends; yield a task between collections.
			for (let attempt = 0; attempt < 5 && reply.deref() !== undefined; attempt++) {
				const nextTask = Promise.withResolvers<void>();
				setImmediate(nextTask.resolve);
				await nextTask.promise;
				Bun.gc(true);
			}
			expect(reply.deref()).toBeUndefined();
		});
	});

	it("keeps rebuilding roster changes for models without prefix binding", async () => {
		const harness = newSession(createModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");
		const rebuildsBeforeRosterChange = harness.rebuild.mock.calls.length;

		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		expect(harness.rebuild).toHaveBeenCalledTimes(rebuildsBeforeRosterChange + 1);
		expect(harness.session.agent.state.systemPrompt).toEqual(["tools:read,bash"]);
	});

	it("drops a pending roster notice once the base prompt is rebuilt afterward", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		// A prefix-bound roster change freezes the prompt and queues a hidden delta.
		await harness.session.setActiveToolPresentation(["read", "bash"], []);
		// A later full rebuild (e.g. the model-cycle round trip's syncAfterModelChange)
		// re-renders the complete roster, subsuming the queued delta.
		await harness.session.refreshBaseSystemPrompt();

		await harness.session.prompt("second");

		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(0);
		const secondRequest = providerText(harness.contexts[1]);
		expect(secondRequest).not.toContain("Tool availability changed.");
		expect(harness.session.agent.state.systemPrompt).toEqual(["tools:read,bash"]);
	});

	it("does not ship a roster notice when a rebuild clears the delta during pre-prompt compaction", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		// A prefix-bound roster change freezes the prompt and queues a hidden delta
		// that survives to the next prompt (no rebuild behind it).
		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		// The pre-prompt maintenance pass can rebuild the base prompt mid-prompt
		// (context promotion switches the model -> syncAfterModelChange, or a
		// summary compaction), which re-renders the complete roster and clears the
		// queued delta. The roster notice is consumed after that pass, so it must
		// see the cleared delta and emit nothing — the outgoing request must never
		// carry both a rebuilt roster and a contradicting notice.
		const rebuildDuringCompaction = vi
			.spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded")
			.mockImplementation(async () => {
				await harness.session.refreshBaseSystemPrompt();
			});

		await harness.session.prompt("second");

		expect(rebuildDuringCompaction).toHaveBeenCalledTimes(1);
		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(0);
		const secondRequest = providerText(harness.contexts[1]);
		expect(secondRequest).not.toContain("Tool availability changed.");
	});

	it("keeps the roster notice when a turn override hides the rebuilt base", async () => {
		const override = ["per-turn override prompt"];
		const harness = newSession(createPrefixBindingModel(), { beforeAgentStartSystemPrompt: override });
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		// A prefix-bound roster change freezes the prompt and queues a hidden delta.
		await harness.session.setActiveToolPresentation(["read", "bash"], []);

		// A before_agent_start override is active for the turn, so a mid-prompt
		// rebuild (here a promotion/summary rebuild) re-renders the base but never
		// puts it on the wire — the override stays. The queued delta must survive
		// that rebuild so the notice remains the only channel carrying the change.
		const rebuildDuringCompaction = vi
			.spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded")
			.mockImplementation(async () => {
				await harness.session.refreshBaseSystemPrompt();
			});

		await harness.session.prompt("second");

		expect(rebuildDuringCompaction).toHaveBeenCalledTimes(1);
		// The provider saw the override, not the rebuilt roster.
		expect(harness.systemPrompts[1]).toEqual(override);
		// So the notice must still be delivered.
		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(1);
		expect(providerText(harness.contexts[1])).toContain("Now available: bash.");
	});

	it("keeps the roster notice when a rebuild precedes a turn override", async () => {
		const override = ["per-turn override prompt"];
		const harness = newSession(createPrefixBindingModel(), { beforeAgentStartSystemPrompt: override });
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		// A prefix-bound roster change freezes the prompt and queues a hidden delta.
		await harness.session.setActiveToolPresentation(["read", "bash"], []);
		// A rebuild happens while no override is registered yet — modelling a memory
		// backend's beforeAgentStartPrompt refresh, which runs inside
		// buildSystemPromptForAgentStart before emitBeforeAgentStart sets the
		// per-turn override. The rebuilt base must not clear the delta outright: the
		// override registered moments later hides that base from the wire.
		await harness.session.refreshBaseSystemPrompt();

		await harness.session.prompt("second");

		// The override hid the rebuilt base, so the provider never saw the roster there.
		expect(harness.systemPrompts[1]).toEqual(override);
		// The notice is the only channel carrying the change, so it must survive.
		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(1);
		expect(providerText(harness.contexts[1])).toContain("Now available: bash.");
	});

	it("delivers a roster notice for a change queued during pre-prompt maintenance", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		// The tool list changes mid-maintenance (e.g. an MCP refresh landing during
		// the await). The roster notice carries no context-budget risk, so it must
		// ship this turn alongside the schema change rather than deferring — a
		// deferred notice would leave the wire tool list and stated availability out
		// of sync, the same divergence as the original bug.
		const rosterChangeDuringMaintenance = vi
			.spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded")
			.mockImplementationOnce(async () => {
				await harness.session.setActiveToolPresentation(["read", "bash"], []);
			});

		await harness.session.prompt("second");

		expect(rosterChangeDuringMaintenance).toHaveBeenCalledTimes(1);
		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(1);
		expect(providerText(harness.contexts[1])).toContain("Now available: bash.");
	});

	it("announces a frozen removal after a rebuild absorbed a pending addition", async () => {
		const harness = newSession(createPrefixBindingModel());
		sessions.push(harness.session);
		await harness.session.setActiveToolPresentation(["read"], []);
		await harness.session.prompt("first");

		await harness.session.setActiveToolPresentation(["read", "bash"], []);
		await harness.session.refreshBaseSystemPrompt();
		await harness.session.setActiveToolPresentation(["read"], []);

		await harness.session.prompt("second");

		expect(harness.systemPrompts[1]).toEqual(["tools:read,bash"]);
		const notices = harness.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "tool-roster-notice",
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			details: { added: [], removed: ["bash"] },
		});
		expect(providerText(harness.contexts[1])).toContain("No longer available: bash.");
	});
});
