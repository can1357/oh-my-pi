import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type BoundaryTool = AgentTool<any, any, any>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, args: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

function makeTool(name: string, execute: BoundaryTool["execute"]): BoundaryTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: type({}),
		execute,
	};
}

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
});

it.each(["concern", "nit", "blocker"] as const)(
	"routes late terminal %s correctly before a real next run",
	async severity => {
		const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
		const terminalTurnEnd = Promise.withResolvers<void>();
		const advisorStarted = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<{ feedback: string; streaming: boolean }>();
		const nextProviderStarted = Promise.withResolvers<void>();
		const releaseNextProvider = Promise.withResolvers<void>();
		const nextPrimaryCall = severity === "blocker" ? 4 : 3;
		let primaryCalls = 0;
		const primaryContexts: string[] = [];
		let advisorCalls = 0;
		let terminalReleaseStarted = false;

		const primaryMock = createMockModel({
			id: "terminal-unwind-primary",
			provider: "anthropic",
			handler: async () => {
				if (primaryCalls === 1) return toolResponse("step-1", "step");
				if (primaryCalls === 2) return textResponse("terminal answer");
				if (primaryCalls === nextPrimaryCall) {
					nextProviderStarted.resolve();
					await releaseNextProvider.promise;
					return textResponse("next answer");
				}
				return textResponse("continuation answer");
			},
		});
		const advisorMock = createMockModel({
			id: "terminal-unwind-advisor",
			provider: "anthropic",
			handler: async () => {
				if (++advisorCalls === 1) {
					advisorStarted.resolve();
					await releaseAdvisor.promise;
					return toolResponse("advice-1", "advise", {
						note: "late terminal advice",
						severity,
					});
				}
				return textResponse("advisor quiet");
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["terminal unwind regression"],
				tools: [makeTool("step", async () => ({ content: [{ type: "text", text: "step complete" }] }))],
			},
			streamFn: (messages, context, options) => {
				primaryCalls++;
				primaryContexts.push(JSON.stringify(context.messages));
				return primaryMock.stream(messages, context, options);
			},
		});
		const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
		agent.setOnTurnEnd = callback => {
			if (!callback) {
				originalSetOnTurnEnd(undefined);
				return;
			}
			originalSetOnTurnEnd(async (messages, signal, context) => {
				await callback(messages, signal, context);
				if (context?.willContinue === false && !terminalReleaseStarted) {
					terminalReleaseStarted = true;
					terminalTurnEnd.resolve();
					releaseAdvisor.resolve();
					await adviceAccepted.promise;
				}
			});
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "off",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		let agentStarts = 0;
		const secondAgentStart = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type !== "agent_start") return;
			agentStarts++;
			if (agentStarts === 2) secondAgentStart.resolve();
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advise tool");
		const originalExecute = advise.execute.bind(advise);
		advise.execute = async (...args) => {
			const result = await originalExecute(...args);
			const feedback = contentText(result.content);
			if (/Delivered|Queued|preserved|urgent/i.test(feedback)) {
				adviceAccepted.resolve({ feedback, streaming: agent.state.isStreaming });
			}
			return result;
		};

		const run = session.prompt("run a step then finish");
		await advisorStarted.promise;
		await terminalTurnEnd.promise;
		const accepted = await adviceAccepted.promise;
		await run;
		await session.waitForIdle();

		expect(accepted.streaming).toBe(true);
		const terminalCalls = severity === "blocker" ? 3 : 2;
		expect(primaryCalls).toBe(terminalCalls);
		const cards = session.agent.state.messages.filter(
			(message: AgentMessage) =>
				message.role === "custom" && "customType" in message && message.customType === "advisor",
		);
		expect(cards).toHaveLength(1);
		if (severity !== "blocker") {
			const card = cards[0];
			expect(card?.role).toBe("custom");
			if (card?.role === "custom") expect(contentText(card.content)).toContain("late terminal advice");
		}

		const nextRun = session.prompt(nextUserMarker);
		await secondAgentStart.promise;
		await nextProviderStarted.promise;
		expect(session.agent.state.isStreaming).toBe(true);
		const liveResult = await advise.execute("live-next", {
			note: "live next-turn concern",
			severity: "concern",
		});
		expect(contentText(liveResult.content)).toMatch(/Delivered|Queued/);
		releaseNextProvider.resolve();
		await nextRun;
		await session.waitForIdle();
		expect(agentStarts).toBe(2);
		// The live concern intentionally steers one continuation after the held
		// next-user provider request; this is separate from the terminal-run guard.
		expect(primaryCalls).toBe(terminalCalls + 2);
		expect(primaryContexts[terminalCalls]).toContain(nextUserMarker);
	},
);

