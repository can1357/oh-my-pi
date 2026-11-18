import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { conversationStorePath } from "@oh-my-pi/pi-ai/providers/antigravity-cli/conversation-store";
import {
	AgyHost,
	type AgyConnection,
	type AgyScheduler,
	type AgyTransport,
	type AgyTransportOptions,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import { StepWriter } from "@oh-my-pi/pi-ai/providers/antigravity-cli/step-writer";
import {
	decodeModelUsageStats,
	peekMaxModelStepIdx,
	readModelStepsAfter,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/usage-store";
import type { Message } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { PromptRequest, PromptResponse } from "@oh-my-pi/pi-utils/acp";

const model = buildModel({
	api: "antigravity-acp",
	provider: "antigravity-cli",
	id: "gemini-3.8-flash",
	name: "Test model",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
});

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function varint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = remaining & 0x7f;
		remaining >>>= 7;
		if (remaining) byte |= 0x80;
		bytes.push(byte);
	} while (remaining);
	return bytes;
}

function varintField(tag: number, value: number): number[] {
	return [...varint(tag << 3), ...varint(value)];
}

function field(tag: number, payload: number[]): number[] {
	return [...varint((tag << 3) | 2), ...varint(payload.length), ...payload];
}

interface FixtureUsage {
	input: number;
	output: number;
	cachedWrite: number;
	cachedRead: number;
	thought: number;
}

function metadata(usage: FixtureUsage): Uint8Array {
	return Uint8Array.from(
		field(9, [
			...varintField(2, usage.input),
			...varintField(3, usage.output),
			...varintField(4, usage.cachedWrite),
			...varintField(5, usage.cachedRead),
			...varintField(9, usage.thought),
		]),
	);
}

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

async function storeFile(dir: string): Promise<string> {
	const file = path.join(dir, "session.db");
	await fs.mkdir(path.dirname(file), { recursive: true });
	const db = new Database(file);
	db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
	const insert = db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)");
	insert.run(1, 15, 3, metadata({ input: 100, output: 20, cachedWrite: 5, cachedRead: 40, thought: 10 }));
	insert.run(2, 15, 3, metadata({ input: 200, output: 30, cachedWrite: 0, cachedRead: 60, thought: 15 }));
	insert.run(3, 14, 3, metadata({ input: 900, output: 900, cachedWrite: 0, cachedRead: 0, thought: 0 }));
	insert.run(4, 15, 2, metadata({ input: 900, output: 900, cachedWrite: 0, cachedRead: 0, thought: 0 }));
	db.close();
	return file;
}

