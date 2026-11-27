/**
 * After a switch to Claude, Antigravity CLI starts a new conversation from the transcript with the
 * other model's thinking left out, either from the whole transcript or from a forked checkpoint.
 * The earlier model's turn stays in the prefix of every later step, but its thinking never reached
 * the new conversation, so later Claude steps resume it.
 *
 * `Queue` and the fake transport are trimmed from the fake in the removed
 * `antigravity-cli-host.test.ts` (can1357/oh-my-pi 9dcf80fe); only what these cases drive is kept.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { conversationStorePath } from "@oh-my-pi/pi-ai/providers/antigravity-cli/conversation-store";
import {
	type AgyConnection,
	AgyHost,
	type AgyTransport,
	type AgyTransportOptions,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/host";
import type { McpToolOutput } from "@oh-my-pi/pi-ai/providers/antigravity-cli/mcp-bridge";
import { holdsDroppedThinking } from "@oh-my-pi/pi-ai/providers/antigravity-cli/reconcile";
import { StepWriter } from "@oh-my-pi/pi-ai/providers/antigravity-cli/step-writer";
import type { AssistantMessage, Message, Model, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ContentBlock, PromptRequest, PromptResponse, SessionConfigOption } from "@oh-my-pi/pi-utils/acp";

function agyModel(id: string): Model<"antigravity-acp"> {
	return buildModel({
		api: "antigravity-acp",
		provider: "antigravity-cli",
		id,
		name: id,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	});
}

const gemini = agyModel("gemini-3.8-flash");
const claude = agyModel("claude-opus-4-6");
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

interface FakePrompt {
	request: PromptRequest;
	response: PromiseWithResolvers<PromptResponse>;
}

/** One agy process: it creates conversations, takes prompts, and acknowledges a cancel by ending the open prompt. */
class FakeAgy implements AgyTransport {
	readonly prompts = new Queue<FakePrompt>();
	readonly promptHistory: FakePrompt[] = [];
	readonly created: string[] = [];
	readonly loads: string[] = [];
	readonly exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly connection: AgyConnection;
	readonly options: AgyTransportOptions;
	readonly #abort = new AbortController();
	readonly #pending = new Set<FakePrompt>();
	currentId = "";

	constructor(options: AgyTransportOptions) {
		this.options = options;
		const configOptions: SessionConfigOption[] = [
			{
				id: "model",
				name: "Model",
				type: "select",
				currentValue: gemini.id,
				options: [gemini.id, claude.id].map(value => ({ value, name: value })),
			},
		];
		this.connection = {
			signal: this.#abort.signal,
			initialize: async () => ({ protocolVersion: 1 }),
			newSession: async () => {
				this.currentId = crypto.randomUUID();
				this.created.push(this.currentId);
				return { sessionId: this.currentId, configOptions };
			},
			loadSession: async params => {
				this.currentId = params.sessionId;
				this.loads.push(params.sessionId);
				return { configOptions };
			},
			closeSession: async () => ({}),
			setSessionConfigOption: async () => ({ configOptions }),
			prompt: request => {
				for (const old of this.#pending) old.response.resolve({ stopReason: "end_turn" });
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
				for (const prompt of this.#pending) prompt.response.resolve({ stopReason: "cancelled" });
			},
		};
	}

	text(text: string): void {
		this.options.onUpdate({
			sessionId: this.currentId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		});
	}
	thought(text: string): void {
		this.options.onUpdate({
			sessionId: this.currentId,
			update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
		});
	}
	call(): Promise<McpToolOutput> {
		this.options.onUpdate({
			sessionId: this.currentId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: crypto.randomUUID(),
				title: "mcp_ide-tools_read",
				status: "in_progress",
			},
		});
		return this.options.onCall("read", { path: "a.txt" }, this.currentId);
	}
	close(): void {
		this.#abort.abort();
		for (const prompt of this.#pending) prompt.response.reject(new Error("connection closed"));
		this.exit.resolve(0);
	}
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
	const dir = await mkdtemp(path.join(tmpdir(), "agy-seed-test-"));
	const started = new Queue<FakeAgy>();
	const host = new AgyHost(dir, {
		startupTimeoutMs: 500,
		cancelTimeoutMs: 60,
		announcementTimeoutMs: 30,
		schedule: () => ({ cancel: () => {} }),
		startTransport: async input => {
			const fake = new FakeAgy(input);
			started.push(fake);
			return fake;
		},
	});
	cleanup.push(async () => {
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	return { host, started, dir };
}

/** The rows agy writes as it works, which a later step forks a conversation from. */
async function storeRows(dir: string, id: string): Promise<void> {
	const store = conversationStorePath(dir, id);
	await mkdir(path.dirname(store), { recursive: true });
	const db = new Database(store);
	cleanup.push(async () => {
		db.close();
	});
	db.run("PRAGMA journal_mode = WAL");
	for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"]) {
		db.run(`CREATE TABLE ${table} (idx INTEGER PRIMARY KEY, body TEXT)`);
		db.run(`INSERT INTO ${table} VALUES (0, 'first turn')`);
	}
	db.run("CREATE TABLE trajectory_meta (cascade_id TEXT, trajectory_id TEXT)");
	db.run("INSERT INTO trajectory_meta VALUES (?, ?)", [id, crypto.randomUUID()]);
}

function step(host: AgyHost, model: Model, messages: Message[]) {
	const writer = new StepWriter(model, new AssistantMessageEventStream());
	const done = host.step(model, { messages, tools }, {}, writer);
	done.catch(() => undefined);
	return { writer, done };
}

function result(message: AssistantMessage): ToolResultMessage {
	const call = message.content.find(block => block.type === "toolCall");
	if (!call || call.type !== "toolCall") throw new Error("Expected a tool call");
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "actual file body" }],
		isError: false,
		timestamp: 0,
	};
}

