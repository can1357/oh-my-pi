import { type MessagePort, parentPort } from "node:worker_threads";
import { type } from "@oh-my-pi/omptype";
import { getSharedAgyWorkerBridge } from "@oh-my-pi/pi-ai/providers/antigravity-cli-state";
import { AgyHost } from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import { StepWriter } from "@oh-my-pi/pi-ai/providers/antigravity-cli/step-writer";
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { SubagentMainApi, SubagentWorkerApi, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { antigravityCliThreadService } from "../../src/thread/services/antigravity-cli";

export interface WorkerStepOutcome {
	text: string;
	conversationId: string | undefined;
	toolCallsExecuted: number;
}

export type AgyWorkerProbe = (op: string, ...args: unknown[]) => Promise<unknown>;

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const model = buildModel({
	api: "antigravity-acp",
	provider: "antigravity-cli",
	id: "gemini-4-carbon",
	name: "Gemini 4 Carbon",
	baseUrl: "",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});

const readTool: Tool = { name: "read", description: "Read a file", parameters: type({ path: "string" }) };
const openHosts = new Map<string, AgyHost>();

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

async function runHostStep(host: AgyHost, messages: Message[], tools?: Tool[]): Promise<AssistantMessage> {
	const stream = new AssistantMessageEventStream();
	const writer = new StepWriter(model, stream);
	const context: Context = { messages, tools };
	await host.step(model, context, {}, writer);
	return writer.output;
}

const probe: AgyWorkerProbe = async (op, ...args) => {
	switch (op) {
		case "runConversation": {
			const geminiDir = String(args[0]);
			const promptText = String(args[1]);
			const keepOpen = Boolean(args[2]);
			const host = new AgyHost(geminiDir);
			let toolCallsExecuted = 0;
			try {
				const messages: Message[] = [{ role: "user", content: promptText, timestamp: 0 }];
				const first = await runHostStep(host, messages, [readTool]);
				const toolCall = first.content.find(block => block.type === "toolCall");
				let finalMessage = first;
				if (toolCall && toolCall.type === "toolCall") {
					toolCallsExecuted += 1;
					const result: ToolResultMessage = {
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: `worker-read:${String(toolCall.arguments.path)}` }],
						isError: false,
						timestamp: 1,
					};
					messages.push(first, result);
					finalMessage = await runHostStep(host, messages, [readTool]);
				}
				const outcome: WorkerStepOutcome = {
					text: assistantText(finalMessage),
					conversationId: host.conversationId,
					toolCallsExecuted,
				};
				if (keepOpen && host.conversationId) {
					openHosts.set(host.conversationId, host);
				} else {
					await host.dispose();
				}
				return outcome;
			} catch (error) {
				await host.dispose();
				throw error;
			}
		}
		case "probeRequestErrorOnLoad": {
			const geminiDir = String(args[0]);
			const bridge = getSharedAgyWorkerBridge();
			if (!bridge) throw new Error("worker bridge was not registered");
			const abort = new AbortController();
			const lease = await bridge({
				geminiDir,
				credentialVersion: undefined,
				tools: [],
				signal: abort.signal,
				onCall: async () => ({ content: [{ type: "text", text: "unused" }], isError: true }),
				onUpdate: () => undefined,
			});
			try {
				await lease.connection.initialize({
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: "bridge", title: "Host tool bridge", version: "1" },
				});
				await lease.connection.loadSession({
					sessionId: "00000000-0000-4000-8000-00000000dead",
					cwd: geminiDir,
					mcpServers: [],
				});
				return { isRequestError: false, message: "unexpectedly succeeded" };
			} catch (error) {
				return {
					isRequestError: error instanceof RequestError,
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				lease.close();
			}
		}
		case "disposeAll": {
			for (const [id, host] of openHosts) {
				openHosts.delete(id);
				await host.dispose();
			}
			return true;
		}
		default:
			throw new Error(`unknown probe op: ${op}`);
	}
};

function isRegistrar(value: unknown): value is (registered: AgyWorkerProbe) => Promise<void> {
	return typeof value === "function";
}

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink<SubagentWorkerApi, SubagentMainApi>(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "agy-service-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	antigravityCliThreadService.installWorker?.(link);
	link.handle("boot", async globals => {
		await antigravityCliThreadService.boot?.(globals[antigravityCliThreadService.name], link);
		const register = globals.probe;
		if (!isRegistrar(register)) throw new Error("boot expects a probe registrar");
		await register(probe);
	});
	link.handle("ping", nonce => nonce);
	port.postMessage({ ready: true });
});
