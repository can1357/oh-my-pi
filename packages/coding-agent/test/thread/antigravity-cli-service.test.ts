import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AgyHost } from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import { sharedAgyPool } from "@oh-my-pi/pi-ai/providers/antigravity-cli/shared-pool";
import { StepWriter } from "@oh-my-pi/pi-ai/providers/antigravity-cli/step-writer";
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FakeAgyTelemetry } from "../../../ai/test/fixtures/fake-agy-acp-child";
import type { MainThreadLink, SubagentMainApi, SubagentWorkerApi } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { antigravityCliThreadService } from "../../src/thread/services/antigravity-cli";
import type { AgyWorkerProbe, WorkerStepOutcome } from "../fixtures/antigravity-cli-service-worker";

const workerEntry = new URL("../fixtures/antigravity-cli-service-worker.ts", import.meta.url).href;

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

const cleanups: Array<() => Promise<void> | void> = [];
const originalAgyPath = process.env.PI_AGY_PATH;
const originalPath = process.env.PATH;

afterEach(async () => {
	await sharedAgyPool.drain();
	if (originalAgyPath === undefined) delete process.env.PI_AGY_PATH;
	else process.env.PI_AGY_PATH = originalAgyPath;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	while (cleanups.length > 0) {
		const fn = cleanups.pop()!;
		await fn();
	}
});

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

async function runMainHostConversation(host: AgyHost, promptText: string): Promise<string> {
	const messages: Message[] = [{ role: "user", content: promptText, timestamp: 0 }];
	const stream1 = new AssistantMessageEventStream();
	const writer1 = new StepWriter(model, stream1);
	const context1: Context = { messages, tools: [readTool] };
	await host.step(model, context1, {}, writer1);
	const first = writer1.output;
	const toolCall = first.content.find(block => block.type === "toolCall");
	if (!toolCall || toolCall.type !== "toolCall") return assistantText(first);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: `main-read:${String(toolCall.arguments.path)}` }],
		isError: false,
		timestamp: 1,
	};
	messages.push(first, result);
	const stream2 = new AssistantMessageEventStream();
	const writer2 = new StepWriter(model, stream2);
	await host.step(model, { messages, tools: [readTool] }, {}, writer2);
	return assistantText(writer2.output);
}

async function readTelemetries(geminiDir: string): Promise<FakeAgyTelemetry[]> {
	const entries = await fs.readdir(geminiDir).catch(() => [] as string[]);
	const files = entries.filter(name => name.startsWith("fake-agy-") && name.endsWith(".json")).sort();
	const out: FakeAgyTelemetry[] = [];
	for (const file of files) {
		out.push(JSON.parse(await fs.readFile(path.join(geminiDir, file), "utf8")) as FakeAgyTelemetry);
	}
	return out;
}

