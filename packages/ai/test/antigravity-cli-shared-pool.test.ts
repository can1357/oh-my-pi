import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { AgyHost } from "../src/providers/antigravity-cli/host";
import type { AgyConnection, AgyScheduler, AgySpawnedProcess } from "../src/providers/antigravity-cli/process";
import { SharedAgyPool } from "../src/providers/antigravity-cli/shared-pool";
import { StepWriter } from "../src/providers/antigravity-cli/step-writer";
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import type { FakeAgyTelemetry } from "./fixtures/fake-agy-acp-child";

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

interface ManualTimer {
	delayMs: number;
	cancelled: boolean;
	fire: () => void;
}

function createManualScheduler(): { schedule: AgyScheduler; timers: ManualTimer[] } {
	const timers: ManualTimer[] = [];
	const schedule: AgyScheduler = (delayMs, callback) => {
		const entry: ManualTimer = {
			delayMs,
			cancelled: false,
			fire: () => {
				if (entry.cancelled) return;
				entry.cancelled = true;
				callback();
			},
		};
		timers.push(entry);
		return {
			cancel: () => {
				entry.cancelled = true;
			},
		};
	};
	return { schedule, timers };
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

function assistantThinking(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "thinking")
		.map(block => block.thinking)
		.join("");
}

async function runStep(
	host: AgyHost,
	messages: Message[],
	options: {
		tools?: Tool[];
		signal?: AbortSignal;
		shareProcess?: boolean;
		isolateWorkspace?: boolean;
		credentialVersion?: string;
	} = {},
): Promise<AssistantMessage> {
	const stream = new AssistantMessageEventStream();
	const writer = new StepWriter(model, stream);
	const context: Context = { messages, tools: options.tools };
	try {
		await host.step(
			model,
			context,
			{
				signal: options.signal,
				shareProcess: options.shareProcess,
				isolateWorkspace: options.isolateWorkspace,
				credentialVersion: options.credentialVersion,
			},
			writer,
		);
	} catch (error) {
		writer.fail(
			options.signal?.aborted ? "aborted" : "error",
			error instanceof Error ? error.message : String(error),
		);
	}
	return writer.output;
}

