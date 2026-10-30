/**
 * Every frame a real `omp --mode rpc-ui` writes to stdout conforms to `rpc-wire.schema.json`.
 *
 * The type-level checks (`conformance.types.ts`, the contract hash) cover the declared shape; this
 * test covers what the server actually emits at runtime, where an untyped field can slip through a
 * `Record<string, unknown>`. It drives the CLI over raw JSONL against the scripted OpenAI-compatible
 * server (`fake-openai-server.ts`) through prompts, tool calls with approval dialogs, an `ask`
 * dialog, a host tool call, a subagent, slash commands, and a prompt large enough to be split into
 * `rpc_chunk` frames, then validates each frame:
 *
 * - its `type` must be one the schema declares (an unknown `type` fails);
 * - it must match the definition for that `type`, with every object closed: a property the schema
 *   does not declare fails, except inside definitions marked `x-open` (agent messages and their
 *   content, which pass through verbatim by design);
 * - a successful `response` must carry the `result` its command declares.
 *
 * `rpc_chunk` is framing, not part of the schema: chunk envelopes are checked here
 * and the reassembled frame is validated like any other.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fromJsonSchema, type } from "@oh-my-pi/omptype";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../../src/modes/rpc/rpc-frame";
import wireSchema from "../../src/modes/rpc/wire/rpc-wire.schema.json" with { type: "json" };

const CLI = path.join(import.meta.dir, "../../src/cli.ts");
const FAKE_SERVER = path.join(import.meta.dir, "fake-openai-server.ts");
const decoder = new TextDecoder();

type Frame = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

interface WireCommand {
	name: string;
	result: string | null;
	nullable: boolean;
}

const bundle = wireSchema as unknown as {
	"x-rpc": { serverFrame: string; commands: WireCommand[] };
	$defs: Record<string, JsonSchema>;
};

/**
 * The bundle with every object closed (`additionalProperties: false`) unless it is marked
 * `x-open` or already says what extra keys may hold.
 */
function closeObjects(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(closeObjects);
	if (!isRecord(node)) return node;
	const closed: JsonSchema = {};
	for (const [key, value] of Object.entries(node)) {
		closed[key] =
			(key === "properties" || key === "$defs") && isRecord(value)
				? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, closeObjects(schema)]))
				: closeObjects(value);
	}
	if (
		closed.type === "object" &&
		isRecord(closed.properties) &&
		!("additionalProperties" in closed) &&
		closed["x-open"] !== true
	) {
		closed.additionalProperties = false;
	}
	return closed;
}

/**
 * Definitions whose emitted values carry properties the schema does not declare today. Each entry
 * is a known contract gap, kept open in the tolerant bundle so it does not mask new drift; the
 * `test.failing` case below validates without it and starts passing once the gap is closed.
 */
const KNOWN_DRIFT: Record<string, string> = {
	ModelInfo:
		"every ModelInfo carrier (get_state, get_available_models, config_update, …) sends the server's full model record: identity, requiresGlyphTokenization, supportsComputerUse, and supportsTools are undeclared",
};

const strictBundle = closeObjects(wireSchema) as JsonSchema & { $defs: Record<string, JsonSchema> };
const tolerantBundle: JsonSchema = {
	...strictBundle,
	$defs: {
		...strictBundle.$defs,
		...Object.fromEntries(Object.keys(KNOWN_DRIFT).map(name => [name, bundle.$defs[name]])),
	},
};

/** The leaf definitions of a union definition, by the `type` constant each declares. */
function definitionsByType(name: string, into = new Map<string, string[]>()): Map<string, string[]> {
	const def = bundle.$defs[name];
	if (!def) throw new Error(`missing definition ${name}`);
	const branches = def.anyOf ?? def.oneOf;
	if (Array.isArray(branches)) {
		for (const branch of branches as JsonSchema[]) {
			const ref = String(branch.$ref ?? "");
			if (!ref.startsWith("#/$defs/")) throw new Error(`${name}: inline union branch`);
			definitionsByType(ref.slice("#/$defs/".length), into);
		}
		return into;
	}
	const typeConst = (def.properties as Record<string, JsonSchema> | undefined)?.type?.const;
	if (typeof typeConst !== "string") throw new Error(`${name}: no \`type\` constant`);
	into.set(typeConst, [...(into.get(typeConst) ?? []), name]);
	return into;
}

