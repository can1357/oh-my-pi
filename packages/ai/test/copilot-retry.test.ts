import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { callWithCopilotModelRetry, isCopilotTransientModelError } from "@oh-my-pi/pi-ai/utils/retry";
import { isRetryableError } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

type ErrorShape = {
	status: number;
	code?: string;
	error?: { code?: string; message?: string } | { error: { code?: string; message?: string } };
	message: string;
	headers?: Record<string, string>;
};

function copilotError({ status, code, error, message, headers }: ErrorShape): Error {
	const err = new Error(message);
	// Single sanctioned assertion point: `Error` carries no provider fields, and
	// every test reads them back through the real classifier.
	const shaped = err as unknown as ErrorShape;
	shaped.status = status;
	if (code !== undefined) shaped.code = code;
	if (error !== undefined) shaped.error = error;
	if (headers !== undefined) shaped.headers = headers;
	return err;
}

describe("isCopilotTransientModelError", () => {
	it("matches 400 with top-level code=model_not_supported", () => {
		const err = copilotError({
			status: 400,
			code: "model_not_supported",
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("matches 400 with nested error.code=model_not_supported (OpenAI SDK shape)", () => {
		const err = copilotError({
			status: 400,
			error: { code: "model_not_supported", message: "The requested model is not supported." },
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("does not match per-integrator entitlement errors nested two envelopes deep", () => {
		const err = copilotError({
			status: 400,
			error: {
				error: {
					code: "model_not_available_for_integrator",
					message: 'The requested model is not available for integrator "opencode".',
				},
			},
			message:
				'400 {"error":{"message":"The requested model is not available for integrator \\"opencode\\". Available models: [gpt-4.1 claude-opus-4.7]","code":"model_not_available_for_integrator","param":"model","type":"invalid_request_error"}}',
		});
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	it("does not infer fleet skew from per-integrator entitlement text", () => {
		const err = copilotError({
			status: 400,
			message: '400 {"error":{"message":"The requested model is not available for integrator \\"opencode\\"."}}',
		});
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	it("does not match other 400 codes", () => {
		const err = copilotError({
			status: 400,
			code: "invalid_request_body",
			message: "Unsupported value: 'minimal'",
		});
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	it("does not match 400 codes that collide with Object.prototype keys", () => {
		for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
			const err = copilotError({ status: 400, code, message: "bad request" });
			expect(isCopilotTransientModelError(err)).toBe(false);
		}
	});

	it("does not match 401/403/500 regardless of code", () => {
		for (const status of [401, 403, 500]) {
			const err = copilotError({
				status,
				code: "model_not_supported",
				message: `${status} error`,
			});
			expect(isCopilotTransientModelError(err)).toBe(false);
		}
	});

	it("does not match errors without a status", () => {
		expect(isCopilotTransientModelError(new Error("oops"))).toBe(false);
		expect(isCopilotTransientModelError("not an object")).toBe(false);
		expect(isCopilotTransientModelError(null)).toBe(false);
	});
});

describe("callWithCopilotModelRetry", () => {
	it("is a no-op for non-github-copilot providers", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "nope" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "openai" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("retries up to 8 attempts for Copilot transient errors and eventually throws the last error", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "transient" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(8);
	});

	it("succeeds on the second attempt when the first is transient", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not retry non-transient Copilot errors", async () => {
		let calls = 0;
		const err = copilotError({ status: 401, code: "unauthorized", message: "auth failed" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("does not retry per-integrator entitlement errors", async () => {
		let calls = 0;
		const err = copilotError({
			status: 400,
			code: "model_not_available_for_integrator",
			message:
				'400 The requested model is not available for integrator "opencode". Available models: [gpt-4.1 claude-opus-4.7]',
		});
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("does not blind-retry a 429 that carries no Retry-After guidance", async () => {
		let calls = 0;
		const err = copilotError({ status: 429, message: "rate limited" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("honors Retry-After on a 429 and retries", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw copilotError({ status: 429, message: "rate limited", headers: { "retry-after": "0.01" } });
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not stretch a persistent Retry-After 429 across the flap budget", async () => {
		let calls = 0;
		const err = copilotError({ status: 429, message: "rate limited", headers: { "retry-after": "0.01" } });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(3);
	});

	it("still retries status-less transport blips with the linear backoff", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error(
						'HTTP2StreamReset fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
					);
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("caps persistent generic retryable failures at the pre-flap budget", async () => {
		let calls = 0;
		const err = new Error(
			'HTTP2StreamReset fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
		);
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(3);
	});

	it("keeps the flat delay and the larger budget scoped to model flaps", async () => {
		const flatWaits: number[] = [];
		const rampWaits: number[] = [];
		const record = (into: number[]) => {
			const spy = vi.spyOn(scheduler, "wait");
			spy.mockImplementation(async (delay?: number) => {
				into.push(delay ?? 0);
			});
			return spy;
		};

		record(flatWaits);
		await expect(
			callWithCopilotModelRetry(
				async () => {
					throw copilotError({ status: 400, code: "model_not_supported", message: "flap" });
				},
				{ provider: "github-copilot", retryBaseDelayMs: 100 },
			),
		).rejects.toBeInstanceOf(Error);
		vi.restoreAllMocks();

		record(rampWaits);
		await expect(
			callWithCopilotModelRetry(
				async () => {
					throw new Error(
						'HTTP2StreamReset fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
					);
				},
				{ provider: "github-copilot", retryBaseDelayMs: 100 },
			),
		).rejects.toBeInstanceOf(Error);
		vi.restoreAllMocks();

		expect(flatWaits).toEqual([100, 100, 100, 100, 100, 100, 100]);
		expect(rampWaits).toEqual([100, 200]);
	});

	it("stops retrying when the caller aborts during backoff", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				},
				{ provider: "github-copilot", signal: controller.signal, retryBaseDelayMs: 0 },
			),
		).rejects.toBeDefined();
		// fn runs once; scheduler.wait rejects before a second attempt.
		expect(calls).toBe(1);
	});
});

describe("isRetryableError transport failures", () => {
	it("retries Bun socket closure errors", () => {
		expect(
			isRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});
	it("retries Bun HTTP/2 stream reset errors", () => {
		// Bun's fetch surfaces `@errorName` from its h2 client verbatim in the
		// message — see oven-sh/bun src/http/h2_client/dispatch.zig (HTTP2StreamReset,
		// HTTP2RefusedStream) and FetchTasklet.zig's "{s} fetching \"...\"" template.
		expect(
			isRetryableError(
				new Error(
					'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
				),
			),
		).toBe(true);
		expect(
			isRetryableError(
				new Error(
					'HTTP2RefusedStream fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
				),
			),
		).toBe(true);
	});
});

describe("isRetryableError does not treat 4xx as retryable", () => {
	// Regression guard: the new Copilot carveout must not leak into the generic predicate.
	it("returns false for Copilot transient model errors", () => {
		const err = copilotError({ status: 400, code: "model_not_supported", message: "x" });
		expect(isRetryableError(err)).toBe(false);
	});
});