async function readTelemetries(geminiDir: string): Promise<FakeAgyTelemetry[]> {
	const entries = await fs.readdir(geminiDir).catch(() => [] as string[]);
	const files = entries.filter(name => name.startsWith("fake-agy-") && name.endsWith(".json")).sort();
	const items: FakeAgyTelemetry[] = [];
	for (const file of files) {
		const raw = await fs.readFile(path.join(geminiDir, file), "utf8");
		items.push(JSON.parse(raw) as FakeAgyTelemetry);
	}
	return items;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const cleanups: Array<() => Promise<void> | void> = [];
const originalAgyPath = process.env.PI_AGY_PATH;

afterEach(async () => {
	if (originalAgyPath === undefined) delete process.env.PI_AGY_PATH;
	else process.env.PI_AGY_PATH = originalAgyPath;
	while (cleanups.length > 0) {
		const fn = cleanups.pop()!;
		await fn();
	}
});

describe("SharedAgyPool deterministic seam contracts", () => {
	it("multiplexes raw leases without cross-talk and buffers early session/update notifications", async () => {
		let initializeCalls = 0;
		let startCalls = 0;
		let nextSessionNum = 1;
		let emitUpdate: ((note: SessionNotification) => void) | undefined;

		const pool = new SharedAgyPool({
			registerProcessHooks: false,
			startBackend: async opts => {
				startCalls++;
				emitUpdate = opts.onUpdate;
				const abort = new AbortController();
				const exited = Promise.withResolvers<number>();
				const connection: AgyConnection = {
					signal: abort.signal,
					initialize: async () => {
						initializeCalls++;
						return { protocolVersion: 1 };
					},
					newSession: async () => {
						const sessionId = `00000000-0000-4000-8000-00000000000${nextSessionNum++}`;
						// Emit an early notification BEFORE newSession resolves (S6).
						opts.onUpdate({
							sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: `early:${sessionId}` },
							},
						});
						return { sessionId, configOptions: [] };
					},
					loadSession: async () => ({ configOptions: [] }),
					closeSession: async () => ({}),
					setSessionConfigOption: async () => ({ configOptions: [] }),
					prompt: async ({ sessionId }) => {
						opts.onUpdate({
							sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: `turn:${sessionId}` },
							},
						});
						return { stopReason: "end_turn" };
					},
					cancel: async () => undefined,
				};
				const proc: AgySpawnedProcess = {
					connection,
					exited: exited.promise,
					ref: () => undefined,
					unref: () => undefined,
					close: () => {
						abort.abort();
						exited.resolve(0);
					},
				};
				return proc;
			},
		});
		cleanups.push(() => pool.drain());

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-seam-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

		const updatesA: string[] = [];
		const updatesB: string[] = [];
		const signal = new AbortController().signal;

		const [leaseA, leaseB] = await Promise.all([
			pool.acquire({
				geminiDir: root,
				credentialVersion: "v1",
				tools: [],
				signal,
				onCall: async () => ({ content: [] }),
				onUpdate: note => {
					if (note.update.sessionUpdate === "agent_message_chunk" && note.update.content.type === "text") {
						updatesA.push(note.update.content.text);
					}
				},
			}),
			pool.acquire({
				geminiDir: root,
				credentialVersion: "v1",
				tools: [],
				signal,
				onCall: async () => ({ content: [] }),
				onUpdate: note => {
					if (note.update.sessionUpdate === "agent_message_chunk" && note.update.content.type === "text") {
						updatesB.push(note.update.content.text);
					}
				},
			}),
		]);

		await Promise.all([
			leaseA.connection.initialize({ protocolVersion: 1 }),
			leaseB.connection.initialize({ protocolVersion: 1 }),
		]);
		expect(startCalls).toBe(1);
		expect(initializeCalls).toBe(1);

		const [createdA, createdB] = await Promise.all([
			leaseA.connection.newSession({ cwd: root, mcpServers: [] }),
			leaseB.connection.newSession({ cwd: root, mcpServers: [] }),
		]);

		// Stray notification for an unowned session must be ignored.
		emitUpdate?.({
			sessionId: "00000000-0000-4000-8000-ffffffffffff",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } },
		});

		await Promise.all([
			leaseA.connection.prompt({ sessionId: createdA.sessionId, prompt: [{ type: "text", text: "a" }] }),
			leaseB.connection.prompt({ sessionId: createdB.sessionId, prompt: [{ type: "text", text: "b" }] }),
		]);

		expect(updatesA).toEqual([`early:${createdA.sessionId}`, `turn:${createdA.sessionId}`]);
		expect(updatesB).toEqual([`early:${createdB.sessionId}`, `turn:${createdB.sessionId}`]);

		leaseA.close();
		leaseB.close();
		await Promise.all([leaseA.exited, leaseB.exited]);
	});

	it("validates duplicate tool definitions before cancelling a warm backend idle timer (S4)", async () => {
		const { schedule, timers } = createManualScheduler();
		let closedCount = 0;

		const pool = new SharedAgyPool({
			idleTimeoutMs: 60_000,
			schedule,
			registerProcessHooks: false,
			startBackend: async () => {
				const abort = new AbortController();
				const exited = Promise.withResolvers<number>();
				return {
					connection: {
						signal: abort.signal,
						initialize: async () => ({ protocolVersion: 1 }),
						newSession: async () => ({ sessionId: crypto.randomUUID(), configOptions: [] }),
						loadSession: async () => ({ configOptions: [] }),
						closeSession: async () => ({}),
						setSessionConfigOption: async () => ({ configOptions: [] }),
						prompt: async () => ({ stopReason: "end_turn" }),
						cancel: async () => undefined,
					},
					exited: exited.promise,
					ref: () => undefined,
					unref: () => undefined,
					close: () => {
						closedCount++;
						abort.abort();
						exited.resolve(0);
					},
				};
			},
		});
		cleanups.push(() => pool.drain());

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-s4-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const toolDef = { name: "dup", description: "d", inputSchema: { type: "object" } };

		const validLease = await pool.acquire({
			geminiDir: root,
			credentialVersion: "v1",
			tools: [toolDef],
			signal: new AbortController().signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});
		validLease.close();
		await validLease.exited;

		const idleTimers = timers.filter(t => t.delayMs === 60_000 && !t.cancelled);
		expect(idleTimers).toHaveLength(1);

		await expect(
			pool.acquire({
				geminiDir: root,
				credentialVersion: "v1",
				tools: [toolDef, toolDef],
				signal: new AbortController().signal,
				onCall: async () => ({ content: [] }),
				onUpdate: () => undefined,
			}),
		).rejects.toThrow("Duplicate Antigravity CLI tool name");

		// Warm backend's idle timer was NOT cancelled by the invalid acquire!
		expect(idleTimers[0]!.cancelled).toBe(false);
		idleTimers[0]!.fire();
		expect(closedCount).toBe(1);
		expect(pool.activeBackendCount).toBe(0);
	});

	it("closes an ACP session when lease.close() races an in-flight newSession (S5)", async () => {
		const rawNewSession = Promise.withResolvers<{ sessionId: string; configOptions: never[] }>();
		const closedSessions: string[] = [];

		const pool = new SharedAgyPool({
			registerProcessHooks: false,
			startBackend: async () => {
				const abort = new AbortController();
				const exited = Promise.withResolvers<number>();
				return {
					connection: {
						signal: abort.signal,
						initialize: async () => ({ protocolVersion: 1 }),
						newSession: () => rawNewSession.promise,
						loadSession: async () => ({ configOptions: [] }),
						closeSession: async ({ sessionId }) => {
							closedSessions.push(sessionId);
							return {};
						},
						setSessionConfigOption: async () => ({ configOptions: [] }),
						prompt: async () => ({ stopReason: "end_turn" }),
						cancel: async () => undefined,
					},
					exited: exited.promise,
					ref: () => undefined,
					unref: () => undefined,
					close: () => {
						abort.abort();
						exited.resolve(0);
					},
				};
			},
		});
		cleanups.push(() => pool.drain());

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-s5-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

		const lease = await pool.acquire({
			geminiDir: root,
			credentialVersion: "v1",
			tools: [],
			signal: new AbortController().signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});

		const inFlightNew = lease.connection.newSession({ cwd: root, mcpServers: [] });
		lease.close();
		await expect(inFlightNew).rejects.toThrow("Antigravity CLI session closed");

		const lateSessionId = "00000000-0000-4000-8000-00000000a555";
		rawNewSession.resolve({ sessionId: lateSessionId, configOptions: [] });
		await lease.exited;
		expect(closedSessions).toEqual([lateSessionId]);
	});

	it("lets an aborted waiter fail during backend boot without disrupting a healthy waiter, and retires rotated credentials gracefully (S6)", async () => {
		const bootGate = Promise.withResolvers<void>();
		const closedBackends: number[] = [];
		let backendSeq = 0;

		const pool = new SharedAgyPool({
			registerProcessHooks: false,
			startBackend: async () => {
				const id = ++backendSeq;
				if (id === 1) await bootGate.promise;
				const abort = new AbortController();
				const exited = Promise.withResolvers<number>();
				return {
					connection: {
						signal: abort.signal,
						initialize: async () => ({ protocolVersion: 1 }),
						newSession: async () => ({ sessionId: crypto.randomUUID(), configOptions: [] }),
						loadSession: async () => ({ configOptions: [] }),
						closeSession: async () => ({}),
						setSessionConfigOption: async () => ({ configOptions: [] }),
						prompt: async () => ({ stopReason: "end_turn" }),
						cancel: async () => undefined,
					},
					exited: exited.promise,
					ref: () => undefined,
					unref: () => undefined,
					close: () => {
						closedBackends.push(id);
						abort.abort();
						exited.resolve(0);
					},
				};
			},
		});
		cleanups.push(() => pool.drain());

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-boot-cred-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

		const aborting = new AbortController();
		const waiter1 = pool.acquire({
			geminiDir: root,
			credentialVersion: "cred-1",
			tools: [],
			signal: aborting.signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});
		const waiter2 = pool.acquire({
			geminiDir: root,
			credentialVersion: "cred-1",
			tools: [],
			signal: new AbortController().signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});
		waiter2.catch(() => undefined);

		aborting.abort(new Error("caller gave up"));
		await expect(waiter1).rejects.toThrow("caller gave up");

		bootGate.resolve();
		const leaseV1 = await waiter2;
		const sessionV1 = await leaseV1.connection.newSession({ cwd: root, mcpServers: [] });
		expect(sessionV1.sessionId).toBeDefined();
		expect(backendSeq).toBe(1);

		// Rotate credentialVersion with a newer credentialExpires while leaseV1 is open: starts backend #2, keeps #1 alive until leaseV1 closes.
		const leaseV2 = await pool.acquire({
			geminiDir: root,
			credentialVersion: "cred-2",
			credentialExpires: 2_000,
			tools: [],
			signal: new AbortController().signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});
		expect(backendSeq).toBe(2);
		expect(closedBackends).toEqual([]);

		// A concurrent caller holding a pre-refresh snapshot (older credentialExpires) reuses backend #2 instead of retiring it.
		const staleCallerLease = await pool.acquire({
			geminiDir: root,
			credentialVersion: "cred-1",
			credentialExpires: 1_000,
			tools: [],
			signal: new AbortController().signal,
			onCall: async () => ({ content: [] }),
			onUpdate: () => undefined,
		});
		expect(backendSeq).toBe(2);
		expect(staleCallerLease.credentialVersion).toBe("cred-2");
		expect(staleCallerLease.credentialExpires).toBe(2_000);
		staleCallerLease.close();

		leaseV1.close();
		await leaseV1.exited;
		expect(closedBackends).toEqual([1]);
		expect(pool.activeBackendCount).toBe(1);

		leaseV2.close();
		await leaseV2.exited;
	});
});

