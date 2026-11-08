import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { postOpenAIStream } from "@oh-my-pi/pi-ai/utils/openai-http";

const OFFLINE_ANTHROPIC =
	"No internet connection: couldn't reach api.anthropic.com (getaddrinfo ETIMEOUT). Check your network or proxy and try again.";

function bunDnsFailure(host = "api.anthropic.com"): TypeError {
	return Object.assign(new TypeError(`getaddrinfo ETIMEOUT ${host}`), { code: "ETIMEOUT" });
}

describe("classifyNetworkCause", () => {
	it("reads a Bun DNS rejection off the error itself", () => {
		const err = bunDnsFailure();
		expect(AIError.classifyNetworkCause(err)).toEqual({
			kind: "offline",
			code: "ETIMEOUT",
			detail: "getaddrinfo ETIMEOUT",
			host: "api.anthropic.com",
		});
		// Host parsed from the error text when no request URL is supplied.
		expect(new AIError.AnthropicConnectionError(err).message).toBe(OFFLINE_ANTHROPIC);
	});

	it("walks the cause chain for a Bun socket-open failure that names no host", () => {
		const inner = Object.assign(new Error("Was there a typo in the url or port?"), {
			code: "FailedToOpenSocket",
		});
		const outer = new TypeError("fetch failed", { cause: inner });

		expect(AIError.classifyNetworkCause(outer)).toEqual({
			kind: "unreachable",
			code: "FailedToOpenSocket",
			detail: "FailedToOpenSocket",
			host: undefined,
		});
		// The request URL supplies the host the error text lacks.
		expect(new AIError.AnthropicConnectionError(outer, "https://api.anthropic.com/v1/messages").message).toBe(
			"Couldn't reach api.anthropic.com (FailedToOpenSocket). Check the URL, your network, or proxy.",
		);
	});

	it("descends into AggregateError branches for a Node ECONNREFUSED", () => {
		const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
		const err = new TypeError("fetch failed", { cause: new AggregateError([errno]) });

		expect(AIError.classifyNetworkCause(err)?.kind).toBe("refused");
		expect(AIError.networkFailureMessage(err, "http://127.0.0.1:443/v1/chat/completions")).toBe(
			"Couldn't connect to 127.0.0.1:443 (connection refused). Check that the server is running and reachable.",
		);
	});

	it("classifies Bun's connection-refused wording", () => {
		const err = Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
			code: "ConnectionRefused",
		});

		expect(AIError.classifyNetworkCause(err)?.kind).toBe("refused");
	});

	it("classifies a certificate verification failure as tls, not a dead network", () => {
		const err = Object.assign(new Error("unable to verify the first certificate"), {
			code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		});

		expect(AIError.classifyNetworkCause(err)?.kind).toBe("tls");
		expect(AIError.networkFailureMessage(err, "https://api.openai.com/v1/responses")).toBe(
			"TLS certificate verification failed for api.openai.com (UNABLE_TO_VERIFY_LEAF_SIGNATURE). If you're behind a TLS-inspecting proxy, its CA may need to be trusted.",
		);
	});

	it("classifies a flattened message-only errno (fetchWithRetry drops the cause)", () => {
		expect(AIError.classifyNetworkCause(new Error("Network error: getaddrinfo ENOTFOUND api.openai.com"))).toEqual({
			kind: "unreachable",
			code: undefined,
			detail: "getaddrinfo ENOTFOUND",
			host: "api.openai.com",
		});
	});

	it("keeps NXDOMAIN on a custom host neutral instead of claiming the network is down", () => {
		const bun = Object.assign(new TypeError("getaddrinfo ENOTFOUND my-llm.lan"), { code: "ENOTFOUND" });
		const node = new TypeError("fetch failed", {
			cause: Object.assign(new Error("getaddrinfo ENOTFOUND my-llm.lan"), {
				code: "ENOTFOUND",
				syscall: "getaddrinfo",
				hostname: "my-llm.lan",
			}),
		});

		for (const err of [bun, node]) {
			expect(AIError.classifyNetworkCause(err)).toEqual({
				kind: "unreachable",
				code: "ENOTFOUND",
				detail: "getaddrinfo ENOTFOUND",
				host: "my-llm.lan",
			});
			const message = AIError.networkFailureMessage(err, "http://my-llm.lan:11434/v1/chat/completions");
			expect(message).toBe(
				"Couldn't reach my-llm.lan:11434 (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.",
			);
			expect(message).not.toContain("No internet connection");
			// Neutral wording must stay retryable (flags.ts keys on the errno in the detail).
			expect(AIError.isProviderRetryableError(new Error(message as string))).toBe(true);
		}
	});

	it("leaves non-network errors alone", () => {
		for (const err of [new Error("Overloaded"), new TypeError("fetch failed")]) {
			expect(AIError.classifyNetworkCause(err)).toBeUndefined();
			expect(AIError.networkFailureError(err, "https://api.openai.com/v1/responses")).toBe(err);
			expect(new AIError.AnthropicConnectionError(err).message).toBe("Connection error.");
		}
	});

	it("terminates on a cyclic cause chain", () => {
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		(a as { cause?: unknown }).cause = b;

		expect(AIError.classifyNetworkCause(a)).toBeUndefined();
	});
});

