import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isLocalTransportFailure } from "@oh-my-pi/pi-coding-agent/session/retry-transport-failure";

// Classified error ids as `AIError.classifyMessage` produces them. The reporter
// of issue #9165 attached 135168 (Class|Transient) and 397312
// (Class|Transient|Timeout) to their session log.
const TRANSIENT = AIError.create(AIError.Flag.Transient);
const TRANSIENT_TIMEOUT = AIError.create(AIError.Flag.Transient, AIError.Flag.Timeout);
const USAGE_LIMIT = AIError.create(AIError.Flag.Transient, AIError.Flag.UsageLimit);
const OVERFLOW = AIError.create(AIError.Flag.ContextOverflow);

// Bun's exact wording for a dropped socket, and what the reporter saw while
// switching proxies mid-turn. Nothing on the far side ever answered.
const SOCKET_CLOSED = "The socket connection was closed unexpectedly";
const REFUSED = "fetch failed: connect ECONNREFUSED 127.0.0.1:8787";
const DNS_FAILURE = "fetch failed: getaddrinfo EAI_AGAIN api.anthropic.com";
const NO_FIRST_EVENT = "Timed out waiting for the first event";
const HANG_UP = "socket hang up";

// A provider that answered is reachable, so the fault is route-specific.
const OVERLOADED = "overloaded_error";
const RATE_LIMITED = "rate_limit_error";
const NOT_TRANSPORT = "thought-only response without final output";

describe("isLocalTransportFailure", () => {
	it("pins the reporter's error ids to the documented flag combinations", () => {
		expect(TRANSIENT).toBe(135168);
		expect(TRANSIENT_TIMEOUT).toBe(397312);
	});

	describe("local transport faults keep the backoff", () => {
		it("treats an unexpectedly closed socket as local", () => {
			expect(isLocalTransportFailure(TRANSIENT, SOCKET_CLOSED, undefined)).toBe(true);
		});

		it("treats a refused connection as local", () => {
			expect(isLocalTransportFailure(TRANSIENT, REFUSED, undefined)).toBe(true);
		});

		it("treats a DNS failure as local", () => {
			expect(isLocalTransportFailure(TRANSIENT, DNS_FAILURE, undefined)).toBe(true);
		});

		it("treats a socket hang up as local", () => {
			expect(isLocalTransportFailure(TRANSIENT, HANG_UP, undefined)).toBe(true);
		});

		it("treats a stream with no first event as local", () => {
			expect(isLocalTransportFailure(TRANSIENT_TIMEOUT, NO_FIRST_EVENT, undefined)).toBe(true);
		});
	});

	describe("route-specific rejections keep the instant model switch", () => {
		it("rejects a fault that carries an HTTP status", () => {
			expect(isLocalTransportFailure(TRANSIENT, "connection error", 503)).toBe(false);
		});

		it("rejects provider wording that is not a transport fault", () => {
			expect(isLocalTransportFailure(TRANSIENT, OVERLOADED, undefined)).toBe(false);
			expect(isLocalTransportFailure(TRANSIENT, RATE_LIMITED, undefined)).toBe(false);
		});

		it("rejects an account-scoped usage cap", () => {
			expect(isLocalTransportFailure(USAGE_LIMIT, HANG_UP, undefined)).toBe(false);
		});
	});

	describe("non-retryable and malformed inputs", () => {
		it("rejects an error that is neither transient nor a timeout", () => {
			expect(isLocalTransportFailure(OVERFLOW, "fetch failed", undefined)).toBe(false);
		});

		it("rejects an undefined error id", () => {
			expect(isLocalTransportFailure(undefined, "fetch failed", undefined)).toBe(false);
		});

		it("rejects a transient error with no message to classify", () => {
			expect(isLocalTransportFailure(TRANSIENT, undefined, undefined)).toBe(false);
		});

		it("rejects transient wording that is not a transport fault", () => {
			expect(isLocalTransportFailure(TRANSIENT, NOT_TRANSPORT, undefined)).toBe(false);
		});
	});
});
