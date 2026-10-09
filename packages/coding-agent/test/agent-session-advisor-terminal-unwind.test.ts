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
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TempDir } from "@oh-my-pi/pi-utils";

const boundaryToolSchema = type({});
type BoundaryTool = AgentTool<typeof boundaryToolSchema, undefined>;

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
		parameters: boundaryToolSchema,
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

it.each([
	{ severity: "concern", continuation: undefined, immuneTurns: undefined, stop: false },
	{ severity: "nit", continuation: undefined, immuneTurns: undefined, stop: false },
	...([undefined, 0] as const).flatMap(immuneTurns =>
		(["concern", "nit", "blocker"] as const).map(continuation => ({
			severity: "blocker" as const,
			continuation,
			immuneTurns,
			stop: false,
		})),
	),
	{ severity: "blocker", continuation: "concern", immuneTurns: undefined, stop: true },
] as const)(
	"routes terminal advice and same-run continuation %j",
	async ({ severity, continuation, immuneTurns, stop }) => {
		const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
		const terminalTurnEnd = Promise.withResolvers<void>();
		const advisorStarted = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<boolean>();
		const completedReviewStarted = Promise.withResolvers<void>();
		const continuationStarted = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		const thirdTurnStart = Promise.withResolvers<void>();
		const continuationMarker = `CONTINUATION_${continuation}_${immuneTurns ?? "default"}_${stop}`;
		const nextProviderStarted = Promise.withResolvers<void>();
		const releaseNextProvider = Promise.withResolvers<void>();
		const terminalCalls = severity === "blocker" ? (stop ? 3 : 4) : 2;
		const nextPrimaryCall = terminalCalls + 1;
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
				if (severity === "blocker" && primaryCalls === 3) {
					continuationStarted.resolve();
					await releaseContinuation.promise;
					return textResponse("continuation answer");
				}
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
				completedReviewStarted.resolve();
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
			convertToLlm,
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
			...(immuneTurns === 0 ? { "advisor.immuneTurns": 0 } : {}),
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
		let turnStarts = 0;
		const secondAgentStart = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "turn_start" && ++turnStarts === 3) thirdTurnStart.resolve();
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
			adviceAccepted.resolve(agent.state.isStreaming);
			return result;
		};

		try {
			const run = session.prompt("run a step then finish");
			await advisorStarted.promise;
			await terminalTurnEnd.promise;
			expect(await adviceAccepted.promise).toBe(true);
			if (continuation) {
				await continuationStarted.promise;
				await thirdTurnStart.promise;
				// Accept live notes only after the queued completed update has reset
				// AdviseTool's in-progress deferral state.
				await completedReviewStarted.promise;
				expect(agent.state.isStreaming).toBe(true);
				expect(agentStarts).toBe(1);
				expect(turnStarts).toBe(3);
				if (stop) {
					const aborted = session.abort({ reason: USER_INTERRUPT_LABEL });
					releaseContinuation.resolve();
					await aborted;
				}
				await advise.execute("live-continuation", { note: continuationMarker, severity: continuation });
				releaseContinuation.resolve();
			}
			await run;
			await session.waitForIdle();
			expect(agentStarts).toBe(1);
			expect(
				advisor.state.messages.some(message => message.role === "toolResult" && message.toolCallId === "advice-1"),
			).toBe(true);
			expect(primaryContexts[2] ?? "").not.toContain(continuationMarker);
			if (continuation && !stop) {
				expect(primaryContexts[3]?.split(continuationMarker).length).toBe(2);
				expect(primaryContexts.filter(context => context.includes(continuationMarker))).toHaveLength(1);
			}
			expect(primaryCalls).toBe(terminalCalls);
			const cards = session.agent.state.messages.filter(
				(message: AgentMessage) =>
					message.role === "custom" && "customType" in message && message.customType === "advisor",
			);
			if (severity !== "blocker") {
				expect(cards).toHaveLength(1);
				const card = cards[0];
				expect(card?.role).toBe("custom");
				if (card?.role === "custom") expect(contentText(card.content)).toContain("late terminal advice");
			}

			const nextRun = session.prompt(nextUserMarker);
			await secondAgentStart.promise;
			await nextProviderStarted.promise;
			expect(session.agent.state.isStreaming).toBe(true);
			await advise.execute("live-next", {
				note: "live next-turn concern",
				severity: "concern",
			});
			releaseNextProvider.resolve();
			await nextRun;
			await session.waitForIdle();
			expect(agentStarts).toBe(2);
			// A new user run also consumes live advice at its next provider request.
			expect(primaryCalls).toBe(terminalCalls + 2);
			expect(primaryContexts[terminalCalls]).toContain(nextUserMarker);
			expect(primaryContexts[terminalCalls + 1]?.split("live next-turn concern").length).toBe(2);
			if (stop) expect(primaryContexts[terminalCalls]?.split(continuationMarker).length).toBe(2);
		} finally {
			releaseAdvisor.resolve();
			adviceAccepted.resolve(false);
			releaseContinuation.resolve();
			releaseNextProvider.resolve();
		}
	},
);
