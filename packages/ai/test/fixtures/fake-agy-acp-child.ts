/**
 * Deterministic protocol-speaking fake `agy acp` subprocess for integration tests.
 *
 * Speaks ACP JSON-RPC 2.0 over stdio and connects over TCP to `--ide-mcp-port`
 * just like `agy acp --agent bridge`, recording per-process telemetry under
 * `<geminiDir>/fake-agy-<pid>.json` so tests can assert exact PID counts,
 * `initialize` calls, `cwd` isolation, advertised tool schemas, wire ordering,
 * and session lifecycle events without timers or mocked modules.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import * as path from "node:path";

interface SessionRecord {
	id: string;
	cwd: string;
	model?: string;
	thoughtLevel?: string;
	closed: boolean;
	stepIndex: number;
	cancelPrompt?: () => void;
}

export interface FakeAgyToolSnapshot {
	name: string;
	inputSchema: Record<string, unknown>;
}

export interface FakeAgyTelemetry {
	pid: number;
	spawnCwd: string;
	initializeCount: number;
	toolsListCount: number;
	sessionsCreated: Array<{ id: string; cwd: string }>;
	sessionsLoaded: Array<{ id: string; cwd: string }>;
	sessionsClosed: string[];
	sessionsCancelled: string[];
	observedTools: string[][];
	observedToolSchemas: FakeAgyToolSnapshot[][];
	wireEvents: string[];
}

interface McpReply {
	id?: number;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

interface BarrierState {
	remaining: number;
	ready: PromiseWithResolvers<void>;
}

function parseArgs(argv: string[]): { geminiDir: string; mcpPort: number } {
	let geminiDir = "";
	let mcpPort = 0;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--gemini-dir") geminiDir = argv[++i] ?? "";
		else if (argv[i] === "--ide-mcp-port") mcpPort = Number(argv[++i] ?? "0");
	}
	if (!geminiDir || !mcpPort) throw new Error(`Invalid fake agy args: ${argv.join(" ")}`);
	return { geminiDir, mcpPort };
}

const { geminiDir, mcpPort } = parseArgs(process.argv.slice(2));
const telemetryPath = path.join(geminiDir, `fake-agy-${process.pid}.json`);

const telemetry: FakeAgyTelemetry = {
	pid: process.pid,
	spawnCwd: process.cwd(),
	initializeCount: 0,
	toolsListCount: 0,
	sessionsCreated: [],
	sessionsLoaded: [],
	sessionsClosed: [],
	sessionsCancelled: [],
	observedTools: [],
	observedToolSchemas: [],
	wireEvents: [],
};

function flushTelemetry(): void {
	mkdirSync(geminiDir, { recursive: true });
	writeFileSync(telemetryPath, JSON.stringify(telemetry));
}

function recordWireEvent(event: string): void {
	telemetry.wireEvents.push(event);
	flushTelemetry();
}

flushTelemetry();

function writeStdio(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

function conversationDbPath(id: string): string {
	return path.join(geminiDir, "antigravity-cli", "conversations", `${id}.db`);
}

function ensureConversationDb(id: string): Database {
	const dbFile = conversationDbPath(id);
	mkdirSync(path.dirname(dbFile), { recursive: true });
	const db = new Database(dbFile);
	db.run("PRAGMA journal_mode = WAL");
	for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"]) {
		db.run(`CREATE TABLE IF NOT EXISTS ${table} (idx INTEGER PRIMARY KEY, body TEXT)`);
	}
	db.run("CREATE TABLE IF NOT EXISTS trajectory_meta (cascade_id TEXT, trajectory_id TEXT)");
	const existing = db.query("SELECT cascade_id FROM trajectory_meta LIMIT 1").get();
	if (!existing) {
		db.run("INSERT INTO trajectory_meta VALUES (?, ?)", [id, crypto.randomUUID()]);
	}
	return db;
}

function appendCheckpointStep(id: string, idx: number, body: string): void {
	const db = ensureConversationDb(id);
	try {
		for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"]) {
			db.run(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`, [idx, body]);
		}
	} finally {
		db.close();
	}
}

function readCheckpointBodies(id: string): string[] {
	const db = ensureConversationDb(id);
	try {
		const rows = db.query("SELECT body FROM steps ORDER BY idx").all() as Array<{ body: string }>;
		return rows.map(row => row.body);
	} finally {
		db.close();
	}
}

class McpPeer {
	readonly #socket: Socket;
	readonly #pending = new Map<number, PromiseWithResolvers<McpReply>>();
	#nextId = 1;
	#buffer = "";
	tools = new Map<string, Record<string, unknown>>();

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			for (let nl = this.#buffer.indexOf("\n"); nl >= 0; nl = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, nl).trim();
				this.#buffer = this.#buffer.slice(nl + 1);
				if (!line) continue;
				const frame = JSON.parse(line) as McpReply;
				if (typeof frame.id === "number") {
					const deferred = this.#pending.get(frame.id);
					if (deferred) {
						this.#pending.delete(frame.id);
						deferred.resolve(frame);
					}
				}
			}
		});
	}

	static async connect(port: number): Promise<McpPeer> {
		const socket = connect({ host: "127.0.0.1", port });
		const ready = Promise.withResolvers<void>();
		socket.once("connect", ready.resolve);
		socket.once("error", ready.reject);
		await ready.promise;
		const peer = new McpPeer(socket);
		await peer.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "agy" },
		});
		await peer.refreshTools();
		return peer;
	}

	request(method: string, params?: Record<string, unknown>): Promise<McpReply> {
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<McpReply>();
		this.#pending.set(id, deferred);
		this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return deferred.promise;
	}

	async refreshTools(): Promise<void> {
		const reply = await this.request("tools/list", {});
		const rawTools = Array.isArray(reply.result?.tools)
			? (reply.result.tools as Array<{ name: string; inputSchema?: Record<string, unknown> }>)
			: [];
		const names = rawTools.map(item => item.name);
		const schemas: FakeAgyToolSnapshot[] = rawTools.map(item => ({
			name: item.name,
			inputSchema: item.inputSchema ?? {},
		}));
		this.tools = new Map(schemas.map(item => [item.name, item.inputSchema]));
		telemetry.toolsListCount++;
		telemetry.observedTools.push(names);
		telemetry.observedToolSchemas.push(schemas);
		flushTelemetry();
	}
}

const sessions = new Map<string, SessionRecord>();
const barriers = new Map<string, BarrierState>();
let mcpPeerPromise: Promise<McpPeer> | undefined;

function arriveAtBarrier(key: string, expected: number): Promise<void> {
	let barrier = barriers.get(key);
	if (!barrier) {
		barrier = { remaining: expected, ready: Promise.withResolvers<void>() };
		barriers.set(key, barrier);
	}
	barrier.remaining--;
	if (barrier.remaining <= 0) {
		barriers.delete(key);
		barrier.ready.resolve();
	}
	return barrier.ready.promise;
}

function getMcpPeer(): Promise<McpPeer> {
	mcpPeerPromise ??= McpPeer.connect(mcpPort);
	return mcpPeerPromise;
}

function configOptions(thoughtValue = "medium") {
	return [
		{
			id: "thought_level",
			name: "Reasoning",
			type: "select",
			currentValue: thoughtValue,
			options: [
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
			],
		},
	];
}

function sendChunk(sessionId: string, kind: "agent_message_chunk" | "agent_thought_chunk", text: string): void {
	writeStdio({
		method: "session/update",
		params: {
			sessionId,
			update: {
				sessionUpdate: kind,
				content: { type: "text", text },
			},
		},
	});
}

function announceTool(sessionId: string, toolName: string): void {
	writeStdio({
		method: "session/update",
		params: {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: `call_${crypto.randomUUID()}`,
				title: `mcp_ide-tools_${toolName}`,
			},
		},
	});
}

async function handlePrompt(id: number | string, params: Record<string, unknown>): Promise<void> {
	const sessionId = String(params.sessionId ?? "");
	const session = sessions.get(sessionId);
	if (!session || session.closed) {
		writeStdio({ id, error: { code: -32602, message: "Unknown or closed session" } });
		return;
	}
	const blocks = Array.isArray(params.prompt) ? (params.prompt as Array<{ type: string; text?: string }>) : [];
	const text = blocks
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text!)
		.join("\n");

	let cancelled = false;
	const cancelWaiter = Promise.withResolvers<void>();
	session.cancelPrompt = () => {
		cancelled = true;
		cancelWaiter.resolve();
	};

	try {
		if (text.startsWith("barrier-crash:")) {
			const [, barrierKey = "crash", countRaw = "2", codeRaw = "42"] = text.split(":");
			sendChunk(sessionId, "agent_message_chunk", "before-crash");
			await arriveAtBarrier(barrierKey, Number(countRaw) || 2);
			process.exit(Number(codeRaw) || 42);
		}

		if (text.startsWith("barrier-wait-crash:")) {
			const [, barrierKey = "crash", countRaw = "2"] = text.split(":");
			sendChunk(sessionId, "agent_message_chunk", "in-flight");
			await arriveAtBarrier(barrierKey, Number(countRaw) || 2);
			await cancelWaiter.promise;
			writeStdio({ id, result: { stopReason: "cancelled" } });
			return;
		}

		if (text.startsWith("hold-and-release:")) {
			const [, barrierKey = "cancel", tag = "alpha"] = text.split(":");
			sendChunk(sessionId, "agent_message_chunk", `${tag}:holding`);
			await cancelWaiter.promise;
			void arriveAtBarrier(barrierKey, 2);
			writeStdio({ id, result: { stopReason: "cancelled" } });
			return;
		}

		if (text.startsWith("wait-sibling-cancel:")) {
			const [, barrierKey = "cancel", tag = "beta"] = text.split(":");
			sendChunk(sessionId, "agent_message_chunk", `${tag}:1 `);
			await Promise.race([arriveAtBarrier(barrierKey, 2), cancelWaiter.promise]);
			if (cancelled) {
				writeStdio({ id, result: { stopReason: "cancelled" } });
				return;
			}
			sendChunk(sessionId, "agent_message_chunk", `${tag}:2`);
			appendCheckpointStep(sessionId, session.stepIndex++, `survived:${tag}`);
			writeStdio({ id, result: { stopReason: "end_turn" } });
			return;
		}

		if (text.startsWith("barrier:")) {
			const [, barrierKey = "p", countRaw = "2", tag = "p"] = text.split(":");
			sendChunk(sessionId, "agent_thought_chunk", `think:${tag}:1 `);
			sendChunk(sessionId, "agent_message_chunk", `${tag}:1 `);
			await Promise.race([arriveAtBarrier(barrierKey, Number(countRaw) || 2), cancelWaiter.promise]);
			if (cancelled) {
				writeStdio({ id, result: { stopReason: "cancelled" } });
				return;
			}
			sendChunk(sessionId, "agent_thought_chunk", `think:${tag}:2`);
			sendChunk(sessionId, "agent_message_chunk", `${tag}:2`);
			appendCheckpointStep(sessionId, session.stepIndex++, `barrier:${tag}`);
			writeStdio({
				id,
				result: {
					stopReason: "end_turn",
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				},
			});
			return;
		}

		if (text.startsWith("raw-mcp-call:")) {
			// Directly invoke tools/call with caller-controlled _meta (missing or unknown conversation_id).
			const rest = text.slice("raw-mcp-call:".length);
			const parsed = JSON.parse(rest) as {
				name: string;
				arguments?: Record<string, unknown>;
				conversationId?: string | null;
			};
			const peer = await getMcpPeer();
			const paramsPayload: Record<string, unknown> = {
				name: parsed.name,
				arguments: parsed.arguments ?? {},
			};
			if (parsed.conversationId !== null && parsed.conversationId !== undefined) {
				paramsPayload._meta = { "antigravity.google/conversation_id": parsed.conversationId };
			}
			const toolReply = await peer.request("tools/call", paramsPayload);
			if (toolReply.error) {
				sendChunk(sessionId, "agent_message_chunk", `mcp_error:${toolReply.error.code}:${toolReply.error.message}`);
			} else {
				sendChunk(sessionId, "agent_message_chunk", "unexpected_mcp_ok");
			}
			writeStdio({ id, result: { stopReason: "end_turn" } });
			return;
		}

		if (text.startsWith("call-tool:")) {
			const rest = text.slice("call-tool:".length);
			const sep = rest.indexOf(":");
			const toolName = sep >= 0 ? rest.slice(0, sep) : rest;
			const rawArgs = sep >= 0 ? rest.slice(sep + 1) : "{}";
			const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
			const peer = await getMcpPeer();
			if (!peer.tools.has(toolName)) {
				sendChunk(sessionId, "agent_message_chunk", `missing_from_tools_list:${toolName}`);
				writeStdio({ id, result: { stopReason: "end_turn" } });
				return;
			}
			announceTool(sessionId, toolName);
			recordWireEvent(`mcp_call_sent:${sessionId}:${toolName}`);
			const replyPromise = peer
				.request("tools/call", {
					name: toolName,
					arguments: parsedArgs,
					_meta: { "antigravity.google/conversation_id": sessionId },
				})
				.then(reply => {
					recordWireEvent(`mcp_call_reply_received:${sessionId}:${toolName}`);
					return reply;
				});
			const toolReply = await Promise.race([replyPromise, cancelWaiter.promise.then(() => undefined)]);
			if (cancelled || !toolReply) {
				recordWireEvent(`acp_prompt_cancelled_sent:${sessionId}`);
				writeStdio({ id, result: { stopReason: "cancelled" } });
				await replyPromise.catch(() => undefined);
				return;
			}
			recordWireEvent(`post_tool_turn:${sessionId}:${toolName}`);
			if (toolReply.error) {
				sendChunk(sessionId, "agent_message_chunk", `mcp_error:${toolReply.error.code}:${toolReply.error.message}`);
			} else {
				const content = Array.isArray(toolReply.result?.content)
					? (toolReply.result.content as Array<{ type: string; text?: string }>).map(c => c.text ?? "").join("")
					: "";
				sendChunk(sessionId, "agent_message_chunk", `tool_ok:${content}`);
			}
			appendCheckpointStep(sessionId, session.stepIndex++, `tool:${toolName}`);
			writeStdio({ id, result: { stopReason: "end_turn" } });
			return;
		}

		const history = readCheckpointBodies(sessionId);
		appendCheckpointStep(sessionId, session.stepIndex++, text);
		sendChunk(
			sessionId,
			"agent_message_chunk",
			`pid=${process.pid};cwd=${session.cwd};history=[${history.join(",")}];echo=${text}`,
		);
		writeStdio({ id, result: { stopReason: "end_turn" } });
	} finally {
		session.cancelPrompt = undefined;
	}
}

async function handleMessage(raw: string): Promise<void> {
	const msg = JSON.parse(raw) as { id?: number | string; method?: string; params?: Record<string, unknown> };
	const params = msg.params ?? {};
	switch (msg.method) {
		case "initialize": {
			telemetry.initializeCount++;
			flushTelemetry();
			await getMcpPeer();
			writeStdio({ id: msg.id, result: { protocolVersion: 1 } });
			return;
		}
		case "session/new": {
			const sessionId = crypto.randomUUID();
			const cwd = String(params.cwd ?? "");
			const db = ensureConversationDb(sessionId);
			db.close();
			sessions.set(sessionId, { id: sessionId, cwd, closed: false, stepIndex: 0 });
			telemetry.sessionsCreated.push({ id: sessionId, cwd });
			flushTelemetry();
			writeStdio({ id: msg.id, result: { sessionId, configOptions: configOptions() } });
			return;
		}
		case "session/load": {
			const sessionId = String(params.sessionId ?? "");
			const cwd = String(params.cwd ?? "");
			if (!existsSync(conversationDbPath(sessionId))) {
				writeStdio({ id: msg.id, error: { code: -32602, message: `Unknown session ${sessionId}` } });
				return;
			}
			const history = readCheckpointBodies(sessionId);
			sessions.set(sessionId, { id: sessionId, cwd, closed: false, stepIndex: history.length });
			telemetry.sessionsLoaded.push({ id: sessionId, cwd });
			flushTelemetry();
			writeStdio({ id: msg.id, result: { configOptions: configOptions() } });
			return;
		}
		case "session/set_config_option": {
			const sessionId = String(params.sessionId ?? "");
			const session = sessions.get(sessionId);
			if (session) {
				if (params.configId === "model") session.model = String(params.value ?? "");
				if (params.configId === "thought_level") session.thoughtLevel = String(params.value ?? "");
			}
			writeStdio({
				id: msg.id,
				result: { configOptions: configOptions(session?.thoughtLevel ?? "medium") },
			});
			return;
		}
		case "session/close": {
			const sessionId = String(params.sessionId ?? "");
			const session = sessions.get(sessionId);
			if (session) {
				session.closed = true;
				session.cancelPrompt?.();
			}
			telemetry.sessionsClosed.push(sessionId);
			recordWireEvent(`acp_close_received:${sessionId}`);
			writeStdio({ id: msg.id, result: {} });
			return;
		}
		case "session/cancel": {
			const sessionId = String(params.sessionId ?? "");
			telemetry.sessionsCancelled.push(sessionId);
			recordWireEvent(`acp_cancel_received:${sessionId}`);
			sessions.get(sessionId)?.cancelPrompt?.();
			return;
		}
		case "session/prompt": {
			if (msg.id !== undefined) void handlePrompt(msg.id, params);
			return;
		}
		default: {
			if (msg.id !== undefined) {
				writeStdio({ id: msg.id, error: { code: -32601, message: `Unsupported method ${msg.method}` } });
			}
		}
	}
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	stdinBuffer += chunk;
	for (let nl = stdinBuffer.indexOf("\n"); nl >= 0; nl = stdinBuffer.indexOf("\n")) {
		const line = stdinBuffer.slice(0, nl).trim();
		stdinBuffer = stdinBuffer.slice(nl + 1);
		if (line) void handleMessage(line);
	}
});
process.stdin.on("end", () => {
	process.exit(0);
});
