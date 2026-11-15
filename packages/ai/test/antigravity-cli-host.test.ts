import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { conversationStorePath } from "@oh-my-pi/pi-ai/providers/antigravity-cli/conversation-store";
import {
	AgyHost,
	type AgyConnection,
	type AgyHostOptions,
	type AgyScheduler,
	type AgyStepOptions,
	type AgyTransport,
	type AgyTransportOptions,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import type { McpToolOutput } from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";
import { StepWriter } from "@oh-my-pi/pi-ai/providers/antigravity-cli/step-writer";
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ContentBlock, PromptRequest, PromptResponse, SessionConfigOption } from "@oh-my-pi/pi-utils/acp";

const model = buildModel({
	api: "antigravity-acp",
	provider: "antigravity-cli",
	id: "gemini-3.8-flash",
	name: "Test model",
	baseUrl: "",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});
const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: type({ path: "string" }) }];
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

class Queue<T> {
	#items: T[] = [];
	#waiters: PromiseWithResolvers<T>[] = [];
	push(item: T): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve(item);
		else this.#items.push(item);
	}
	next(): Promise<T> {
		if (this.#items.length > 0) return Promise.resolve(this.#items.shift()!);
		const waiter = Promise.withResolvers<T>();
		this.#waiters.push(waiter);
		return waiter.promise;
	}
}

class Clock {
	readonly timers = new Map<object, { ms: number; callback(): void }>();
	readonly schedule: AgyScheduler = (ms, callback) => {
		const token = {};
		this.timers.set(token, { ms, callback });
		return {
			cancel: () => {
				this.timers.delete(token);
			},
		};
	};
	fire(ms: number): void {
		// Callbacks may schedule new timers; only fire the current matching batch.
		const ready = [...this.timers].filter(([, timer]) => timer.ms === ms);
		for (const [token, timer] of ready) {
			this.timers.delete(token);
			timer.callback();
		}
	}
}

interface FakePrompt {
	request: PromptRequest;
	response: PromiseWithResolvers<PromptResponse>;
}

class FakeAgy implements AgyTransport {
	readonly options: AgyTransportOptions;
	readonly prompts = new Queue<FakePrompt>();
	readonly cancellations = new Queue<void>();
	readonly promptHistory: FakePrompt[] = [];
	readonly loads: string[] = [];
	readonly created: string[] = [];
	readonly configurations: string[] = [];
	readonly abort = new AbortController();
	readonly exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly connection: AgyConnection;
	closed = false;
	cancelMode: "ack" | "hold" | "reject" = "ack";
	autoSteer = true;
	failLoad = false;
	configureGate: Promise<void> | undefined;
	currentId = "";
	#pending = new Set<FakePrompt>();