describe.skipIf(process.platform === "win32")("SharedAgyPool + AgyHost subprocess integration", () => {
	async function setupFakeAgyEnv(): Promise<{ root: string; geminiDir: string; wrapperPath: string }> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-pool-test-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const geminiDir = path.join(root, "gemini-account");
		const wrapperPath = path.join(root, "fake-agy");
		const fixtureScript = path.join(import.meta.dir, "fixtures", "fake-agy-acp-child.ts");
		await fs.writeFile(
			wrapperPath,
			`#!${process.execPath}\nprocess.argv.splice(1, 0, ${JSON.stringify(fixtureScript)});\nawait import(${JSON.stringify(fixtureScript)});\n`,
			{ mode: 0o755 },
		);
		process.env.PI_AGY_PATH = wrapperPath;
		return { root, geminiDir, wrapperPath };
	}

	it("shares one agy process across compatible sessions, isolates empty-workspace cwd, and routes concurrent tool calls without cross-talk", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const hostA = new AgyHost(geminiDir, { sharedPool: pool });
		const hostB = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => hostA.dispose());
		cleanups.push(() => hostB.dispose());

		const [turnA1, turnB1] = await Promise.all([
			runStep(hostA, [{ role: "user", content: "barrier:pair1:2:alpha", timestamp: 0 }], { tools: [readTool] }),
			runStep(hostB, [{ role: "user", content: "barrier:pair1:2:beta", timestamp: 0 }], { tools: [readTool] }),
		]);

		expect(assistantText(turnA1)).toBe("alpha:1 alpha:2");
		expect(assistantThinking(turnA1)).toBe("think:alpha:1 think:alpha:2");
		expect(assistantText(turnB1)).toBe("beta:1 beta:2");
		expect(assistantThinking(turnB1)).toBe("think:beta:1 think:beta:2");

		const telemetriesAfterPrompts = await readTelemetries(geminiDir);
		expect(telemetriesAfterPrompts).toHaveLength(1);
		const onlyChild = telemetriesAfterPrompts[0]!;
		expect(onlyChild.initializeCount).toBe(1);
		expect(onlyChild.toolsListCount).toBe(1);
		expect(onlyChild.spawnCwd).toBe(path.join(geminiDir, "empty-workspace"));
		expect(onlyChild.sessionsCreated).toHaveLength(2);
		for (const created of onlyChild.sessionsCreated) {
			expect(created.cwd).toBe(path.join(geminiDir, "empty-workspace"));
		}

		// Concurrent tool calls on the same shared MCP bridge route strictly by conversation_id.
		const messagesA: Message[] = [
			{ role: "user", content: "barrier:pair1:2:alpha", timestamp: 0 },
			turnA1,
			{ role: "user", content: 'call-tool:read:{"path":"alpha.txt"}', timestamp: 1 },
		];
		const messagesB: Message[] = [
			{ role: "user", content: "barrier:pair1:2:beta", timestamp: 0 },
			turnB1,
			{ role: "user", content: 'call-tool:read:{"path":"beta.txt"}', timestamp: 1 },
		];

		const [toolReqA, toolReqB] = await Promise.all([
			runStep(hostA, messagesA, { tools: [readTool] }),
			runStep(hostB, messagesB, { tools: [readTool] }),
		]);

		const callA = toolReqA.content.find(block => block.type === "toolCall");
		const callB = toolReqB.content.find(block => block.type === "toolCall");
		if (!callA || callA.type !== "toolCall" || !callB || callB.type !== "toolCall") {
			throw new Error("Expected concurrent read tool calls");
		}
		expect(callA.arguments).toEqual({ path: "alpha.txt" });
		expect(callB.arguments).toEqual({ path: "beta.txt" });

		const resultA: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callA.id,
			toolName: "read",
			content: [{ type: "text", text: "CONTENTS_A" }],
			isError: false,
			timestamp: 2,
		};
		const resultB: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callB.id,
			toolName: "read",
			content: [{ type: "text", text: "CONTENTS_B" }],
			isError: false,
			timestamp: 2,
		};

		const [doneA, doneB] = await Promise.all([
			runStep(hostA, [...messagesA, toolReqA, resultA], { tools: [readTool] }),
			runStep(hostB, [...messagesB, toolReqB, resultB], { tools: [readTool] }),
		]);

		expect(assistantText(doneA)).toBe("tool_ok:CONTENTS_A");
		expect(assistantText(doneB)).toBe("tool_ok:CONTENTS_B");
		expect(await readTelemetries(geminiDir)).toHaveLength(1);

		const idA = hostA.conversationId!;
		const idB = hostB.conversationId!;
		await Promise.all([hostA.dispose(), hostB.dispose()]);
		const finalTelemetry = (await readTelemetries(geminiDir))[0]!;
		expect(finalTelemetry.sessionsClosed.sort()).toEqual([idA, idB].sort());
	});

	it("isolates sessions with different yield schemas into distinct backends while sharing identical schemas (B1)", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const explorerYield: Tool = {
			name: "yield",
			description: "Explorer output",
			parameters: type({ files: "string[]" }),
		};
		const reviewerYield: Tool = {
			name: "yield",
			description: "Reviewer output",
			parameters: type({ verdict: "string", count: "number" }),
		};

		const explorer1 = new AgyHost(geminiDir, { sharedPool: pool });
		const explorer2 = new AgyHost(geminiDir, { sharedPool: pool });
		const reviewer = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => explorer1.dispose());
		cleanups.push(() => explorer2.dispose());
		cleanups.push(() => reviewer.dispose());

		const [expReq1, expReq2, revReq] = await Promise.all([
			runStep(explorer1, [{ role: "user", content: 'call-tool:yield:{"files":["a.ts"]}', timestamp: 0 }], {
				tools: [explorerYield],
			}),
			runStep(explorer2, [{ role: "user", content: 'call-tool:yield:{"files":["b.ts"]}', timestamp: 0 }], {
				tools: [explorerYield],
			}),
			runStep(reviewer, [{ role: "user", content: 'call-tool:yield:{"verdict":"ship","count":0}', timestamp: 0 }], {
				tools: [reviewerYield],
			}),
		]);

		// Two explorer sessions share 1 backend; reviewer gets its own backend -> 2 backends total, zero schema collision!
		expect(pool.activeBackendCount).toBe(2);
		const telemetries = await readTelemetries(geminiDir);
		expect(telemetries).toHaveLength(2);

		const callExp1 = expReq1.content.find(b => b.type === "toolCall");
		const callExp2 = expReq2.content.find(b => b.type === "toolCall");
		const callRev = revReq.content.find(b => b.type === "toolCall");
		expect(callExp1?.type === "toolCall" ? callExp1.arguments : undefined).toEqual({ files: ["a.ts"] });
		expect(callExp2?.type === "toolCall" ? callExp2.arguments : undefined).toEqual({ files: ["b.ts"] });
		expect(callRev?.type === "toolCall" ? callRev.arguments : undefined).toEqual({ verdict: "ship", count: 0 });

		// Verify each backend advertised ONLY its own yield schema.
		const schemaPropertySets = telemetries.map(t =>
			Object.keys((t.observedToolSchemas[0]?.[0]?.inputSchema.properties ?? {}) as Record<string, unknown>).sort(),
		);
		expect(schemaPropertySets.sort()).toEqual([["count", "verdict"], ["files"]]);
	});

	it("rejects shared MCP tools/call frames with missing or unknown conversation_id (S6)", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const host = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => host.dispose());

		const missingIdTurn = await runStep(
			host,
			[
				{
					role: "user",
					content: 'raw-mcp-call:{"name":"read","arguments":{"path":"a.txt"},"conversationId":null}',
					timestamp: 0,
				},
			],
			{ tools: [readTool] },
		);
		expect(assistantText(missingIdTurn)).toBe("mcp_error:-32602:Invalid conversation id");

		const unknownIdTurn = await runStep(
			host,
			[
				{
					role: "user",
					content: 'raw-mcp-call:{"name":"read","arguments":{"path":"a.txt"},"conversationId":null}',
					timestamp: 0,
				},
				missingIdTurn,
				{
					role: "user",
					content:
						'raw-mcp-call:{"name":"read","arguments":{"path":"a.txt"},"conversationId":"00000000-0000-4000-8000-ffffffffffff"}',
					timestamp: 1,
				},
			],
			{ tools: [readTool] },
		);
		expect(assistantText(unknownIdTurn)).toBe("mcp_error:-32602:Unknown conversation id");
	});

	it("cancels only the aborted session without disturbing a concurrent sibling session", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const hostCancel = new AgyHost(geminiDir, { sharedPool: pool });
		const hostSurvivor = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => hostCancel.dispose());
		cleanups.push(() => hostSurvivor.dispose());

		const abortController = new AbortController();
		const cancelledStream = new AssistantMessageEventStream();
		const cancelledWriter = new StepWriter(model, cancelledStream);

		const cancelPromise = (async () => {
			for await (const event of cancelledStream) {
				if (event.type === "text_delta" && event.delta.includes("alpha:holding")) {
					abortController.abort();
					break;
				}
			}
		})();

		const [cancelledRun, survivorOutput] = await Promise.all([
			hostCancel
				.step(
					model,
					{ messages: [{ role: "user", content: "hold-and-release:cancel1:alpha", timestamp: 0 }] },
					{ signal: abortController.signal },
					cancelledWriter,
				)
				.catch(error => {
					cancelledWriter.fail(
						abortController.signal.aborted ? "aborted" : "error",
						error instanceof Error ? error.message : String(error),
					);
				})
				.then(() => cancelledWriter.output),
			runStep(hostSurvivor, [{ role: "user", content: "wait-sibling-cancel:cancel1:beta", timestamp: 0 }]),
			cancelPromise,
		]);

		expect(cancelledRun.stopReason).toBe("aborted");
		expect(survivorOutput.stopReason).toBe("stop");
		expect(assistantText(survivorOutput)).toBe("beta:1 beta:2");

		const telemetries = await readTelemetries(geminiDir);
		expect(telemetries).toHaveLength(1);
		expect(telemetries[0]!.sessionsCancelled).toEqual([hostCancel.conversationId!]);
	});

	it("cancels and settles the ACP prompt turn before releasing a parked MCP tool reply on dispose (S3)", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const host = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => host.dispose());

		const toolTurn = await runStep(
			host,
			[{ role: "user", content: 'call-tool:read:{"path":"parked.txt"}', timestamp: 0 }],
			{ tools: [readTool] },
		);
		expect(toolTurn.stopReason).toBe("toolUse");
		const sid = host.conversationId!;

		// Dispose while tools/call is parked on McpBridge!
		await host.dispose();

		// Run a quick ping on a fresh host sharing the same backend so all stdio/telemetry has settled.
		const verifyHost = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => verifyHost.dispose());
		await runStep(verifyHost, [{ role: "user", content: "ping-after-dispose", timestamp: 0 }], { tools: [readTool] });

		const telemetry = (await readTelemetries(geminiDir))[0]!;
		expect(telemetry.wireEvents).not.toContain(`post_tool_turn:${sid}:read`);

		const idxCallSent = telemetry.wireEvents.indexOf(`mcp_call_sent:${sid}:read`);
		const idxCancelRecv = telemetry.wireEvents.indexOf(`acp_cancel_received:${sid}`);
		const idxPromptCancelled = telemetry.wireEvents.indexOf(`acp_prompt_cancelled_sent:${sid}`);
		const idxMcpReply = telemetry.wireEvents.indexOf(`mcp_call_reply_received:${sid}:read`);
		const idxCloseRecv = telemetry.wireEvents.indexOf(`acp_close_received:${sid}`);

		expect(idxCallSent).toBeGreaterThanOrEqual(0);
		expect(idxCancelRecv).toBeGreaterThan(idxCallSent);
		expect(idxPromptCancelled).toBeGreaterThan(idxCancelRecv);
		expect(idxMcpReply).toBeGreaterThan(idxPromptCancelled);
		expect(idxCloseRecv).toBeGreaterThan(idxPromptCancelled);
	});

	it("propagates shared child crash to in-flight prompts, restarts cleanly, and resumes checkpoints via session/load", async () => {
		const { geminiDir } = await setupFakeAgyEnv();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const host1 = new AgyHost(geminiDir, { sharedPool: pool });
		const host2 = new AgyHost(geminiDir, { sharedPool: pool });
		cleanups.push(() => host1.dispose());
		cleanups.push(() => host2.dispose());

		const seedTurn = await runStep(host1, [{ role: "user", content: "seed-turn", timestamp: 0 }]);
		const firstPid = (await readTelemetries(geminiDir))[0]!.pid;
		expect(assistantText(seedTurn)).toContain(`pid=${firstPid}`);
		const conversation1 = host1.conversationId!;

		const [crashed1, crashed2] = await Promise.all([
			runStep(host1, [
				{ role: "user", content: "seed-turn", timestamp: 0 },
				seedTurn,
				{ role: "user", content: "barrier-crash:boom:2:42", timestamp: 1 },
			]),
			runStep(host2, [{ role: "user", content: "barrier-wait-crash:boom:2", timestamp: 0 }]),
		]);

		expect(crashed1.stopReason).toBe("error");
		expect(crashed1.errorMessage).toContain("exited with code 42");
		expect(crashed2.stopReason).toBe("error");
		expect(crashed2.errorMessage).toContain("exited with code 42");

		const resumedTurn = await runStep(host1, [
			{ role: "user", content: "seed-turn", timestamp: 0 },
			seedTurn,
			{ role: "user", content: "after-restart", timestamp: 2 },
		]);
		expect(resumedTurn.stopReason).toBe("stop");
		const resumedConversationId = host1.conversationId!;
		expect(resumedConversationId).toBeDefined();
		expect(resumedConversationId).not.toBe(conversation1);
		expect(assistantText(resumedTurn)).toContain("history=[seed-turn]");
		expect(assistantText(resumedTurn)).toContain("echo=after-restart");

		const telemetries = await readTelemetries(geminiDir);
		expect(telemetries).toHaveLength(2);
		const restarted = telemetries.find(t => t.pid !== firstPid)!;
		expect(restarted.sessionsLoaded.map(s => s.id)).toEqual([resumedConversationId]);
	});

	it("keeps a warm backend across sequential hosts until idle timeout fires, and honors shareProcess: false", async () => {
		const { root, geminiDir } = await setupFakeAgyEnv();
		const { schedule, timers } = createManualScheduler();
		const pool = new SharedAgyPool({ idleTimeoutMs: 60_000, schedule, registerProcessHooks: false });
		cleanups.push(() => pool.drain());

		const host1 = new AgyHost(geminiDir, { sharedPool: pool });
		const out1 = await runStep(host1, [{ role: "user", content: "first", timestamp: 0 }]);
		await host1.dispose();
		expect(pool.activeBackendCount).toBe(1);

		const host2 = new AgyHost(geminiDir, { sharedPool: pool });
		const out2 = await runStep(host2, [{ role: "user", content: "second", timestamp: 0 }]);
		await host2.dispose();

		const sharedTelemetries = await readTelemetries(geminiDir);
		expect(sharedTelemetries).toHaveLength(1);
		const sharedPid = sharedTelemetries[0]!.pid;
		expect(assistantText(out1)).toContain(`pid=${sharedPid}`);
		expect(assistantText(out2)).toContain(`pid=${sharedPid}`);

		const customCallerCwd = path.join(root, "caller-project");
		await fs.mkdir(customCallerCwd, { recursive: true });
		const prevCwd = process.cwd();
		process.chdir(customCallerCwd);
		try {
			const dedicatedHost = new AgyHost(geminiDir, { sharedPool: pool });
			const dedicatedOut = await runStep(dedicatedHost, [{ role: "user", content: "dedicated", timestamp: 0 }], {
				shareProcess: false,
				isolateWorkspace: false,
			});
			await dedicatedHost.dispose();

			const allTelemetries = await readTelemetries(geminiDir);
			expect(allTelemetries).toHaveLength(2);
			const dedicatedTelemetry = allTelemetries.find(t => t.pid !== sharedPid)!;
			expect(dedicatedTelemetry.spawnCwd).toBe(await fs.realpath(customCallerCwd));
			expect(assistantText(dedicatedOut)).toContain(`pid=${dedicatedTelemetry.pid}`);
		} finally {
			process.chdir(prevCwd);
		}

		const activeIdleTimers = timers.filter(t => !t.cancelled && t.delayMs === 60_000);
		expect(activeIdleTimers).toHaveLength(1);
		activeIdleTimers[0]!.fire();
		expect(pool.activeBackendCount).toBe(0);
		await pool.drain();
		expect(isProcessAlive(sharedPid)).toBe(false);
	});

	it("lets a short-lived CLI process exit naturally while an idle shared backend is warm and cleans up agy on exit (S1)", async () => {
		const { geminiDir, wrapperPath } = await setupFakeAgyEnv();
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const hostModulePath = path.resolve(import.meta.dir, "../src/providers/antigravity-cli/host.ts");
		const stepWriterPath = path.resolve(import.meta.dir, "../src/providers/antigravity-cli/step-writer.ts");
		const eventStreamPath = path.resolve(import.meta.dir, "../src/utils/event-stream.ts");

		const runnerSource = `import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgyHost } from ${JSON.stringify(hostModulePath)};
import { StepWriter } from ${JSON.stringify(stepWriterPath)};
import { AssistantMessageEventStream } from ${JSON.stringify(eventStreamPath)};

const model = buildModel({
	api: "antigravity-acp",
	provider: "antigravity-cli",
	id: "gemini-4-carbon",
	name: "Gemini 4 Carbon",
	baseUrl: "",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: true,
});

const host = new AgyHost(${JSON.stringify(geminiDir)});
const stream = new AssistantMessageEventStream();
const writer = new StepWriter(model, stream);
await host.step(model, { messages: [{ role: "user", content: "cli-oneshot", timestamp: 0 }] }, {}, writer);
await host.dispose();
// Intentionally do NOT call process.exit() or closeAllSharedAgyBackends():
// the warm backend's child, reader, TCP bridge, and 60s idle timer must all allow natural exit!
`;

		const startMs = performance.now();
		const proc = Bun.spawn([process.execPath, "-e", runnerSource], {
			cwd: repoRoot,
			env: { ...process.env, PI_AGY_PATH: wrapperPath },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const elapsedMs = performance.now() - startMs;
		const stderrText = await new Response(proc.stderr).text();

		expect(stderrText).toBe("");
		expect(exitCode).toBe(0);
		// Idle timeout is 60,000 ms; natural drain must finish in well under 3,000 ms.
		expect(elapsedMs).toBeLessThan(3_000);
		const telemetries = await readTelemetries(geminiDir);
		expect(telemetries).toHaveLength(1);
		expect(isProcessAlive(telemetries[0]!.pid)).toBe(false);
	});
});
