import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface MessagesRequest {
	messages: Array<{ role: string; content: unknown }>;
}

const model = buildModel({
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://gateway.local",
	reasoning: false,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

/** One text answer, streamed as the Messages API does. */
function answer(turn: number): Response {
	const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events = [
		{ type: "message_start", message: { id: `msg_${turn}`, model: model.id, usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Indexes of the messages that carry a cache breakpoint, counted back from the newest message. */
function breakpointsFromNewest(request: MessagesRequest): number[] {
	return request.messages.flatMap((message, index) =>
		Array.isArray(message.content) &&
		message.content.some(block => typeof block === "object" && block !== null && "cache_control" in block)
			? [request.messages.length - 1 - index]
			: [],
	);
}

const FIXED_NOTE = "Read the shared notes before planning.";

/** Inserts the same note after the first message of the context on every request. */
const fixedNoteAfterFirst: ExtensionFactory = pi => {
	pi.on("context", event => {
		const note: AgentMessage = { role: "user", content: [{ type: "text", text: FIXED_NOTE }], timestamp: 0 };
		return { messages: [...event.messages.slice(0, 1), note, ...event.messages.slice(1)] };
	});
};

describe("a context hook message that repeats on every request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One session, with `extension` when given: sends each prompt and returns the Messages API requests. */
	async function run(tempDir: TempDir, extension: ExtensionFactory | undefined): Promise<MessagesRequest[]> {
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith("http://gateway.local/")) throw new Error(`Unexpected request to ${input}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			toolNames: [],
			extensions: extension ? [extension] : [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			for (const prompt of ["first", "second", "third"]) await session.prompt(prompt);
		} finally {
			await session.dispose();
			authStorage.close();
			vi.restoreAllMocks();
		}
		return requests;
	}

	it("is cached as history from its second request, so the breakpoints sit where they sit without the hook", async () => {
		using hookDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const hooked = await run(hookDir, fixedNoteAfterFirst);
		using plainDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const plain = await run(plainDir, undefined);
		expect(hooked).toHaveLength(3);
		expect(plain).toHaveLength(3);
		for (const request of hooked) expect(JSON.stringify(request.messages[1]?.content)).toContain(FIXED_NOTE);
		// The first request has no earlier one: the note is per-call, and the message before it takes a breakpoint.
		expect(breakpointsFromNewest(hooked[0]!)).toContain(hooked[0]!.messages.length - 1);
		for (let request = 1; request < hooked.length; request++) {
			// Two empty lists would compare equal and measure nothing, so read the session without the hook first.
			expect(breakpointsFromNewest(plain[request]!)).not.toEqual([]);
			// The note repeats the bytes the answered request before sent at its place: no breakpoint before or on it,
			// and the rolling ones on the newest messages, as without the hook.
			expect(breakpointsFromNewest(hooked[request]!)).toEqual(breakpointsFromNewest(plain[request]!));
		}
	}, 30_000);
});