it("checkConcerns steals two late concerns as framed turns, then preserves once the budget is spent", async () => {
	// Budget-refresh guard: the two agent-initiated check turns must consume the
	// per-human-turn budget (not refresh it), so an advisor that keeps advising
	// gets exactly `checkConcernsMaxTurns` extra turns and the next concern lands
	// as a plain preserved card. An advisor steer never flows through the user
	// prompt path, so only a real user prompt may reset the counter.
	const temp = TempDir.createSync("@pi-advisor-check-concerns-");
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	let primaryCalls = 0;
	let advisedTurns = 0;
	let adviseCount = 0;
	const primaryMock = createMockModel({
		id: "check-concerns-primary",
		provider: "anthropic",
		// A thinking block per answer gives the later history-rewrite probe
		// something real to strip; terminal-answer detection skips thinking.
		handler: async () => ({
			content: [{ type: "thinking", thinking: "primary deliberation" }, "finished answer"],
			stopReason: "stop",
		}),
	});
	const advisorMock = createMockModel({
		id: "check-concerns-advisor",
		provider: "anthropic",
		handler: async () => {
			// One concern per completed primary turn: the sync check-and-set keeps
			// overlapping advisor updates from double-advising the same turn.
			if (advisedTurns < primaryCalls) {
				advisedTurns = primaryCalls;
				adviseCount++;
				return toolResponse(`advice-${adviseCount}`, "advise", {
					note: `late concern ${adviseCount}`,
					severity: "concern",
				});
			}
			return textResponse("advisor quiet");
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["check concerns budget regression"],
			tools: [],
		},
		streamFn: (messages, context, options) => {
			primaryCalls++;
			return primaryMock.stream(messages, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
		"advisor.checkConcerns": true,
		"advisor.checkConcernsMaxTurns": 2,
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: advisorMock.stream,
	});
	active = { session, auth, temp };
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");

	await session.prompt("do the work");
	await session.waitForIdle();
	await session.waitForAdvisorCatchup(10_000);
	await session.waitForIdle();
	// Stability: a refreshed budget would keep spawning turns, so the counts
	// must hold still across a second full drain.
	const settledCalls = primaryCalls;
	await session.waitForAdvisorCatchup(10_000);
	await session.waitForIdle();
	expect(primaryCalls).toBe(settledCalls);

	// Initial turn plus exactly two framed check turns, then stop: the steered
	// advisory rides the steer channel (not the provider context), so the
	// framing is asserted on the transcript cards the turns leave behind.
	expect(primaryCalls).toBe(3);
	expect(adviseCount).toBe(3);

	const cards = session.agent.state.messages.filter(
		(message: AgentMessage) =>
			message.role === "custom" && "customType" in message && message.customType === "advisor",
	);
	expect(cards).toHaveLength(3);
	const texts = cards.map(card => (card.role === "custom" ? contentText(card.content) : ""));
	expect(texts[0]).toContain("Advisor follow-up");
	expect(texts[0]).toContain("late concern 1");
	// The advisory block is XML interpolated through prompt.render: it must
	// reach the model unescaped (literal <advisory>), never HTML-escaped.
	expect(texts[0]).toContain("<advisory");
	expect(texts[0]).not.toContain("&lt;advisory");
	expect(texts[1]).toContain("Advisor follow-up");
	expect(texts[1]).toContain("late concern 2");
	expect(texts[1]).toContain("<advisory");
	expect(texts[1]).not.toContain("&lt;advisory");
	expect(texts[2]).not.toContain("Advisor follow-up");
	expect(texts[2]).toContain("late concern 3");

	// A within-conversation history rewrite must not refill the spent budget:
	// shake the thinking blocks out of the transcript (the same rewrite path —
	// replaceMessages plus resetAllRuntimes — as compaction/shake/rewind),
	// then raise one more late concern. It must land as a plain preserved
	// card, never a framed check turn.
	const shakeResult = await session.shake("thinking");
	expect(shakeResult.thinkingBlocksDropped).toBeGreaterThan(0);
	await session.waitForIdle();
	await session.waitForAdvisorCatchup(10_000);
	await session.waitForIdle();

	const advisorAgent = session.getAdvisorAgent();
	if (!advisorAgent) throw new Error("Expected advisor agent");
	const probeAdvise = advisorAgent.state.tools.find(tool => tool.name === "advise");
	if (!probeAdvise) throw new Error("Expected advise tool");
	const probeResult = await probeAdvise.execute("post-shake-probe", {
		note: "post-shake concern",
		severity: "concern",
	});
	// The tool acks "Delivered." on every live path (steer and preserve alike),
	// so the turn-count and card assertions below — not the ack — carry the teeth.
	expect(contentText(probeResult.content)).toContain("Delivered.");
	await session.waitForIdle();
	await session.waitForAdvisorCatchup(10_000);
	await session.waitForIdle();

	expect(primaryCalls).toBe(3);
	expect(adviseCount).toBe(3);
	const cardsAfterShake = session.agent.state.messages.filter(
		(message: AgentMessage) =>
			message.role === "custom" && "customType" in message && message.customType === "advisor",
	);
	expect(cardsAfterShake).toHaveLength(4);
	const textsAfterShake = cardsAfterShake.map(card => (card.role === "custom" ? contentText(card.content) : ""));
	expect(textsAfterShake[3]).toContain("post-shake concern");
	expect(textsAfterShake[3]).not.toContain("Advisor follow-up");
});
