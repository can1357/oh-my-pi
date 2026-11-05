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

	it("classifies a TLS handshake failure as tls/handshake with proxy guidance", () => {
		const err = Object.assign(
			new Error("EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"),
			{ code: "EPROTO" },
		);

		expect(AIError.classifyNetworkCause(err)).toEqual({
			kind: "tls",
			tlsPhase: "handshake",
			code: "EPROTO",
			detail: undefined,
			host: undefined,
		});
		const message = AIError.networkFailureMessage(
			err,
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
		);
		expect(message).toBe(
			"TLS connection failed for daily-cloudcode-pa.googleapis.com during handshake. Check the proxy/VPN and whether the configured proxy speaks HTTP(S) rather than SOCKS.",
		);
		// A handshake failure must not be rewritten as a certificate verdict, and the
		// runtime's own advice (`pass verbose: true`) must not survive into the UI.
		expect(message).not.toMatch(/certificate/i);
		expect(message).not.toContain("verbose");
		expect(AIError.isProviderRetryableError(new Error(message as string))).toBe(true);
		expect(AIError.is(AIError.classify(new Error(message as string)), AIError.Flag.Transient)).toBe(true);
	});

	it("keeps a bare EPROTO transient without claiming a handshake or certificate verdict", () => {
		const err = Object.assign(new Error("EPROTO"), { code: "EPROTO" });

		// No TLS evidence: no invented network sentence, but still retryable.
		expect(AIError.classifyNetworkCause(err)).toBeUndefined();
		expect(AIError.networkFailureMessage(err, "https://daily-cloudcode-pa.googleapis.com/v1")).toBeUndefined();
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies a mid-stream reset as reset and names the host", () => {
		const errors = [
			Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }),
			Object.assign(new Error("premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
			new Error("read: connection reset by peer"),
			new Error("read tcp 127.0.0.1:9426->127.0.0.1:10808: use of closed network connection"),
			new Error("other side closed"),
			new Error(
				"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			),
		];

		for (const err of errors) {
			expect(AIError.classifyNetworkCause(err)?.kind).toBe("reset");
			const message = AIError.networkFailureMessage(err, "https://daily-cloudcode-pa.googleapis.com/v1internal");
			expect(message).toBe(
				"Connection to daily-cloudcode-pa.googleapis.com was reset by the network or proxy while the response was streaming. Check the proxy/VPN and retry.",
			);
			expect(message).not.toContain("verbose");
			expect(AIError.isProviderRetryableError(new Error(message as string))).toBe(true);
			expect(AIError.is(AIError.classify(new Error(message as string)), AIError.Flag.Transient)).toBe(true);
		}
	});

	it("descends into an AggregateError for a reset", () => {
		const inner = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		const wrapped = new TypeError("fetch failed", { cause: new AggregateError([inner]) });

		expect(AIError.classifyNetworkCause(wrapped)?.kind).toBe("reset");
	});

	it("formats a rejected stream as the network sentence instead of the request dump", async () => {
		const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		const message = await AIError.formatMessage(err, {
			provider: "google-antigravity",
			requestUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			rawRequestDump: {
				provider: "google-antigravity",
				api: "google-gemini-cli",
				model: "gemini-4-argon",
				method: "POST",
				body: { request: { contents: [{ role: "user", parts: [{ text: "x".repeat(2048) }] }] } },
			},
		});

		expect(message).toBe(
			"Connection to daily-cloudcode-pa.googleapis.com was reset by the network or proxy while the response was streaming. Check the proxy/VPN and retry.",
		);
		expect(message).not.toContain("raw-http-request");
	});

	it("keeps the original transport family when a provider wraps it as an incomplete stream", () => {
		const cause = Object.assign(
			new Error("EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"),
			{ code: "EPROTO" },
		);
		const wrapped = new AIError.ProviderResponseError("Cloud Code Assist stream closed before completion", {
			provider: "google-antigravity",
			kind: "incomplete-stream",
			cause,
		});

		expect(AIError.networkFailureMessage(wrapped, "https://daily-cloudcode-pa.googleapis.com")).toBe(
			"TLS connection failed for daily-cloudcode-pa.googleapis.com during handshake. Check the proxy/VPN and whether the configured proxy speaks HTTP(S) rather than SOCKS.",
		);
		const id = AIError.classify(wrapped);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("does not read a Google region refusal as a local network failure", () => {
		const body =
			'{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}';
		expect(AIError.classifyNetworkCause(new Error(body))).toBeUndefined();
		const err = new AIError.GeminiCliApiError(body, 400);
		expect(AIError.isProviderRetryableError(err)).toBe(false);
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
			reset: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
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