describe("agy usage store", () => {
	it("decodes the model usage submessage from step metadata", () => {
		expect(
			decodeModelUsageStats(metadata({ input: 5492, output: 703, cachedWrite: 0, cachedRead: 0, thought: 687 })),
		).toEqual({
			inputTokens: 5492,
			outputTokens: 703,
			cachedWriteTokens: 0,
			cachedReadTokens: 0,
			thoughtTokens: 687,
		});
		expect(decodeModelUsageStats(Uint8Array.from([0xff]))).toBeUndefined();
		expect(decodeModelUsageStats(Uint8Array.from(varintField(7, 12)))).toBeUndefined();
	});

	it("decodes a captured agy 1.5.9 model-step metadata blob", () => {
		const captured = Uint8Array.from(
			Buffer.from(
				"CgsIrrDr1wYQ6ObMZxgCMgsIsbDr1wYQ6LqqFjoMCLWw69cGEOi/yL0CQgwItbDr1wYQ6L/IvQJKeAj4CxCXggEYqgkwGDooYm90LTYwOWU5NTQ0LTE4ZGItNDljNS1iZjBkLTI1NjVhZTM4M2Y0ZEIhCglzZXNzaW9uSUQSFC0zNzUwNzYzMDM0MzYyODk1NTc5SNgGUNICWhdMdGo2YXBDWU51emlyZmNQNzdESTRRb1j4C2IkMjU4NTJhYTItYWUyMC00ZDI2LWI2ZTUtZmI3ZTc2YjI0NDU1ogFOCiRlNWUwYjI1MS1kNjA2LTRiZmItYTkzYi1iNTAxMWVjOTFhZDIQASIkYzczYjc1OTEtYmM3Yi00NmI1LWFhZDUtZDNhYTQ3ZWYxZGRl0gEjCg8ICBILCLGw69cGEIjRrRYKEAgDEgwItbDr1wYQ6LzJvQKCAgwItbDr1wYQ6L/IvQKaAiA4OTZhYTJmZWEwYzQ0MjMxYTJjZmY1YTBjNzVhZWRmYg==",
				"base64",
			),
		);
		expect(decodeModelUsageStats(captured)).toEqual({
			inputTokens: 16663,
			outputTokens: 1194,
			cachedWriteTokens: 0,
			cachedReadTokens: 0,
			thoughtTokens: 856,
		});
	});

	it("rejects overflowing or truncated usage varints", () => {
		const overflowing = Uint8Array.from([
			...varint((9 << 3) | 2),
			...varint(11),
			0x10,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x02,
		]);
		expect(decodeModelUsageStats(overflowing)).toBeUndefined();
		const truncated = Uint8Array.from([...varint((9 << 3) | 2), ...varint(2), 0x10, 0x80]);
		expect(decodeModelUsageStats(truncated)).toBeUndefined();
	});

	it("reads only completed model steps after the cursor", async () => {
		const dir = await tempDir("agy-usage-store-");
		const file = await storeFile(dir);
		expect(peekMaxModelStepIdx(file)).toBe(4);
		expect(readModelStepsAfter(file, 0)).toEqual({
			maxIdx: 2,
			usage: { inputTokens: 300, outputTokens: 50, cachedWriteTokens: 5, cachedReadTokens: 100, thoughtTokens: 25 },
		});
		expect(readModelStepsAfter(file, 1)).toEqual({
			maxIdx: 2,
			usage: { inputTokens: 200, outputTokens: 30, cachedWriteTokens: 0, cachedReadTokens: 60, thoughtTokens: 15 },
		});
		expect(readModelStepsAfter(file, 2)).toBeUndefined();
		const db = new Database(file);
		db.run("UPDATE steps SET status = 3 WHERE idx = 4");
		db.close();
		expect(readModelStepsAfter(file, 3)).toEqual({
			maxIdx: 4,
			usage: { inputTokens: 900, outputTokens: 900, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 },
		});
		expect(readModelStepsAfter(file, 4)).toBeUndefined();
	});

	it("treats an empty store as a cursor and a missing or corrupt store as unavailable", async () => {
		const dir = await tempDir("agy-usage-store-empty-");
		const empty = path.join(dir, "empty.db");
		const db = new Database(empty);
		db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
		db.close();
		expect(peekMaxModelStepIdx(empty)).toBe(-1);
		expect(readModelStepsAfter(empty, -1)).toBeUndefined();

		const missing = path.join(dir, "missing.db");
		expect(peekMaxModelStepIdx(missing)).toBeUndefined();
		expect(readModelStepsAfter(missing, -1)).toBeUndefined();
		expect(await Bun.file(missing).exists()).toBe(false);

		const corrupt = path.join(dir, "corrupt.db");
		await Bun.write(corrupt, "not a sqlite database");
		expect(peekMaxModelStepIdx(corrupt)).toBeUndefined();
		expect(readModelStepsAfter(corrupt, -1)).toBeUndefined();
	});
});

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

class FakeAgy implements AgyTransport {
	readonly connection: AgyConnection;
	readonly exited: Promise<number>;
	readonly prompts = new Queue<{ request: PromptRequest; response: PromiseWithResolvers<PromptResponse> }>();
	currentId = "";
	readonly #abort = new AbortController();
	readonly #exit = Promise.withResolvers<number>();
	#latest: PromiseWithResolvers<PromptResponse> | undefined;

	constructor(readonly options: AgyTransportOptions) {
		this.exited = this.#exit.promise;
		this.connection = {
			signal: this.#abort.signal,
			initialize: async () => ({ protocolVersion: 1 }),
			newSession: async () => {
				this.currentId = crypto.randomUUID();
				return { sessionId: this.currentId };
			},
			loadSession: async params => {
				this.currentId = params.sessionId;
				return {};
			},
			closeSession: async () => ({}),
			setSessionConfigOption: async () => ({ configOptions: [] }),
			prompt: request => {
				const response = Promise.withResolvers<PromptResponse>();
				this.#latest = response;
				this.prompts.push({ request, response });
				return response.promise;
			},
			cancel: async () => {
				this.#latest?.resolve({ stopReason: "cancelled" });
			},
		};
	}

	text(text: string): void {
		this.options.onUpdate({
			sessionId: this.currentId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		});
	}

	close(): void {
		this.#abort.abort();
		this.#exit.resolve(0);
	}
}

const schedule: AgyScheduler = () => ({ cancel: () => undefined });

function seedRow(file: string, idx: number, usage: FixtureUsage, status = 3): void {
	const db = new Database(file);
	db.run("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, ?, ?)", [idx, status, metadata(usage)]);
	db.close();
}

function setRowStatus(file: string, idx: number, status: number): void {
	const db = new Database(file);
	db.run("UPDATE steps SET status = ? WHERE idx = ?", [status, idx]);
	db.close();
}

function begin(host: AgyHost, messages: Message[]) {
	const stream = new AssistantMessageEventStream();
	const writer = new StepWriter(model, stream);
	const done = host.step(model, { messages }, {}, writer);
	done.catch(() => undefined);
	return { writer, done };
}