/** A turn of the other agy model, carrying the thinking a Claude target drops. */
const geminiTurn: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "GEMINI_THINKING" },
		{ type: "text", text: "GEMINI_ANSWER" },
	],
	api: "antigravity-acp",
	provider: "antigravity-cli",
	model: gemini.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

const textOf = (blocks: ContentBlock[]) =>
	blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

describe("Antigravity CLI after a switch to Claude", () => {
	it("keeps the filtered Claude conversation on later steps and settles its parked tool call natively", async () => {
		const { host, started } = await fixture();
		const first = step(host, gemini, [user("Start.")]);
		const fake = await started.next();
		const firstPrompt = await fake.prompts.next();
		fake.thought("NATIVE_FOREIGN_THINKING");
		fake.text("FIRST_ANSWER");
		firstPrompt.response.resolve({ stopReason: "end_turn" });
		await first.done;

		// The switch starts a conversation from the filtered transcript, where Claude parks at a tool call.
		const seeded = [user("Start."), first.writer.output, user("read a.txt")];
		const claudeStep = step(host, claude, seeded);
		const claudePrompt = await fake.prompts.next();
		expect(textOf(claudePrompt.request.prompt)).not.toContain("NATIVE_FOREIGN_THINKING");
		const conversations = fake.created.length;
		fake.text("Reading now.");
		const output = fake.call();
		await claudeStep.done;
		expect(claudeStep.writer.output.stopReason).toBe("toolUse");

		// The earlier model's turn is still in the prefix, but its thinking never reached this conversation.
		const next = step(host, claude, [...seeded, claudeStep.writer.output, result(claudeStep.writer.output)]);
		expect(await output).toEqual({ content: [{ type: "text", text: "actual file body" }], isError: false });
		fake.text("Finished.");
		claudePrompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
		expect(fake.created.length).toBe(conversations);
		expect(fake.promptHistory).toHaveLength(2);
		expect(next.writer.output.content).toEqual([{ type: "text", text: "Finished." }]);
	});

	it("keeps a Claude conversation forked from a checkpoint and settles its parked tool call natively", async () => {
		const { host, started, dir } = await fixture();
		const first = step(host, gemini, [user("Start.")]);
		const fake = await started.next();
		const firstPrompt = await fake.prompts.next();
		await storeRows(dir, fake.currentId);
		fake.text("FIRST_ANSWER");
		firstPrompt.response.resolve({ stopReason: "end_turn" });
		await first.done;
		const payload = first.writer.output.providerPayload;
		// Premise: this turn ends at a checkpoint a later step can fork.
		expect(payload?.type === "antigravityCli" && payload.checkpoint !== undefined).toBe(true);

		// Another model's turn follows the checkpoint, so the switch forks it and replays the rest filtered.
		const seeded = [user("Start."), first.writer.output, geminiTurn, user("read a.txt")];
		const claudeStep = step(host, claude, seeded);
		const claudePrompt = await fake.prompts.next();
		expect(textOf(claudePrompt.request.prompt)).not.toContain("GEMINI_THINKING");
		expect(textOf(claudePrompt.request.prompt)).toContain("GEMINI_ANSWER");
		expect(fake.loads).toHaveLength(1);
		const conversations = fake.created.length;
		fake.text("Reading now.");
		const output = fake.call();
		await claudeStep.done;
		expect(claudeStep.writer.output.stopReason).toBe("toolUse");

		// The replayed turn is still in the prefix, but the fork never received its thinking.
		const next = step(host, claude, [...seeded, claudeStep.writer.output, result(claudeStep.writer.output)]);
		expect(await output).toEqual({ content: [{ type: "text", text: "actual file body" }], isError: false });
		fake.text("Finished.");
		claudePrompt.response.resolve({ stopReason: "end_turn" });
		await next.done;
		expect(fake.created.length).toBe(conversations);
		expect(fake.loads).toHaveLength(1);
		expect(fake.promptHistory).toHaveLength(2);
		expect(next.writer.output.content).toEqual([{ type: "text", text: "Finished." }]);
	});

	it("counts an agy turn's thinking as held only where its conversation holds it", () => {
		const prefix = [user("Start."), geminiTurn, user("Continue.")];

		// Replayed into a conversation seeded for Claude: the seed left the thinking out.
		expect(holdsDroppedThinking(prefix, { target: claude, from: 0, to: prefix.length }, claude)).toBe(false);
		// Replayed for Gemini, which kept it.
		expect(holdsDroppedThinking(prefix, { target: gemini, from: 0, to: prefix.length }, claude)).toBe(true);
		// Written by agy in the conversation itself, after its seed.
		expect(holdsDroppedThinking(prefix, { target: claude, from: 0, to: 1 }, claude)).toBe(true);
		// Carried by the checkpoint a fork started from, before the range the fork replayed.
		expect(holdsDroppedThinking(prefix, { target: claude, from: 2, to: prefix.length }, claude)).toBe(true);
		// Replayed into a fork after its checkpoint.
		expect(holdsDroppedThinking(prefix, { target: claude, from: 1, to: prefix.length }, claude)).toBe(false);
		// Forked from a checkpoint, whose provenance is unknown.
		expect(holdsDroppedThinking(prefix, undefined, claude)).toBe(true);
	});
});
