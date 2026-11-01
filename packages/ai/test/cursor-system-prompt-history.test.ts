// Regression (#17059): Cursor's server builds its `<rules>` entry from
// `requestContext.rules` only while `rootPromptMessagesJson` has no history. On a
// history-bearing root it keeps the client's history verbatim, so a root without
// its own `<rules>` entry lost omp's system prompt from the second turn on.
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"cursor-agent"> = buildModel({
	id: "claude-haiku-5-5",
	name: "Claude Haiku 5.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const systemPrompt = ["omp base prompt", "The project codeword is PERIWINKLE-4821."];

const firstUser: Message = { role: "user", content: "Reply with just: hi", timestamp: 1 };
const firstAnswer: AssistantMessage = {
	role: "assistant",
	api: "cursor-agent",
	provider: "cursor",
	model: model.id,
	content: [{ type: "text", text: "hi" }],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
};
const secondUser: Message = { role: "user", content: "What is the project codeword?", timestamp: 3 };

async function rootEntries(context: Context): Promise<{ role: string; content: unknown }[]> {
	const blobStore = new Map<string, Uint8Array>();
	const { conversationState } = await buildGrpcRequest(model, context, undefined, {
		conversationId: `history-${crypto.randomUUID()}`,
		blobStore,
	});
	return conversationState.rootPromptMessagesJson.map(id => {
		const bytes = blobStore.get(Buffer.from(id).toString("hex"));
		const { role, content } = JSON.parse(new TextDecoder().decode(bytes));
		return { role, content };
	});
}

describe("cursor system prompt on history-bearing roots", () => {
	it("carries the system prompt as a <rules> entry after the system entries", async () => {
		const root = await rootEntries({ systemPrompt, messages: [firstUser, firstAnswer, secondUser] });

		expect(root).toEqual([
			{ role: "system", content: "omp base prompt" },
			{ role: "system", content: "The project codeword is PERIWINKLE-4821." },
			{ role: "user", content: "<rules>\nomp base prompt\n\nThe project codeword is PERIWINKLE-4821.\n</rules>" },
			{ role: "user", content: [{ type: "text", text: "Reply with just: hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		]);
	});

	it("leaves a history-less root to the server's own <rules> entry", async () => {
		const root = await rootEntries({ systemPrompt, messages: [firstUser] });

		expect(root).toEqual([
			{ role: "system", content: "omp base prompt" },
			{ role: "system", content: "The project codeword is PERIWINKLE-4821." },
		]);
	});
});
