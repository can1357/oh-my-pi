import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { finishProviderExecution, type Message, type ProviderSessionState } from "@oh-my-pi/pi-ai";
import { getAntigravityProviderSessionState, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createUserMessage } from "./helpers";

interface CapturedEnvelope {
	requestId: string;
	request: {
		labels: Partial<Record<string, string>>;
		contents: { parts?: { functionResponse?: unknown }[] }[];
	};
}

it("keeps host trajectory and execution identity across projected tool turns", async () => {
	const requests: CapturedEnvelope[] = [];
	let toolsRun = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push((await request.json()) as CapturedEnvelope);
			const parts =
				requests.length === 1
					? [
							{ functionCall: { id: "tool-1", name: "probe", args: {} } },
							{ functionCall: { id: "tool-2", name: "probe", args: {} } },
						]
					: [{ text: "done" }];
			return new Response(
				`data: ${JSON.stringify({
					response: {
						responseId: `backend-response-${requests.length}`,
						candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
					},
				})}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const model = buildModel({
		id: "gemini-3-flash",
		name: "Gemini",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: server.url.origin,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1024,
	});
	const parameters = type({});
	const probe: AgentTool<typeof parameters> = {
		name: "probe",
		label: "Probe",
		description: "Read a fixed test value",
		parameters,
		async execute() {
			toolsRun++;
			return { content: [{ type: "text", text: "value" }] };
		},
	};
	const states = new Map<string, ProviderSessionState>();
	const config: AgentLoopConfig = {
		model,
		providerSessionState: states,
		// Projection can remove host history without renumbering the trajectory.
		transformContext: async messages => messages.slice(1),
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
	};
	const transcript: AgentMessage[] = [createUserMessage("pruned host turn")];
	const completedExecutionIds: string[] = [];
	try {
		for (const prompt of ["first execution", "second execution", "third execution"]) {
			const run = agentLoop(
				[createUserMessage(prompt)],
				{ systemPrompt: [], messages: transcript, tools: [probe] },
				config,
				undefined,
				(_model, context, options) =>
					streamGoogleGeminiCli(model, context, {
						apiKey: JSON.stringify({ token: "fixture-only", projectId: "fixture-project" }),
						fetch,
						signal: options?.signal,
						providerSessionState: states,
						trajectoryStepCount: options?.trajectoryStepCount,
					}),
			);
			for await (const event of run) {
				if (event.type === "agent_end") {
					const id = getAntigravityProviderSessionState(states)?.lastExecutionId;
					if (!id) throw new Error("agent_end exposed before native execution identity was committed");
					completedExecutionIds.push(id);
				}
			}
			transcript.push(...(await run.result()));
		}
		expect(toolsRun).toBe(2);
		expect(requests.map(request => request.request.labels.last_execution_id)).toEqual([
			undefined,
			undefined,
			completedExecutionIds[0],
			completedExecutionIds[1],
		]);
		expect(requests.map(request => request.requestId.split("/").at(-1))).toEqual(["2", "5", "7", "9"]);
		// Two logical tool results share one wire content entry, but still count as two steps.
		const toolResults = requests[1].request.contents.filter(content =>
			content.parts?.some(part => part.functionResponse),
		);
		expect(toolResults.map(content => content.parts?.filter(part => part.functionResponse).length)).toEqual([2]);
		expect(completedExecutionIds[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
		expect(new Set(completedExecutionIds).size).toBe(3);
		expect(requests.some(request => request.request.labels.last_execution_id?.startsWith("backend-response-"))).toBe(
			false,
		);
	} finally {
		server.stop(true);
		for (const state of states.values()) state.close();
	}
});

it("commits the execution identity before surfacing a host projection failure", async () => {
	const states = new Map<string, ProviderSessionState>();
	const state = getAntigravityProviderSessionState(states);
	finishProviderExecution(states);
	const previousExecutionId = state?.lastExecutionId;
	const mock = createMockModel();
	const run = agentLoop(
		[createUserMessage("next execution")],
		{ systemPrompt: [], messages: [], tools: [] },
		{
			model: mock.model,
			providerSessionState: states,
			convertToLlm: () => {
				throw new Error("host projection failed");
			},
		},
		undefined,
		mock.stream,
	);

	await expect(run.result()).rejects.toThrow("host projection failed");
	expect(state?.lastExecutionId).not.toBe(previousExecutionId);
	expect(state?.lastExecutionId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});
