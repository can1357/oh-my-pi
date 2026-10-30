import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { type } from "@oh-my-pi/omptype";
import { clearCustomApis, getCustomApi, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AdmittedWorkKind, ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type {
	Api,
	AssistantMessage,
	Context,
	LiveSteerClaim,
	LiveSteering,
	Model,
	ProviderResponseMetadata,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";

/** The session whose work is running, as the extension loader keeps it. */
const sessionScope = new AsyncLocalStorage<object>();

interface SessionGate extends ProviderCallGate {
	retired: boolean;
	/** Whether the caller is running as this session's work. */
	readonly inside: boolean;
}

function sessionGate(): SessionGate {
	const session = {};
	const gate: SessionGate = {
		retired: false,
		run<R>(call: () => R, _kind?: AdmittedWorkKind): R {
			if (gate.retired) throw new Error("gate retired");
			return sessionScope.run(session, call);
		},
		get inside() {
			return sessionScope.getStore() === session;
		},
	};
	return gate;
}

const API = "input-copy-api";
const SOURCE = "input-copy-test";

afterEach(() => {
	clearCustomApis();
});

function modelFor(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		...createMockModel({ provider: "tests", baseUrl: "https://example.invalid" }).model,
		api: API,
		...overrides,
	};
}

function reply(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
}

type Author = (model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined) => unknown;

/** Registers `author` as a stream function — `gate`'s, or the host's own when no gate is given —
 *  calls it once through the registry, and waits for the stream to end. The author's work, awaited
 *  before the terminal, runs as its session's work. */
async function handOver(
	gate: SessionGate | undefined,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	author: Author,
): Promise<void> {
	registerCustomApi(
		API,
		(handedModel, handedContext, handedOptions) => {
			const output = new AssistantMessageEventStream();
			void (async () => {
				try {
					await author(handedModel, handedContext, handedOptions);
					output.push({ type: "done", reason: "stop", message: reply(handedModel) });
				} catch (error) {
					output.fail(error);
				}
			})();
			return output;
		},
		SOURCE,
		undefined,
		gate,
	);
	await getCustomApi(API)!.streamSimple(model, context, options).result();
}

describe("a session's stream function is handed copies of the host's inputs", () => {
	test("the model: a getter the author installs never reaches the host's model", async () => {
		const gate = sessionGate();
		const host = modelFor();
		const input = host.cost.input;
		const reads: boolean[] = [];
		let handed: Model<Api> | undefined;
		await handOver(gate, host, { messages: [] }, undefined, model => {
			handed = model;
			Object.defineProperty(model.cost, "input", {
				get() {
					reads.push(gate.inside);
					return 999;
				},
			});
		});
		gate.retired = true;

		expect(handed).not.toBe(host);
		expect(handed?.cost).not.toBe(host.cost);
		expect(host.cost.input).toBe(input);
		expect(reads).toEqual([]);
	});

	test("the context: messages and the tool schemas the host reuses stay the host's", async () => {
		const gate = sessionGate();
		const block: TextContent = { type: "text", text: "host-text" };
		const message: UserMessage = { role: "user", content: [block], timestamp: 0 };
		// The agent loop memoizes a tool's wire schema and sends the same object on every request.
		const parameters = { type: "object", properties: { path: { type: "string" } } };
		const context: Context = {
			systemPrompt: ["system"],
			messages: [message],
			tools: [{ name: "read", description: "Read a file", parameters }],
		};
		const before = JSON.stringify(context);
		let handed: Context | undefined;
		let handedJson: string | undefined;
		await handOver(gate, modelFor(), context, undefined, (_model, handedContext) => {
			handed = handedContext;
			handedJson = JSON.stringify(handedContext);
			const first = handedContext.messages[0];
			if (first?.role !== "user" || typeof first.content === "string") throw new Error("fixture: a user block");
			Object.defineProperty(first.content[0], "text", { enumerable: true, get: () => "substitute-value" });
			// The copy of `parameters` above, which is all this test hands over.
			const handedParameters = handedContext.tools![0]!.parameters as typeof parameters;
			handedParameters.properties.path = { type: "number" };
		});
		gate.retired = true;

		expect(handed).not.toBe(context);
		expect(handed?.messages[0]).not.toBe(message);
		expect(handedJson).toBe(before);
		expect(JSON.stringify(context)).toBe(before);
		expect(block.text).toBe("host-text");
		expect(parameters.properties.path.type).toBe("string");
	});

	test("the options' data: headers, metadata and provider options", async () => {
		const gate = sessionGate();
		const headers = { "x-host": "host-header" };
		const metadata = { user_id: "host-user" };
		const options: SimpleStreamOptions = { headers, metadata, providerOptions: { region: "host-region" } };
		let handed: SimpleStreamOptions | undefined;
		await handOver(gate, modelFor(), { messages: [] }, options, (_model, _context, handedOptions) => {
			handed = handedOptions;
			Object.defineProperty(handedOptions!.headers!, "x-host", {
				enumerable: true,
				get: () => "substitute-value",
			});
			handedOptions!.metadata!.user_id = "author-user";
		});
		gate.retired = true;

		expect(handed).not.toBe(options);
		expect(handed?.headers).not.toBe(headers);
		expect(handed?.providerOptions).toEqual({ region: "host-region" });
		expect(headers["x-host"]).toBe("host-header");
		expect(metadata.user_id).toBe("host-user");
	});

	test("an ArkType tool schema is handed as the JSON Schema the wire sends", async () => {
		const gate = sessionGate();
		const schema = type({ path: "string" });
		let handed: unknown;
		await handOver(
			gate,
			modelFor(),
			{ messages: [], tools: [{ name: "read", description: "Read", parameters: schema }] },
			undefined,
			(_model, context) => {
				handed = context.tools![0]!.parameters;
			},
		);

		expect(typeof handed).toBe("object");
		expect(handed).toEqual(arkToWireSchema(schema));
		expect(handed).not.toBe(arkToWireSchema(schema));
	});

	test("a function in the host's data is not handed, as JSON would not carry it", async () => {
		const gate = sessionGate();
		const format = () => "host";
		const details = { lines: 3, format };
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "body" }],
			details,
			isError: false,
			timestamp: 0,
		};
		let handed: unknown;
		await handOver(gate, modelFor(), { messages: [result] }, undefined, (_model, context) => {
			const message = context.messages[0];
			if (message?.role !== "toolResult") throw new Error("fixture: a tool result");
			handed = message.details;
		});

		expect(handed).toEqual({ lines: 3 });
		expect(details.format).toBe(format);
	});

	test("the host's bytes are cloned, not spelled out key by key", async () => {
		const gate = sessionGate();
		const bytes = new Uint8Array([1, 2, 3]);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "body" }],
			details: { bytes },
			isError: false,
			timestamp: 0,
		};
		let handed: unknown;
		await handOver(gate, modelFor(), { messages: [result] }, undefined, (_model, context) => {
			const message = context.messages[0];
			if (message?.role !== "toolResult") throw new Error("fixture: a tool result");
			const { details } = message;
			if (details && typeof details === "object" && "bytes" in details) handed = details.bytes;
		});

		expect(handed).toBeInstanceOf(Uint8Array);
		expect(handed).toEqual(new Uint8Array([1, 2, 3]));
		expect(handed).not.toBe(bytes);
	});

	test("what the host keeps for itself is not handed at all", async () => {
		const gate = sessionGate();
		// Fields `SimpleStreamOptions` declares and one it does not, as the agent loop passes them.
		const options = {
			providerSessionState: new Map(),
			execHandlers: { read: async () => ({ result: {} }) },
			cursorExecHandlers: { read: async () => ({ result: {} }) },
			cursorOnToolResult: () => undefined,
			anthropicSlowMode: { isActive: () => false, observe() {}, onFailure: () => undefined },
			// The agent loop spreads its whole configuration into the options.
			convertToLlm: () => [],
			temperature: 0.5,
		} as unknown as SimpleStreamOptions;
		let handed: SimpleStreamOptions | undefined;
		await handOver(gate, modelFor(), { messages: [] }, options, (_model, _context, handedOptions) => {
			handed = handedOptions;
		});

		expect(handed).toEqual({ temperature: 0.5 });
	});
});

