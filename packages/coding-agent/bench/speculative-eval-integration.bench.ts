import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, type AgentTool, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "../src/config/settings";
import { disposeAllVmContexts } from "../src/eval/js/context-manager";
import { CodingAgentSpeculativeExecutionHost } from "../src/speculation/host";
import type { ToolSession } from "../src/tools";
import { EvalTool } from "../src/tools/eval";
import { ReadTool } from "../src/tools/read";

const REPEATS = 10;
const PROVIDER_TAIL_MS = 40;
const READ_MS = 60;
const mock = createMockModel({ responses: [] });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

const convertToLlm = async (messages: AgentMessage[]): Promise<Message[]> => messages as Message[];

async function episode(directory: string, speculative: boolean, index: number): Promise<number> {
	const settings = Settings.isolated({
		"eval.autoBackground.enabled": false,
		"images.autoResize": false,
		"inspect_image.enabled": false,
		"tools.speculativeExecution.enabled": true,
	});
	let read!: ReadTool;
	const session: ToolSession = {
		cwd: directory,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getEvalSessionId: () => `speculative-eval-bench-${speculative}-${index}`,
		getToolForEvalBridge: name => (name === "read" ? (read as AgentTool) : undefined),
		getEvalBridgeToolNames: () => ["read"],
		settings,
	};
	read = new ReadTool(session);
	const executeRead = read.execute.bind(read);
	read.execute = async (...args) => {
		await Bun.sleep(READ_MS);
		return await executeRead(...args);
	};
	const finalized = read.speculation.finalized;
	if (!finalized) throw new Error("Read tool has no finalized speculation policy");
	const executeSpeculativeRead = finalized.execute;
	finalized.execute = async (context, signal) => {
		await Bun.sleep(READ_MS);
		return await executeSpeculativeRead(context, signal);
	};
	const evalTool = new EvalTool(session);
	await evalTool.execute("warm", { language: "js", code: "globalThis.benchmarkWarm = true" });
	const host = new CodingAgentSpeculativeExecutionHost(settings, session, { hasHandlers: () => false });
	const args = { language: "js", code: 'await tool.read({ path: "note.txt" })' };
	let turn = 0;
	const streamFn = (_model: unknown, _context: Context) => {
		const response = new AssistantMessageEventStream();
		void (async () => {
			if (turn++ === 0) {
				const streamingCall = { type: "toolCall" as const, id: `eval-${index}`, name: "eval", arguments: {} };
				setStreamingPartialJson(streamingCall, JSON.stringify(args));
				const partial = assistant([streamingCall], "toolUse");
				const toolCall = { ...streamingCall, arguments: args };
				const final = assistant([toolCall], "toolUse");
				response.push({ type: "start", partial });
				response.push({ type: "toolcall_start", contentIndex: 0, partial });
				response.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial });
				await Bun.sleep(PROVIDER_TAIL_MS);
				response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: final });
				response.push({ type: "done", reason: "toolUse", message: final });
				return;
			}
			const final = assistant([{ type: "text", text: "done" }], "stop");
			response.push({ type: "start", partial: final });
			response.push({ type: "done", reason: "stop", message: final });
		})();
		return response;
	};
	const startedAt = performance.now();
	await agentLoop(
		[{ role: "user", content: "Read", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [evalTool] },
		{
			model: mock.model,
			convertToLlm,
			...(speculative ? { speculativeToolExecution: { enabled: true, host } } : {}),
		},
		undefined,
		streamFn,
	).result();
	return performance.now() - startedAt;
}

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-eval-bench-"));
try {
	await Bun.write(path.join(directory, "note.txt"), "benchmark payload");
	const baseline: number[] = [];
	const speculative: number[] = [];
	for (let index = 0; index < REPEATS; index++) {
		baseline.push(await episode(directory, false, index));
		speculative.push(await episode(directory, true, index));
	}
	const baselineMedian = percentile(baseline, 0.5);
	const speculativeMedian = percentile(speculative, 0.5);
	console.log(
		JSON.stringify({
			benchmark: "streamed_eval_local_read",
			repeats: REPEATS,
			providerTailMs: PROVIDER_TAIL_MS,
			readMs: READ_MS,
			baseline: { medianMs: baselineMedian, p95Ms: percentile(baseline, 0.95), samplesMs: baseline },
			speculative: {
				medianMs: speculativeMedian,
				p95Ms: percentile(speculative, 0.95),
				samplesMs: speculative,
			},
			speedup: baselineMedian / speculativeMedian,
		}),
	);
} finally {
	await disposeAllVmContexts();
	await fs.rm(directory, { recursive: true, force: true });
}