async function startWorker(): Promise<{
	worker: Worker;
	peer: WorkerPeer;
	link: MainThreadLink;
	probe: AgyWorkerProbe;
}> {
	const spawned = new Worker(workerEntry, { smol: true });
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const onReady = (event: MessageEvent): void => {
		if (event.data?.ready) {
			spawned.removeEventListener("message", onReady);
			resolve();
		}
	};
	spawned.addEventListener("message", onReady);
	spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const link: MainThreadLink = new RpcLink<SubagentMainApi, SubagentWorkerApi>(
		{
			send: frame => spawned.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
				spawned.addEventListener("message", listener);
				return () => spawned.removeEventListener("message", listener);
			},
		},
		{ name: "main↔agy-worker", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	link.handle("ping", nonce => nonce);
	const peer: WorkerPeer = { threadId: "w1", link };
	antigravityCliThreadService.installMain?.(peer);
	let probe: AgyWorkerProbe | undefined;
	await link.call("boot", {
		[antigravityCliThreadService.name]: antigravityCliThreadService.globals?.(peer),
		probe: (registered: AgyWorkerProbe) => {
			probe = registered;
		},
	});
	if (!probe) throw new Error("worker fixture did not register its probe");
	let cleaned = false;
	cleanups.push(async () => {
		if (cleaned) return;
		cleaned = true;
		antigravityCliThreadService.onWorkerExit?.(peer, "test end");
		link.close("test end");
		await spawned.terminate();
	});
	return { worker: spawned, peer, link, probe };
}

describe.skipIf(process.platform === "win32")("antigravity-cli thread service", () => {
	it("shares one main-thread agy process with worker sessions of matching tools, preserves RequestError across RpcLink, and cleans up on actual worker termination", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-thread-service-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const geminiDir = path.join(root, "gemini-account");
		const wrapperPath = path.join(root, "fake-agy");
		const fixtureScript = path.resolve(import.meta.dir, "../../../ai/test/fixtures/fake-agy-acp-child.ts");
		await fs.writeFile(
			wrapperPath,
			`#!${process.execPath}\nprocess.argv.splice(1, 0, ${JSON.stringify(fixtureScript)});\nawait import(${JSON.stringify(fixtureScript)});\n`,
			{ mode: 0o755 },
		);
		process.env.PI_AGY_PATH = wrapperPath;
		await fs.writeFile(path.join(root, "nc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		process.env.PATH = originalPath ? `${root}${path.delimiter}${originalPath}` : root;

		const { worker, peer, link, probe } = await startWorker();

		// 1. Verify RequestError reconstruction across RpcLink (NIT 4).
		const loadProbe = (await probe("probeRequestErrorOnLoad", geminiDir)) as {
			isRequestError: boolean;
			message: string;
		};
		expect(loadProbe.isRequestError).toBe(true);
		expect(loadProbe.message).toContain("Unknown session");
		await sharedAgyPool.drain();

		// Reset telemetry files from the empty-tool load probe so the main+worker test below starts clean.
		for (const file of await fs.readdir(geminiDir).catch(() => [] as string[])) {
			if (file.startsWith("fake-agy-")) await fs.rm(path.join(geminiDir, file), { force: true });
		}

		// 2. Run main-thread and worker-thread sessions with identical [readTool] concurrently: must share 1 agy PID.
		const mainHost = new AgyHost(geminiDir);
		cleanups.push(() => mainHost.dispose());

		const [mainText, workerOutcome] = await Promise.all([
			runMainHostConversation(mainHost, 'call-tool:read:{"path":"main-target.txt"}'),
			probe(
				"runConversation",
				geminiDir,
				'call-tool:read:{"path":"worker-target.txt"}',
				true,
			) as Promise<WorkerStepOutcome>,
		]);

		const telemetries = await readTelemetries(geminiDir);
		expect(telemetries).toHaveLength(1);
		expect(sharedAgyPool.activeBackendCount).toBe(1);
		expect(telemetries[0]!.sessionsCreated.map(s => s.id).sort()).toEqual(
			[mainHost.conversationId!, workerOutcome.conversationId!].sort(),
		);

		expect(mainText).toBe("tool_ok:main-read:main-target.txt");
		expect(workerOutcome.toolCallsExecuted).toBe(1);
		expect(workerOutcome.text).toBe("tool_ok:worker-read:worker-target.txt");
		const mainConversationId = mainHost.conversationId!;
		expect(workerOutcome.conversationId).toBeDefined();
		expect(workerOutcome.conversationId).not.toBe(mainConversationId);

		// Main host disposes cleanly; worker kept its session open.
		await mainHost.dispose();
		const beforeWorkerExit = (await readTelemetries(geminiDir))[0]!;
		expect(beforeWorkerExit.sessionsClosed).toContain(mainConversationId);
		expect(beforeWorkerExit.sessionsClosed).not.toContain(workerOutcome.conversationId!);

		// 3. Abruptly terminate the real Bun Worker and notify ThreadService (S6).
		await worker.terminate();
		antigravityCliThreadService.onWorkerExit?.(peer, "worker terminated");
		link.close("worker terminated");

		// Execute one quick main-thread ping on the same [readTool] backend so closeSession has flushed on stdio.
		const verifyHost = new AgyHost(geminiDir);
		cleanups.push(() => verifyHost.dispose());
		const verifyText = await runMainHostConversation(verifyHost, "verify-after-worker-terminate");
		expect(verifyText).toContain("echo=verify-after-worker-terminate");

		const afterWorkerExit = (await readTelemetries(geminiDir))[0]!;
		expect(afterWorkerExit.sessionsClosed).toContain(workerOutcome.conversationId!);
	});
});