describe("network failure classification flags", () => {
	it("keeps every network-failure sentence transient and retryable", () => {
		const id = AIError.classify(new AIError.AnthropicConnectionError(bunDnsFailure()));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);

		const causes: Record<AIError.NetworkFailureKind, unknown> = {
			offline: new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect ENETUNREACH 1.2.3.4:443"), { code: "ENETUNREACH" }),
			}),
			// Detail the errno alternatives do not list: coverage must come from the sentence.
			unreachable: new Error("getaddrinfo EAI_NONAME api.anthropic.com"),
			refused: new TypeError("fetch failed", {
				cause: new AggregateError([
					Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" }),
				]),
			}),
			tls: Object.assign(new Error("unable to verify the first certificate"), {
				code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			}),
		};

		for (const [kind, cause] of Object.entries(causes) as [AIError.NetworkFailureKind, unknown][]) {
			const message = AIError.networkFailureMessage(cause, "https://api.anthropic.com/v1/messages");
			expect(AIError.classifyNetworkCause(cause)?.kind).toBe(kind);
			if (message === undefined) throw new Error(`Expected a ${kind} network-failure sentence`);
			expect(AIError.isProviderRetryableError(new Error(message))).toBe(true);
			expect(AIError.is(AIError.classify(new Error(message)), AIError.Flag.Transient)).toBe(true);
		}

		// Flattened runtime text (no sentence) must stay retryable too.
		for (const message of [OFFLINE_ANTHROPIC, "getaddrinfo ENOTFOUND api.openai.com", "FailedToOpenSocket"]) {
			expect(AIError.isProviderRetryableError(new Error(message))).toBe(true);
			expect(AIError.is(AIError.classify(new Error(message)), AIError.Flag.Transient)).toBe(true);
		}
	});
});

describe("postOpenAIStream transport rejection", () => {
	it("names the host and cause instead of the runtime's bare DNS text", async () => {
		const networkError = bunDnsFailure("api.openai.com");
		const fetchImpl: FetchImpl = async () => {
			throw networkError;
		};

		const error = await postOpenAIStream({
			url: "https://api.openai.com/v1/chat/completions",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			fetch: fetchImpl,
			maxAttempts: 1,
		}).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"No internet connection: couldn't reach api.openai.com (getaddrinfo ETIMEOUT). Check your network or proxy and try again.",
		);
		expect((error as Error).cause).toBe(networkError);
	});

	it("names a refused connection through fetchWithRetry's undici wrap", async () => {
		// undici nests the errno under `fetch failed`, and fetchWithRetry flattens
		// the text to `Network error: ` (the AggregateError has no message), so the
		// errno survives only on the wrapped error's `cause`.
		const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
		const fetchFailed = new TypeError("fetch failed", { cause: new AggregateError([errno]) });
		const fetchImpl: FetchImpl = async () => {
			throw fetchFailed;
		};

		const error = await postOpenAIStream({
			url: "http://127.0.0.1:8080/v1/chat/completions",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			fetch: fetchImpl,
			maxAttempts: 1,
		}).then(
			() => undefined,
			(err: unknown) => err,
		);

		if (!(error instanceof Error)) throw new Error(`Expected a rejected Error, got ${String(error)}`);
		expect(error.message).toBe(
			"Couldn't connect to 127.0.0.1:8080 (connection refused). Check that the server is running and reachable.",
		);
		expect(AIError.isProviderRetryableError(error)).toBe(true);
	});
});
