import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: unknown[];
}

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One signed-thinking answer, streamed as the Messages API does; `readPath` ends it with a `read` call. */
function answer(turn: number, readPath?: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `plan ${turn}` } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `answer ${turn}` } },
		{ type: "content_block_stop", index: 1 },
		...(readPath
			? [
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: `toolu_${turn}`, name: "read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: readPath }) },
					},
					{ type: "content_block_stop", index: 2 },
				]
			: []),
		{
			type: "message_delta",
			delta: { stop_reason: readPath ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: "message_stop" },
	];
	return sse(events);
}

/** A successful on-demand compaction response carrying a signed summary block. */
function compactionAnswer(): Response {
	return sse([
		{
			type: "message_start",
			message: { id: "msg_compact", model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 0 } },
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: "summary", signature: "sig-compact" },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "compaction" }, usage: { input_tokens: 0, output_tokens: 0 } },
		{ type: "message_stop" },
	]);
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));
}

describe("AgentSession Anthropic native compaction", () => {
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;

	beforeEach(() => {
		// A provider proxy moves first-party requests off the Cowork transport
		// onto `globalThis.fetch`, where the spy below answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
	});

	const captured = () =>
		new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});

	/** A real session whose Messages API requests are recorded and answered by `respond`. */
	async function openSession(tempDir: TempDir, respond: (request: number) => Response) {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected bundled claude-opus-5-5");
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith("https://api.anthropic.com/v1/messages")) {
					throw new Error(`Unexpected request to ${String(input)}`);
				}
				requests.push(JSON.parse(String(init?.body)));
				return respond(requests.length);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.methodOrder": ["remote"], "compaction.keepRecentTokens": 1 }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		// A reminder change is what a date rollover or a cwd move produces; the cwd is the deterministic one.
		const moveCwd = () => vi.spyOn(sessionManager, "getCwd").mockReturnValue(tempDir.join("moved"));
		const close = async () => {
			await session.dispose();
			authStorage.close();
		};
		return { session, requests, moveCwd, close };
	}

	it("sends the summarized prefix with the live turn's system prompt, tools and message bytes", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-");
		// Two live turns answer; the compaction request is only captured.
		const { session, requests, close } = await openSession(tempDir, request =>
			request <= 2 ? answer(request) : captured(),
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const [, live, compaction] = requests;
		// The live turn carries the injected intent field and the first-turn
		// date/cwd reminder; the compaction request must carry them too.
		expect(JSON.stringify(live.tools)).toContain('"i"');
		expect(JSON.stringify(live.messages[0])).toContain("<system-reminder>");
		expect(compaction.system).toEqual(live.system);
		expect(compaction.tools).toEqual(live.tools);
		expect(compaction.messages.length).toBeGreaterThan(0);
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
	});

	it("keeps every summarized message when a reminder change mid tool loop inserted a control turn", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-control-");
		const file = tempDir.join("notes.txt");
		await Bun.write(file, "notes\n");
		const hooks: { moveCwd?: () => void } = {};
		const opened = await openSession(tempDir, request => {
			if (request === 2) {
				// The reminder changes while the tool runs: its continuation has no new user turn.
				hooks.moveCwd?.();
				return answer(request, file);
			}
			return request <= 4 ? answer(request) : captured();
		});
		hooks.moveCwd = opened.moveCwd;
		const { session, requests } = opened;
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await session.prompt("third question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await opened.close();
		}

		expect(requests).toHaveLength(5);
		const [, , , live, compaction] = requests;
		// The cut keeps only the last answer: the request is exactly what the
		// "third question" turn sent, the inserted control included.
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 4");
		expect(withoutCacheControl(compaction.messages)).toEqual(withoutCacheControl(live.messages));
	});

	it("replays a later compaction's prefix as sent, without disturbing the live reminder state", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-second-");
		const opened = await openSession(tempDir, request =>
			request === 3 ? compactionAnswer() : request === 6 ? captured() : answer(request),
		);
		const { session, requests } = opened;
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await session.compact();
			await session.prompt("third question");
			opened.moveCwd();
			await session.prompt("fourth question");
			await expect(session.compact()).rejects.toThrow("captured");
			await session.prompt("fifth question");
		} finally {
			await opened.close();
		}

		expect(requests).toHaveLength(7);
		const live = requests[4]!;
		const [compaction, next] = requests.slice(5);
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
		// The next live turn still sends every earlier message unchanged.
		expect(withoutCacheControl(next.messages.slice(0, live.messages.length))).toEqual(
			withoutCacheControl(live.messages),
		);
	});
});