	constructor(options: AgyTransportOptions) {
		this.options = options;
		const configOptions: SessionConfigOption[] = [
			{
				id: "thought_level",
				name: "Reasoning",
				type: "select",
				currentValue: "medium",
				options: [
					{ value: "medium", name: "Medium" },
					{ value: "high", name: "High" },
				],
			},
		];
		this.connection = {
			signal: this.abort.signal,
			initialize: async () => ({ protocolVersion: 1 }),
			newSession: async () => {
				this.currentId = crypto.randomUUID();
				this.created.push(this.currentId);
				return { sessionId: this.currentId, configOptions };
			},
			loadSession: async params => {
				if (this.failLoad) throw new Error("Store version is incompatible");
				this.currentId = params.sessionId;
				this.loads.push(params.sessionId);
				this.text("replayed text must not leak");
				return { configOptions };
			},
			closeSession: async () => ({}),
			setSessionConfigOption: async params => {
				await this.configureGate;
				this.configurations.push(`${params.configId}:${params.value}`);
				return { configOptions };
			},
			prompt: request => {
				if (this.autoSteer) for (const old of this.#pending) old.response.resolve({ stopReason: "end_turn" });
				const prompt = { request, response: Promise.withResolvers<PromptResponse>() };
				this.#pending.add(prompt);
				this.promptHistory.push(prompt);
				this.prompts.push(prompt);
				void prompt.response.promise.then(
					() => this.#pending.delete(prompt),
					() => this.#pending.delete(prompt),
				);
				return prompt.response.promise;
			},
			cancel: async () => {
				this.cancellations.push(undefined);
				if (this.cancelMode === "reject") throw new Error("cancel write failed");
				if (this.cancelMode === "ack") this.acknowledgeCancel();
			},
		};
	}

	acknowledgeCancel(): void {
		for (const prompt of this.#pending) prompt.response.resolve({ stopReason: "cancelled" });
	}
	text(text: string): void {
		this.options.onUpdate({
			sessionId: this.currentId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		});
	}
	call(name = "read", args: Record<string, unknown> = { path: "a.txt" }, id = this.currentId): Promise<McpToolOutput> {
		this.options.onUpdate({
			sessionId: id,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: crypto.randomUUID(),
				title: `mcp_ide-tools_${name}`,
				status: "in_progress",
			},
		});
		return this.options.onCall(name, args, id);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
		for (const prompt of this.#pending) prompt.response.reject(new Error("connection closed"));
		this.exit.resolve(0);
	}
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(options: AgyHostOptions = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), "agy-host-test-"));
	const started = new Queue<FakeAgy>();
	const clock = new Clock();
	const instances: FakeAgy[] = [];
	const host = new AgyHost(dir, {
		startupTimeoutMs: 500,
		cancelTimeoutMs: 60,
		announcementTimeoutMs: 30,
		schedule: clock.schedule,
		startTransport: async input => {
			const fake = new FakeAgy(input);
			instances.push(fake);
			started.push(fake);
			return fake;
		},
		...options,
	});
	cleanup.push(async () => {
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	return { host, started, instances, dir, clock };
}

function step(
	host: AgyHost,
	messages: Message[],
	extra: Partial<Context> = {},
	signal?: AbortSignal,
	options: Omit<AgyStepOptions, "signal"> = {},
) {
	const stream = new AssistantMessageEventStream();
	const writer = new StepWriter(model, stream);
	const done = host.step(model, { messages, tools, ...extra }, { ...options, signal }, writer);
	done.catch(() => undefined);
	return { writer, done, stream };
}

function result(message: AssistantMessage, text = "actual file body"): ToolResultMessage {
	const call = message.content.find(block => block.type === "toolCall");
	if (!call || call.type !== "toolCall") throw new Error("Expected a tool call");
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

async function parked(options: AgyHostOptions = {}) {
	const state = await fixture(options);
	const messages = [user("read a.txt")];
	const first = step(state.host, messages);
	const fake = await state.started.next();
	const prompt = await fake.prompts.next();
	fake.text("Reading now.");
	const output = fake.call();
	await first.done;
	return { ...state, fake, prompt, output, messages: [...messages, first.writer.output], first };
}

function textOf(blocks: ContentBlock[]): string {
	return blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("AgyHost stateful steps", () => {
	it("rejects an ACP end that contains no usable model response", async () => {
		const state = await fixture();
		const run = step(state.host, [user("hello")]);
		const fake = await state.started.next();
		const prompt = await fake.prompts.next();
		prompt.response.resolve({ stopReason: "end_turn" });
		await expect(run.done).rejects.toThrow("without a usable response");
		expect(fake.closed).toBe(true);
	});
	it("parks and resumes multiple serial tool steps under exactly one ACP prompt", async () => {
		const state = await parked();
		let released = false;
		void state.output.then(() => {
			released = true;
		});
		await Promise.resolve();
		expect(released).toBe(false);
		expect(state.host.hasPendingTurn).toBe(true);
		const second = step(state.host, [...state.messages, result(state.first.writer.output)]);
		expect(await state.output).toEqual({ content: [{ type: "text", text: "actual file body" }], isError: false });
		state.fake.text("Next file.");
		const nextOutput = state.fake.call("read", { path: "b.txt" });
		await second.done;
		const third = step(state.host, [
			...state.messages,
			result(state.first.writer.output),
			second.writer.output,
			result(second.writer.output, "second body"),
		]);
		await nextOutput;
		state.fake.text("Finished.");
		state.prompt.response.resolve({
			stopReason: "end_turn",
			usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 },
		});
		await third.done;
		expect(state.fake.promptHistory).toHaveLength(1);
		expect(third.writer.output.content).toEqual([{ type: "text", text: "Finished." }]);
		expect(state.host.hasPendingTurn).toBe(false);
	});

	it("accepts steering before returning the held tool result and ignores the old prompt end", async () => {
		const state = await parked();
		state.fake.autoSteer = false;
		let released = false;
		void state.output.then(() => {
			released = true;
		});
		const next = step(state.host, [...state.messages, result(state.first.writer.output), user("also check b.txt")]);
		const steer = await state.fake.prompts.next();
		expect(released).toBe(false);
		expect(next.writer.done).toBe(false);
		state.prompt.response.resolve({ stopReason: "end_turn" });
		await state.output;
		expect(textOf(steer.request.prompt)).toBe("also check b.txt");
		state.fake.text("Steered response.");
		steer.response.resolve({ stopReason: "end_turn" });
		await next.done;
		expect(next.writer.output.content).toEqual([{ type: "text", text: "Steered response." }]);
	});

	it("waits for confirmed cancellation before releasing a deadline-held MCP call or sending its late result", async () => {
		const state = await parked({ holdLimitMs: 20, cancelTimeoutMs: 300 });
		state.fake.cancelMode = "hold";
		let released = false;
		void state.output.then(() => {
			released = true;
		});
		state.clock.fire(20);
		await state.fake.cancellations.next();
		expect(released).toBe(false);
		const next = step(state.host, [...state.messages, result(state.first.writer.output, "late actual body")]);
		await Promise.resolve();
		expect(state.fake.promptHistory).toHaveLength(1);
		state.fake.acknowledgeCancel();
		expect((await state.output).isError).toBe(true);
		const late = await state.fake.prompts.next();
		expect(textOf(late.request.prompt)).toContain("late actual body");
		state.fake.text("Late result received.");
		late.response.resolve({ stopReason: "end_turn" });
		await next.done;
	});

	it("kills a turn when cancellation is not acknowledged, then reseeds instead of resuming it", async () => {
		const state = await parked({ holdLimitMs: 10, cancelTimeoutMs: 15 });
		state.fake.cancelMode = "hold";
		state.clock.fire(10);
		await state.fake.cancellations.next();
		state.clock.fire(15);
		await state.fake.exited;
		expect(state.fake.closed).toBe(true);
		expect((await state.output).isError).toBe(true);
		const next = step(state.host, [...state.messages, result(state.first.writer.output, "result survives reseed")]);
		const restarted = await state.started.next();
		const prompt = await restarted.prompts.next();
		expect(textOf(prompt.request.prompt)).toContain("result survives reseed");
		restarted.text("Result received.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
	});

	it("does not treat an end_turn response as successful cancellation", async () => {
		const state = await parked({ holdLimitMs: 10, cancelTimeoutMs: 100 });
		state.fake.cancelMode = "hold";
		state.clock.fire(10);
		await state.fake.cancellations.next();
		state.prompt.response.resolve({ stopReason: "end_turn" });
		await state.fake.exited;
		expect(state.fake.closed).toBe(true);
		expect((await state.output).isError).toBe(true);
	});

	it("cancels and reseeds an edited assistant prefix instead of silently reusing history", async () => {
		const state = await parked();
		const edited = {
			...state.first.writer.output,
			content: state.first.writer.output.content.map(block =>
				block.type === "text" ? { ...block, text: "Edited text" } : block,
			),
		};
		const next = step(state.host, [state.messages[0]!, edited, result(edited)]);
		await state.fake.cancellations.next();
		const prompt = await state.fake.prompts.next();
		expect((await state.output).isError).toBe(true);
		expect(state.fake.created).toHaveLength(2);
		expect(textOf(prompt.request.prompt)).toContain("Edited text");
		state.fake.text("Edited history received.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
	});

	it("restarts on tool-set changes and carries the actual result and historical images into the reseed", async () => {
		const state = await parked();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const toolResult = result(state.first.writer.output);
		toolResult.content.push(image);
		const next = step(state.host, [...state.messages, toolResult], {
			tools: [...tools, { name: "write", description: "Write", parameters: type({ text: "string" }) }],
		});
		const restarted = await state.started.next();
		const prompt = await restarted.prompts.next();
		expect(state.fake.closed).toBe(true);
		expect(restarted.options.tools).toHaveLength(2);
		expect(prompt.request.prompt).toContainEqual(image);
		restarted.text("Image received.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
	});

	it("reloads completed conversation state on a tool-set change without leaking replay chunks", async () => {
		const state = await fixture();
		const first = step(state.host, [user("hello")]);
		const fake = await state.started.next();
		const prompt = await fake.prompts.next();
		fake.text("Hello.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await first.done;
		const id = state.host.conversationId;
		if (!id) throw new Error("Completed turn lost its conversation");
		const second = step(state.host, [user("hello"), first.writer.output, user("continue")], { tools: [] });
		const restarted = await state.started.next();
		const continuation = await restarted.prompts.next();
		expect(restarted.loads).toEqual([id]);
		expect(continuation.request.prompt).toEqual([{ type: "text", text: "continue" }]);
		expect(second.writer.output.content).toEqual([]);
		restarted.text("Continued.");
		continuation.response.resolve({ stopReason: "end_turn" });
		await second.done;
	});

	it("ignores post-terminal updates while the next step is still being configured", async () => {
		const state = await fixture();
		const first = step(state.host, [user("first")]);
		const fake = await state.started.next();
		const initial = await fake.prompts.next();
		fake.text("First answer.");
		initial.response.resolve({ stopReason: "end_turn" });
		await first.done;
		const next = step(state.host, [user("first"), first.writer.output, user("second")]);
		fake.text("late text from the old turn");
		const prompt = await fake.prompts.next();
		expect(next.writer.output.content).toEqual([]);
		fake.text("Second answer.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
		expect(first.writer.output.content).toEqual([{ type: "text", text: "First answer." }]);
	});
	it("reseeds the supplied transcript when a native session load rejects", async () => {
		const state = await fixture();
		const first = step(state.host, [user("remember image")]);
		const fake = await state.started.next();
		const initial = await fake.prompts.next();
		fake.text("Remembered.");
		initial.response.resolve({ stopReason: "end_turn" });
		await first.done;
		const second = step(state.host, [user("remember image"), first.writer.output, user("continue")], { tools: [] });
		const reloader = await state.started.next();
		reloader.failLoad = true;
		const reseeded = await state.started.next();
		const prompt = await reseeded.prompts.next();
		expect(reloader.closed).toBe(true);
		expect(textOf(prompt.request.prompt)).toContain("Remembered.");
		reseeded.text("Continued from replay.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await second.done;
	});
	it("cancels a parked turn before restarting for a rotated credential version", async () => {
		const state = await parked();
		state.fake.cancelMode = "hold";
		const next = step(state.host, [...state.messages, result(state.first.writer.output)], {}, undefined, {
			credentialVersion: "new-version",
		});
		await state.fake.cancellations.next();
		expect(state.instances).toHaveLength(1);
		state.fake.acknowledgeCancel();
		const restarted = await state.started.next();
		const prompt = await restarted.prompts.next();
		expect(textOf(prompt.request.prompt)).toContain("actual file body");
		expect(state.fake.closed).toBe(true);
		restarted.text("Done after credential rotation.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
	});

	it("forks a matching completed checkpoint on rollback and leaves its source history intact", async () => {
		const state = await fixture();
		const first = step(state.host, [user("remember 41")]);
		const fake = await state.started.next();
		const firstPrompt = await fake.prompts.next();
		const sourceId = fake.currentId;
		const store = conversationStorePath(state.dir, sourceId);
		await mkdir(path.dirname(store), { recursive: true });
		const db = new Database(store);
		cleanup.push(async () => {
			db.close();
		});
		db.run("PRAGMA journal_mode = WAL");
		for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"]) {
			db.run(`CREATE TABLE ${table} (idx INTEGER PRIMARY KEY, body TEXT)`);
			db.run(`INSERT INTO ${table} VALUES (0, '41')`);
		}
		db.run("CREATE TABLE trajectory_meta (cascade_id TEXT, trajectory_id TEXT)");
		db.run("INSERT INTO trajectory_meta VALUES (?, ?)", [sourceId, crypto.randomUUID()]);
		fake.text("Remembered 41.");
		firstPrompt.response.resolve({ stopReason: "end_turn" });
		await first.done;
		expect(first.writer.output.providerPayload?.type).toBe("antigravityCli");
		const second = step(state.host, [user("remember 41"), first.writer.output, user("overwrite 77")]);
		const secondPrompt = await fake.prompts.next();
		for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"])
			db.run(`INSERT INTO ${table} VALUES (1, '77')`);
		fake.text("Remembered 77.");
		secondPrompt.response.resolve({ stopReason: "end_turn" });
		await second.done;
		const branch = step(state.host, [user("remember 41"), first.writer.output, user("what was the first number?")]);
		const branchPrompt = await fake.prompts.next();
		const forkId = state.host.conversationId!;
		expect(forkId).not.toBe(sourceId);
		expect(fake.loads).toEqual([forkId]);
		expect(branch.writer.output.content).toEqual([]);
		expect(branchPrompt.request.prompt).toEqual([{ type: "text", text: "what was the first number?" }]);
		const fork = new Database(conversationStorePath(state.dir, forkId), { readonly: true });
		try {
			expect(fork.query("SELECT body FROM steps ORDER BY idx").all()).toEqual([{ body: "41" }]);
			expect(db.query("SELECT body FROM steps ORDER BY idx").all()).toEqual([{ body: "41" }, { body: "77" }]);
		} finally {
			fork.close();
		}
		fake.text("41");
		branchPrompt.response.resolve({ stopReason: "end_turn" });
		await branch.done;
	});

	it("stops and settles pending tools when a steering prompt rejects", async () => {
		const state = await parked();
		state.fake.autoSteer = false;
		const next = step(state.host, [...state.messages, result(state.first.writer.output), user("steer")]);
		const steer = await state.fake.prompts.next();
		steer.response.reject(new Error("prompt rejected"));
		await expect(next.done).rejects.toThrow("prompt rejected");
		expect((await state.output).isError).toBe(true);
		expect(state.fake.closed).toBe(true);
	});

	it("aborts setup promptly even when the pending configuration never settles", async () => {
		const state = await fixture();
		const abort = new AbortController();
		const run = step(state.host, [user("hi")], {}, abort.signal);
		const fake = await state.started.next();
		fake.configureGate = Promise.withResolvers<void>().promise;
		abort.abort();
		await expect(run.done).rejects.toThrow("aborted");
		expect(fake.closed).toBe(true);
	});

	it("aborts during steering without waiting for either ACP prompt", async () => {
		const state = await parked();
		state.fake.autoSteer = false;
		const abort = new AbortController();
		const next = step(
			state.host,
			[...state.messages, result(state.first.writer.output), user("steer")],
			{},
			abort.signal,
		);
		await state.fake.prompts.next();
		abort.abort();
		await expect(next.done).rejects.toThrow("aborted");
		expect((await state.output).isError).toBe(true);
		expect(state.fake.closed).toBe(true);
	});

	it("settles a parked tool and active step on process exit", async () => {
		const state = await parked();
		state.fake.exit.resolve(23);
		await state.output;
		expect(state.fake.closed).toBe(true);
		const next = step(state.host, [...state.messages, result(state.first.writer.output)]);
		const restarted = await state.started.next();
		await restarted.prompts.next();
		restarted.exit.resolve(24);
		await expect(next.done).rejects.toThrow("exited with code 24");
	});

	it("never emits unknown, foreign or unannounced tool calls", async () => {
		for (const kind of ["unknown", "foreign", "unannounced"] as const) {
			const state = await fixture();
			const run = step(state.host, [user("read")]);
			const fake = await state.started.next();
			await fake.prompts.next();
			const call =
				kind === "unannounced"
					? fake.options.onCall("read", { path: "a" }, fake.currentId)
					: fake.call(
							kind === "unknown" ? "missing" : "read",
							{ path: "a" },
							kind === "foreign" ? crypto.randomUUID() : fake.currentId,
						);
			if (kind === "unannounced" || kind === "foreign") state.clock.fire(30);
			expect((await call).isError).toBe(true);
			await expect(run.done).rejects.toThrow();
			expect(run.writer.output.content.some(block => block.type === "toolCall")).toBe(false);
			expect(fake.closed).toBe(true);
		}
	});

	it("close clears pending calls and deadline timers without a later cancel", async () => {
		const state = await parked({ holdLimitMs: 10 });
		state.host.close();
		expect((await state.output).isError).toBe(true);
		state.clock.fire(10);
		expect(state.clock.timers.size).toBe(0);
		expect(state.fake.closed).toBe(true);
		expect(state.host.hasPendingTurn).toBe(false);
	});

	it("closes a transport that arrives after an abort during startup", async () => {
		const gate = Promise.withResolvers<AgyTransport>();
		let startup: AgyTransportOptions | undefined;
		const started = Promise.withResolvers<void>();
		const state = await fixture({
			startTransport: options => {
				startup = options;
				started.resolve();
				return gate.promise;
			},
		});
		const abort = new AbortController();
		const first = step(state.host, [user("hi")], {}, abort.signal);
		await started.promise;
		abort.abort();
		await expect(first.done).rejects.toThrow("aborted");
		if (!startup) throw new Error("Missing transport options");
		const late = new FakeAgy(startup);
		gate.resolve(late);
		await late.exited;
		expect(late.closed).toBe(true);
	});

	it("times out setup without leaking the old transport", async () => {
		const state = await fixture();
		const first = step(state.host, [user("hi")]);
		const fake = await state.started.next();
		const gate = Promise.withResolvers<void>();
		fake.configureGate = gate.promise;
		const configuring = Promise.withResolvers<void>();
		const configure = fake.connection.setSessionConfigOption;
		fake.connection.setSessionConfigOption = params => {
			configuring.resolve();
			return configure(params);
		};
		await configuring.promise;
		state.clock.fire(500);
		await expect(first.done).rejects.toThrow("setup timed out");
		expect(fake.closed).toBe(true);
		gate.resolve();
	});

	it("does not subtract cache reads from ACP's already-uncached input usage", () => {
		const writer = new StepWriter(model, new AssistantMessageEventStream());
		writer.usage(408, {
			inputTokens: 319,
			outputTokens: 25,
			cachedReadTokens: 64,
			cachedWriteTokens: 0,
			thoughtTokens: 0,
			totalTokens: 408,
		});
		expect(writer.output.usage.input).toBe(319);
		expect(writer.output.usage.cacheRead).toBe(64);
		expect(writer.output.usage.output).toBe(25);
		expect(writer.output.usage.totalTokens).toBe(408);
		expect(writer.output.usage.contextTokens).toBe(408);
	});
	it("keeps completed stream output immutable and emits exactly one terminal event", () => {
		const stream = new AssistantMessageEventStream();
		const writer = new StepWriter(model, stream);
		writer.thinking("reasoning");
		writer.text("answer");
		writer.finish("stop", { type: "antigravityCli", conversationId: crypto.randomUUID(), digest: "a".repeat(64) });
		const snapshot = JSON.stringify(writer.output);
		writer.text("late");
		writer.thinking("late");
		writer.usage(999);
		writer.fail("error", "late failure");
		expect(JSON.stringify(writer.output)).toBe(snapshot);
		expect(stream.queue.map(event => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});
	it("rejects concurrent steps while the first request is still starting", async () => {
		const state = await fixture();
		const first = step(state.host, [user("first")]);
		const second = step(state.host, [user("second")]);
		await expect(second.done).rejects.toThrow("already running");
		const fake = await state.started.next();
		const prompt = await fake.prompts.next();
		fake.text("Done.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await first.done;
	});
});