describe("agy usage fallback", () => {
	it("recovers completed model-step totals when a turn reports no usage", async () => {
		const dir = await tempDir("agy-usage-host-");
		const started = new Queue<FakeAgy>();
		const host = new AgyHost(dir, {
			startupTimeoutMs: 500,
			cancelTimeoutMs: 60,
			announcementTimeoutMs: 30,
			schedule,
			startTransport: async input => {
				const transport = new FakeAgy(input);
				started.push(transport);
				return transport;
			},
		});
		cleanup.push(() => host.dispose());

		const messages = [user("count tokens")];
		const first = begin(host, messages);
		const fake = await started.next();
		const prompt = await fake.prompts.next();
		const store = conversationStorePath(dir, fake.currentId);
		await fs.mkdir(path.dirname(store), { recursive: true });
		const db = new Database(store);
		db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
		db.close();
		seedRow(store, 1, { input: 100, output: 20, cachedWrite: 5, cachedRead: 40, thought: 10 });
		seedRow(store, 2, { input: 200, output: 30, cachedWrite: 0, cachedRead: 60, thought: 15 });
		fake.text("First answer.");
		prompt.response.resolve({ stopReason: "end_turn" });
		await first.done;

		expect(first.writer.output.usage).toMatchObject({
			input: 300,
			output: 50,
			cacheRead: 100,
			cacheWrite: 5,
			reasoningTokens: 25,
			totalTokens: 455,
		});

		const second = begin(host, [...messages, first.writer.output, user("more")]);
		const nextPrompt = await fake.prompts.next();
		seedRow(store, 3, { input: 7, output: 3, cachedWrite: 0, cachedRead: 0, thought: 0 });
		fake.text("Second answer.");
		nextPrompt.response.resolve({ stopReason: "end_turn" });
		await second.done;

		expect(second.writer.output.usage).toMatchObject({
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
		});

		const third = begin(host, [...messages, first.writer.output, user("more"), second.writer.output, user("native")]);
		const nativePrompt = await fake.prompts.next();
		seedRow(store, 4, { input: 900, output: 900, cachedWrite: 0, cachedRead: 0, thought: 0 }, 2);
		fake.text("Native answer.");
		nativePrompt.response.resolve({
			stopReason: "end_turn",
			usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
		});
		await third.done;
		setRowStatus(store, 4, 3);

		expect(third.writer.output.usage).toMatchObject({
			input: 11,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 16,
		});

		const fourth = begin(host, [
			...messages,
			first.writer.output,
			user("more"),
			second.writer.output,
			user("native"),
			third.writer.output,
			user("again"),
		]);
		const lastPrompt = await fake.prompts.next();
		seedRow(store, 5, { input: 2, output: 1, cachedWrite: 0, cachedRead: 0, thought: 0 });
		fake.text("Fourth answer.");
		lastPrompt.response.resolve({ stopReason: "end_turn" });
		await fourth.done;

		expect(fourth.writer.output.usage).toMatchObject({
			input: 2,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
		});
	});

	it("seeds an unknown cursor before the prompt and recovers the turn's new row", async () => {
		const dir = await tempDir("agy-usage-cursor-");
		const started = new Queue<FakeAgy>();
		const host = new AgyHost(dir, {
			startupTimeoutMs: 500,
			cancelTimeoutMs: 60,
			announcementTimeoutMs: 30,
			schedule,
			startTransport: async input => {
				const transport = new FakeAgy(input);
				started.push(transport);
				return transport;
			},
		});
		cleanup.push(() => host.dispose());

		const messages = [user("native")];
		const first = begin(host, messages);
		const fake = await started.next();
		const firstPrompt = await fake.prompts.next();
		const store = conversationStorePath(dir, fake.currentId);
		fake.text("Native answer.");
		firstPrompt.response.resolve({
			stopReason: "end_turn",
			usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
		});
		await first.done;

		await fs.mkdir(path.dirname(store), { recursive: true });
		const db = new Database(store);
		db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)");
		db.close();
		seedRow(store, 1, { input: 100, output: 20, cachedWrite: 0, cachedRead: 0, thought: 0 });

		const second = begin(host, [...messages, first.writer.output, user("recovered")]);
		const secondPrompt = await fake.prompts.next();
		seedRow(store, 2, { input: 7, output: 3, cachedWrite: 0, cachedRead: 0, thought: 0 });
		fake.text("Second answer.");
		secondPrompt.response.resolve({ stopReason: "end_turn" });
		await second.done;
		expect(second.writer.output.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });

		seedRow(store, 3, { input: 2, output: 1, cachedWrite: 0, cachedRead: 0, thought: 0 });
		const third = begin(host, [
			...messages,
			first.writer.output,
			user("recovered"),
			second.writer.output,
			user("again"),
		]);
		const thirdPrompt = await fake.prompts.next();
		fake.text("Third answer.");
		thirdPrompt.response.resolve({ stopReason: "end_turn" });
		await third.done;
		expect(third.writer.output.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
	});
});