const SERVER_FRAME_TYPES = definitionsByType(bundle["x-rpc"].serverFrame);
const COMMANDS = new Map(bundle["x-rpc"].commands.map(command => [command.name, command]));

type Validator = (data: unknown) => unknown;
const validators = new Map<string, Validator>();

/** A validator for one definition, or for any of several (`a | b`), in `root`'s scope. */
function validatorFor(root: JsonSchema, names: string): Validator {
	const key = `${root === strictBundle ? "strict" : "tolerant"}:${names}`;
	let validate = validators.get(key);
	if (!validate) {
		const refs = names.split(" | ").map(name => ({ $ref: `#/$defs/${name}` }));
		validate = fromJsonSchema(
			refs.length === 1 ? { ...root, ...refs[0] } : { ...root, anyOf: refs },
		) as unknown as Validator;
		validators.set(key, validate);
	}
	return validate;
}

/** Throws with the validator's summary when `data` does not match definition `name`. */
function expectConforms(root: JsonSchema, name: string, data: unknown): void {
	const result = validatorFor(root, name)(structuredClone(data));
	if (result instanceof type.errors) throw new Error(`${name}: ${result.summary}`);
}

/** Validates one logical stdout frame: known `type`, closed shape, and the command's declared result. */
function expectFrameConforms(frame: Frame, root: JsonSchema = tolerantBundle): void {
	const frameType = frame.type;
	if (typeof frameType !== "string") throw new Error(`frame without a string type: ${JSON.stringify(frame)}`);
	const names = SERVER_FRAME_TYPES.get(frameType);
	if (!names) throw new Error(`frame type ${frameType} is not declared in rpc-wire.schema.json`);
	expectConforms(root, names.join(" | "), frame);
	if (frameType !== "response" || frame.success !== true) return;
	const command = COMMANDS.get(String(frame.command));
	if (!command) throw new Error(`response to undeclared command ${String(frame.command)}`);
	if (command.result === null) return;
	if (frame.data == null && command.nullable) return;
	// Servers omit `data` for results whose fields are all optional (the `prompt` ack); generated
	// clients decode an absent `data` as `{}`, so validate exactly that.
	expectConforms(root, command.result, frame.data ?? {});
}