describe("the host's callbacks, handed to a session's stream function", () => {
	test("onResponse: the host keeps a copy of what the author reports, read once inside its call", async () => {
		const gate = sessionGate();
		const seen: Array<{ response: ProviderResponseMetadata; model: Model<Api> | undefined }> = [];
		const onResponse: SimpleStreamOptions["onResponse"] = (response, model) => {
			seen.push({ response, model });
		};
		const reads: boolean[] = [];
		let handed: unknown;
		let authorHeaders: Record<string, string> | undefined;
		let authorModel: Model<Api> | undefined;
		await handOver(gate, modelFor(), { messages: [] }, { onResponse }, async (model, _context, options) => {
			handed = options!.onResponse;
			authorModel = model;
			authorHeaders = {};
			Object.defineProperty(authorHeaders, "x-limit", {
				enumerable: true,
				get() {
					reads.push(gate.inside);
					return gate.inside ? "author" : "substitute";
				},
			});
			await options!.onResponse!({ status: 200, headers: authorHeaders }, model);
		});
		gate.retired = true;

		expect(handed).not.toBe(onResponse);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.response.headers).not.toBe(authorHeaders);
		expect(seen[0]!.model).not.toBe(authorModel);
		expect(seen[0]!.response.headers["x-limit"]).toBe("author");
		expect(reads).toEqual([true]);
	});

	test("onPayload: the payload the author sends and the replacement the host answers are copies", async () => {
		const gate = sessionGate();
		const replacement = { messages: ["host"] };
		const received: unknown[] = [];
		const onPayload: SimpleStreamOptions["onPayload"] = async payload => {
			received.push(payload);
			return replacement;
		};
		let answered: unknown;
		await handOver(gate, modelFor(), { messages: [] }, { onPayload }, async (model, _context, options) => {
			const payload = { messages: ["author"] };
			// The copy of `replacement`, which is all the host's callback answers.
			const answer = (await options!.onPayload!(payload, model)) as typeof replacement;
			answered = answer;
			payload.messages.push("after the call");
			answer.messages.push("author");
		});

		expect(received).toEqual([{ messages: ["author"] }]);
		expect(answered).not.toBe(replacement);
		expect(replacement.messages).toEqual(["host"]);
	});

	test("a function where the host's callback takes data is refused, naming where", async () => {
		const gate = sessionGate();
		const seen: unknown[] = [];
		let refusal: unknown;
		await handOver(
			gate,
			modelFor(),
			{ messages: [] },
			{ onResponse: response => void seen.push(response) },
			async (_model, _context, options) => {
				try {
					await options!.onResponse!({ status: 200, headers: {}, metadata: { toJSON: () => ({}) } });
				} catch (error) {
					refusal = error;
				}
			},
		);

		expect(seen).toEqual([]);
		expect(String(refusal)).toContain("options.onResponse.arguments[0].metadata.toJSON is a function");
	});

	test("fetch: the host acts on the request the author named, read once", async () => {
		const gate = sessionGate();
		const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok");
		};
		let reads = 0;
		let body: string | undefined;
		const headers = { "x-author": "first" };
		await handOver(gate, modelFor(), { messages: [] }, { fetch }, async (_model, _context, options) => {
			const target = {
				toString() {
					reads++;
					return reads === 1 ? "https://checked.invalid/" : "https://other.invalid/";
				},
			};
			const response = await options!.fetch!(target as unknown as string, { method: "POST", headers, body: "x" });
			body = await response.text();
			headers["x-author"] = "changed";
		});

		expect(body).toBe("ok");
		expect(reads).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input).toBe("https://checked.invalid/");
		expect(calls[0]!.init?.headers).not.toBe(headers);
		expect(calls[0]!.init?.headers).toEqual({ "x-author": "first" });
		expect(calls[0]!.init?.method).toBe("POST");
	});

	test("fetch: a Request the author passes reaches the host as a clone", async () => {
		const gate = sessionGate();
		const inputs: unknown[] = [];
		const fetch = async (input: string | URL | Request) => {
			inputs.push(input);
			return new Response("ok");
		};
		const request = new Request("https://checked.invalid/path", { method: "PUT", headers: { "x-author": "1" } });
		await handOver(gate, modelFor(), { messages: [] }, { fetch }, async (_model, _context, options) => {
			await options!.fetch!(request);
		});

		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toBeInstanceOf(Request);
		expect(inputs[0]).not.toBe(request);
		const received = inputs[0] as Request;
		expect([received.url, received.method, received.headers.get("x-author")]).toEqual([
			"https://checked.invalid/path",
			"PUT",
			"1",
		]);
	});

	test("a signal the author passes the host is followed by one of the host's; anything else is refused", async () => {
		const gate = sessionGate();
		const signals: Array<AbortSignal | undefined> = [];
		const providerRetryWait = async (_delayMs: number, signal?: AbortSignal) => {
			signals.push(signal);
		};
		const controller = new AbortController();
		let refusal: unknown;
		await handOver(gate, modelFor(), { messages: [] }, { providerRetryWait }, async (_model, _context, options) => {
			await options!.providerRetryWait!(10, controller.signal);
			try {
				await options!.providerRetryWait!(10, { aborted: false } as AbortSignal);
			} catch (error) {
				refusal = error;
			}
		});
		controller.abort("author stopped");

		expect(signals).toHaveLength(1);
		expect(signals[0]).not.toBe(controller.signal);
		expect(signals[0]?.reason).toBe("author stopped");
		expect(String(refusal)).toContain("options.providerRetryWait.arguments[1] is not an AbortSignal");
	});

	test("liveSteering: a claim's messages are copies, and accepting it reaches the host's claim", async () => {
		const gate = sessionGate();
		const messages: UserMessage[] = [{ role: "user", content: "steer", timestamp: 1 }];
		const receivers: unknown[] = [];
		const claim: LiveSteerClaim = {
			messages,
			accept() {
				receivers.push(this);
			},
			reject() {},
		};
		const channel = {
			accepted: [] as unknown[],
			wait: async () => {},
			claim: async () => claim,
		} satisfies LiveSteering & { accepted: unknown[] };
		let handed: LiveSteering | undefined;
		let got: LiveSteerClaim | undefined;
		await handOver(
			gate,
			modelFor(),
			{ messages: [] },
			{ liveSteering: channel },
			async (_model, _context, options) => {
				handed = options!.liveSteering;
				got = await handed!.claim(new AbortController().signal);
				got!.messages[0]!.content = "changed";
				got!.accept();
			},
		);

		expect(handed).not.toBe(channel);
		expect(handed).not.toHaveProperty("accepted");
		expect(got).not.toBe(claim);
		expect(messages[0]!.content).toBe("steer");
		expect(receivers).toHaveLength(1);
		expect(receivers[0]).toBe(claim);
	});

	test("model.resolveHeaders: the host's resolver gets its own signal, and the author a copy of its answer", async () => {
		const gate = sessionGate();
		const resolved = { "x-resolved": "host" };
		const signals: Array<AbortSignal | undefined> = [];
		const resolveHeaders = async (signal?: AbortSignal) => {
			signals.push(signal);
			return resolved;
		};
		const controller = new AbortController();
		let answered: Record<string, string> | undefined;
		await handOver(gate, modelFor({ resolveHeaders }), { messages: [] }, undefined, async model => {
			answered = await model.resolveHeaders!(controller.signal);
		});
		controller.abort("author gave up");

		expect(answered).toEqual(resolved);
		expect(answered).not.toBe(resolved);
		expect(signals[0]).not.toBe(controller.signal);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[0]?.reason).toBe("author gave up");
	});

	test("an API key resolver: the context is copied, its error kept as it is", async () => {
		const gate = sessionGate();
		const contexts: ApiKeyResolveContext[] = [];
		const answer = { apiKey: "host-key", credentialId: 7 };
		const apiKey: ApiKeyResolver = ctx => {
			contexts.push(ctx);
			return answer;
		};
		const error = new Error("401");
		const ctx: ApiKeyResolveContext = { lastChance: true, error, previousKey: "old" };
		let answered: unknown;
		await handOver(gate, modelFor(), { messages: [] }, { apiKey }, async (_model, _context, options) => {
			const resolve = options!.apiKey;
			if (typeof resolve !== "function") throw new Error("fixture: a resolver");
			answered = await resolve(ctx);
		});

		expect(contexts).toHaveLength(1);
		expect(contexts[0]).not.toBe(ctx);
		expect(contexts[0]).toEqual({ lastChance: true, error, previousKey: "old" });
		expect(contexts[0]!.error).toBe(error);
		expect(answered).toEqual(answer);
		expect(answered).not.toBe(answer);
	});
});

describe("the host's own stream function", () => {
	test("receives the host's model, context, options and callbacks as they are", async () => {
		const model = modelFor();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const onResponse: SimpleStreamOptions["onResponse"] = () => {};
		const options: SimpleStreamOptions = { headers: { "x-host": "host" }, onResponse };
		const handed: unknown[] = [];
		await handOver(undefined, model, context, options, (handedModel, handedContext, handedOptions) => {
			handed.push(handedModel, handedContext, handedOptions, handedOptions?.onResponse);
		});

		expect(handed[0]).toBe(model);
		expect(handed[1]).toBe(context);
		expect(handed[2]).toBe(options);
		expect(handed[3]).toBe(onResponse);
	});
});