/** The {@link expectFrameConforms} failure for each frame that has one. */
function nonConforming(frames: readonly Frame[], root: JsonSchema = tolerantBundle): string[] {
	const failures: string[] = [];
	for (const frame of frames) {
		try {
			expectFrameConforms(frame, root);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	return failures;
}

const RPC_CHUNK_KEYS = ["byteLength", "chunkId", "count", "data", "index", "type"];

interface Waiter {
	match: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

/**
 * One `omp --mode rpc-ui` on the fake model. Records every stdout line and every reassembled
 * frame, and answers dialogs: approvals are allowed, `ask` picks `Blue`, host tools echo.
 */
class RpcUiHarness {
	readonly lines: string[] = [];
	readonly frames: Frame[] = [];
	readonly chunks: Frame[] = [];
	readonly #dir: TempDir;
	readonly #server: Bun.Subprocess<"pipe", "pipe", "inherit">;
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stderr: Promise<string>;
	readonly #decoder = new RpcFrameDecoder();
	readonly #pumped: Promise<void>;
	#waiters: Waiter[] = [];
	#nextId = 0;

	private constructor(
		dir: TempDir,
		server: Bun.Subprocess<"pipe", "pipe", "inherit">,
		child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	) {
		this.#dir = dir;
		this.#server = server;
		this.#child = child;
		this.#stderr = new Response(child.stderr).text();
		this.#pumped = this.#pump();
	}

	get home(): string {
		return this.#dir.path();
	}

	static async start(): Promise<RpcUiHarness> {
		const dir = TempDir.createSync("@omp-rpc-emitted-frames-");
		const home = dir.path();
		const agentDir = path.join(home, ".omp/agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const server = Bun.spawn([process.execPath, FAKE_SERVER, agentDir], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		let ready = false;
		for await (const line of readLines(server.stdout, AbortSignal.timeout(30_000))) {
			if (decoder.decode(line).startsWith("READY ")) {
				ready = true;
				break;
			}
		}
		if (!ready) throw new Error("fake OpenAI server did not start");
		const child = Bun.spawn(
			[
				process.execPath,
				CLI,
				"--mode",
				"rpc-ui",
				"--approval-mode",
				"always-ask",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fake/fake-model",
			],
			{
				cwd: home,
				env: {
					HOME: home,
					PATH: process.env.PATH,
					XDG_CONFIG_HOME: home,
					XDG_DATA_HOME: home,
					PI_CODING_AGENT_DIR: agentDir,
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const harness = new RpcUiHarness(dir, server, child);
		await harness.waitFor(frame => frame.type === "ready");
		return harness;
	}

	async #pump(): Promise<void> {
		for await (const line of readLines(this.#child.stdout)) {
			const text = decoder.decode(line).replace(/\r?\n$/, "");
			if (text.length === 0) continue;
			this.lines.push(text);
			// Non-JSON stdout is a protocol violation; the final assertions report it.
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				continue;
			}
			if (isRecord(parsed) && parsed.type === "rpc_chunk") this.chunks.push(parsed);
			const frame = this.#decoder.push(parsed) as Frame | undefined;
			if (!frame) continue;
			this.frames.push(frame);
			this.#answer(frame);
			const waiter = this.#waiters.find(entry => entry.match(frame));
			if (waiter) {
				this.#waiters = this.#waiters.filter(entry => entry !== waiter);
				waiter.resolve(frame);
			}
		}
	}

	#answer(frame: Frame): void {
		if (frame.type === "host_tool_call") {
			const args = frame.arguments as { message?: string };
			this.write({
				type: "host_tool_result",
				id: frame.id,
				result: { content: [{ type: "text", text: `host:${args.message}` }] },
			});
			return;
		}
		if (frame.type !== "extension_ui_request") return;
		switch (frame.method) {
			case "select": {
				const options = frame.options as string[];
				const allow = options.find(option => /^(allow|approve|yes)/i.test(option)) ?? options[0];
				this.write({ type: "extension_ui_response", id: frame.id, value: allow });
				break;
			}
			case "confirm":
				this.write({ type: "extension_ui_response", id: frame.id, confirmed: true });
				break;
			case "input":
			case "editor":
				this.write({ type: "extension_ui_response", id: frame.id, value: "ok" });
				break;
			case "ask": {
				const questions = frame.questions as Array<{ id: string }>;
				this.write({
					type: "extension_ui_response",
					id: frame.id,
					answers: questions.map(question => ({ id: question.id, selectedOptions: ["Blue"] })),
				});
				break;
			}
		}
	}

	write(frame: Frame): void {
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#child.stdin.flush();
	}

	/** Resolve with the first frame `match` accepts from now on; the deadline only bounds a hung server. */
	waitFor(match: (frame: Frame) => boolean, timeoutMs = 60_000): Promise<Frame> {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter: Waiter = { match, resolve };
		this.#waiters.push(waiter);
		AbortSignal.timeout(timeoutMs).addEventListener("abort", () => {
			if (!this.#waiters.includes(waiter)) return;
			this.#waiters = this.#waiters.filter(entry => entry !== waiter);
			const last = this.frames.at(-1);
			reject(new Error(`timed out waiting for an RPC frame; last frame: ${JSON.stringify(last)?.slice(0, 500)}`));
		});
		return promise;
	}

	/** Send one command and return its successful response `data`. */
	async data(command: Frame): Promise<unknown> {
		const id = `c${++this.#nextId}`;
		const response = this.waitFor(frame => frame.type === "response" && frame.id === id);
		this.write({ ...command, id });
		const frame = await response;
		if (frame.success !== true) throw new Error(`${String(command.type)} failed: ${String(frame.error)}`);
		return frame.data;
	}

	/**
	 * Prompt and wait for it to complete (its `prompt_result`, or an `agentInvoked: false` ack for a
	 * builtin slash command), then for the session to settle.
	 */
	async prompt(message: string): Promise<Frame> {
		const id = `p${++this.#nextId}`;
		const result = this.waitFor(
			frame =>
				frame.id === id &&
				(frame.type === "prompt_result" ||
					(frame.type === "response" && isRecord(frame.data) && frame.data.agentInvoked === false)),
			120_000,
		);
		this.write({ type: "prompt", id, message });
		const frame = await result;
		await this.settled();
		return frame;
	}

	/**
	 * Wait until the session reports itself settled (idle, nothing queued). Subscribes to
	 * `session_settled` before asking `get_state`, as `RpcClient.waitForSettled` does, so a settle
	 * between the two cannot be missed.
	 */
	async settled(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter: Waiter = { match: frame => frame.type === "session_settled", resolve };
		this.#waiters.push(waiter);
		const timeout = AbortSignal.timeout(120_000);
		const onTimeout = () =>
			reject(
				new Error(
					`timed out waiting for session_settled; last frame: ${JSON.stringify(this.frames.at(-1))?.slice(0, 500)}`,
				),
			);
		timeout.addEventListener("abort", onTimeout);
		try {
			const state = (await this.data({ type: "get_state" })) as { isSettled?: boolean };
			if (state.isSettled === true) return;
			await promise;
		} finally {
			timeout.removeEventListener("abort", onTimeout);
			this.#waiters = this.#waiters.filter(entry => entry !== waiter);
		}
	}

	async stop(): Promise<void> {
		this.#child.stdin.end();
		this.#child.kill();
		await this.#child.exited;
		await this.#pumped.catch(() => {});
		await this.#stderr;
		this.#server.stdin.end();
		this.#server.kill();
		await this.#server.exited;
		await this.#dir.remove();
	}
}

/** What one scripted `omp --mode rpc-ui` session wrote to stdout. */
interface SessionOutput {
	lines: string[];
	frames: Frame[];
	chunks: Frame[];
	approvedWrite: boolean;
}

/**
 * Drives one session through every frame family the fake model can produce: protocol v2,
 * subscriptions, read-only commands, prompts with tool calls and dialogs, a host tool, a subagent,
 * a builtin slash command, a host shell command, and a prompt split into `rpc_chunk` frames.
 */
async function runScriptedSession(): Promise<SessionOutput> {
	const h = await RpcUiHarness.start();
	try {
		await h.data({ type: "negotiate_protocol", protocolVersion: 2 });
		await h.data({ type: "set_subagent_subscription", level: "events" });
		await h.data({ type: "set_ask_dialog", enabled: true });
		await h.data({
			type: "set_host_tools",
			tools: [
				{
					name: "echo_host",
					description: "Echo a value from the embedding host",
					parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
				},
			],
		});
		for (const command of [
			"get_state",
			"get_available_commands",
			"get_tree",
			"get_subagents",
			"get_available_models",
			"get_available_thinking_levels",
			"get_session_stats",
			"get_login_providers",
			"get_btw_history",
		]) {
			await h.data({ type: command });
		}

		// A plain turn, a tool call behind an approval dialog, an `ask` dialog, a host tool call.
		await h.prompt("hello");
		const approved = path.join(h.home, "approved.txt");
		await h.prompt(`write_uri ${approved}`);
		await h.prompt("ask_user");
		await h.prompt("echo_host");

		// A subagent runs as a background job: its completion, and the turn that consumes its
		// result, can follow the prompt's own result.
		const subagentDone = h.waitFor(
			frame =>
				frame.type === "subagent_lifecycle" && isRecord(frame.payload) && frame.payload.status === "completed",
			120_000,
		);
		await h.prompt("spawn_subagent");
		await subagentDone;
		await h.settled();

		// A builtin slash command: command output, the title change, the config change.
		await h.prompt("/model fake/fake-model");
		await h.data({ type: "bash", command: "echo from-bash" });

		// A prompt larger than one frame: protocol v2 splits it, and the history holding it, into chunks.
		await h.prompt(`${"x".repeat(MAX_RPC_FRAME_BYTES + 64 * 1024)} big`);
		await h.data({ type: "get_messages" });
		await h.data({ type: "get_branch_messages" });
		await h.data({ type: "get_last_assistant_text" });
		await h.data({ type: "get_session_stats" });
		return { lines: h.lines, frames: h.frames, chunks: h.chunks, approvedWrite: fs.existsSync(approved) };
	} finally {
		await h.stop();
	}
}

describe("emitted RPC frames conform to rpc-wire.schema.json", () => {
	let session: SessionOutput;

	beforeAll(async () => {
		session = await runScriptedSession();
	}, 300_000);

	test("the validator rejects an unknown type, an undeclared property, and a wrong result", () => {
		const conforms = (frame: Frame, root?: JsonSchema) => nonConforming([frame], root).length === 0;
		const settled = { type: "session_settled" };
		expect(conforms(settled)).toBe(true);
		expect(conforms({ type: "session_settled_v2" })).toBe(false);
		expect(conforms({ ...settled, extra: 1 })).toBe(false);
		const info = { type: "session_info_update", sessionId: "s1", title: "t" };
		expect(conforms(info)).toBe(true);
		expect(conforms({ ...info, title: 1 })).toBe(false);
		expect(conforms({ type: "session_info_update", title: "t" })).toBe(false);
		// A command result is closed too, and must be the one the command declares.
		const response = {
			type: "response",
			id: "c1",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: true },
		};
		expect(conforms(response)).toBe(true);
		expect(conforms({ ...response, data: { enabled: true, extra: 1 } })).toBe(false);
		expect(conforms({ ...response, data: { enabled: "yes" } })).toBe(false);
		expect(conforms({ ...response, command: "no_such_command" })).toBe(false);
		// An absent `data` decodes as `{}`: fine for the all-optional prompt ack, not for a required field.
		expect(conforms({ type: "response", id: "p1", command: "prompt", success: true })).toBe(true);
		expect(conforms({ type: "response", id: "c2", command: "set_ask_dialog", success: true })).toBe(false);
		// Messages are open by design: extra keys pass through.
		const user = { role: "user", content: "hi", timestamp: 1, providerExtra: true };
		expect(conforms({ type: "message_start", message: user })).toBe(true);
		// A known-drift definition is open only in the tolerant bundle.
		const model = {
			id: "m",
			name: "M",
			api: "openai-completions",
			provider: "p",
			baseUrl: "http://127.0.0.1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
			identity: {},
		};
		expect(conforms({ type: "config_update", model })).toBe(true);
		expect(conforms({ type: "config_update", model }, strictBundle)).toBe(false);
	});

	test("the session wrote only JSON frames and exercised every frame family under test", () => {
		const nonJson = session.lines.filter(line => {
			try {
				return !isRecord(JSON.parse(line));
			} catch {
				return true;
			}
		});
		expect(nonJson).toEqual([]);
		expect(session.approvedWrite).toBe(true);

		// Chunk envelopes carry exactly the framing fields; their payloads were reassembled and validated.
		expect(session.chunks.length).toBeGreaterThan(1);
		for (const chunk of session.chunks) expect(Object.keys(chunk).sort()).toEqual(RPC_CHUNK_KEYS);

		const seen = new Set(session.frames.map(frame => frame.type));
		for (const frameType of [
			"ready",
			"response",
			"prompt_result",
			"session_settled",
			"agent_start",
			"message_update",
			"tool_execution_start",
			"tool_execution_end",
			"extension_ui_request",
			"host_tool_call",
			"subagent_lifecycle",
			"subagent_progress",
			"subagent_event",
			"command_output",
			"session_info_update",
			"config_update",
		]) {
			expect(seen).toContain(frameType);
		}
		const uiMethods = new Set(
			session.frames.filter(frame => frame.type === "extension_ui_request").map(frame => frame.method),
		);
		expect(uiMethods).toContain("select");
		expect(uiMethods).toContain("ask");
	});

	test("every stdout frame matches its definition, with no unknown type or undeclared property", () => {
		expect(nonConforming(session.frames)).toEqual([]);
	});

	// Known drift (KNOWN_DRIFT): passes as a failing test until the server stops sending model fields
	// the schema does not declare, or the schema declares them; then drop the entry and this marker.
	test.failing("model descriptors carry only the properties ModelInfo declares", () => {
		expect(nonConforming(session.frames, strictBundle)).toEqual([]);
	});
});
