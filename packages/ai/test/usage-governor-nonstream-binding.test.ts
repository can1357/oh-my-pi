import { afterEach, describe, expect, test } from "bun:test";
import { withAuth } from "../src/auth-retry";
import { fingerprintBearer } from "../src/auth/bearer-fingerprint";
import { configureUsageAdmission, UsageRouteInvalidatedError } from "../src/usage-governor/admission";
import type { UsageAdmission, UsageAdmissionRequest, UsageRouteBinding } from "../src/usage-governor/types";

const usage = {
	provider: "test-provider",
	modelId: "test-model",
	context: { source: "subagent" as const, sessionId: "session" },
};
const binding: UsageRouteBinding = {
	scopeId: "scope",
	revision: 1,
	owner: { kind: "role", role: "task" },
	target: { selector: "test-provider/test-model", provider: usage.provider, modelId: usage.modelId },
	credentialId: 17,
	intent: "proactive",
	bearerFingerprint: fingerprintBearer("bound-secret"),
};
const bound = { apiKey: "bound-secret", credentialId: 17, usageRouteBinding: binding };

function admission(overrides: Partial<UsageAdmission> = {}): UsageAdmission {
	return {
		active: true,
		validateRoute: (route, request) =>
			route === binding &&
			request.credentialId === binding.credentialId &&
			request.bearerFingerprint === binding.bearerFingerprint &&
			request.provider === usage.provider &&
			request.modelId === usage.modelId &&
			request.context?.sessionId === usage.context.sessionId,
		admit: async () => ({ id: "grant", waitedMs: 0 }),
		settle: () => {},
		...overrides,
	};
}

afterEach(() => configureUsageAdmission(undefined));

describe("withAuth bound route authorization", () => {
	test("rejects invalid or unverifiable bindings without an attempt", async () => {
		for (const seam of [
			undefined,
			admission({ active: false }),
			admission({ validateRoute: undefined }),
			admission({ validateRoute: () => false }),
		]) {
			configureUsageAdmission(seam);
			let calls = 0;
			await expect(
				withAuth(
					() => bound,
					async () => {
						calls++;
					},
					{ usage, isAuthError: () => true },
				),
			).rejects.toBeInstanceOf(UsageRouteInvalidatedError);
			expect(calls).toBe(0);
		}
	});

	test("passes route, credential, bearer fingerprint and request context to the verifier", async () => {
		const observed: UsageAdmissionRequest[] = [];
		configureUsageAdmission(
			admission({
				admit: async request => {
					observed.push(request);
					return { id: "grant", waitedMs: 0 };
				},
			}),
		);
		const sent: string[] = [];
		const result = await withAuth(
			() => bound,
			async key => {
				sent.push(key);
				return "ok";
			},
			{ usage },
		);
		expect(result).toBe("ok");
		expect(sent).toEqual(["bound-secret"]);
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({
			...usage,
			credentialId: 17,
			bearerFingerprint: binding.bearerFingerprint,
			usageRouteBinding: binding,
		});
	});

	test("revalidates after admission and settles an invalidated grant as not sent", async () => {
		let valid = true;
		const outcomes: string[] = [];
		configureUsageAdmission(
			admission({
				validateRoute: () => valid,
				admit: async () => {
					valid = false;
					return { id: "grant", waitedMs: 0 };
				},
				settle: (_id, outcome) => outcomes.push(outcome),
			}),
		);
		let calls = 0;
		await expect(
			withAuth(
				() => bound,
				async () => {
					calls++;
				},
				{ usage },
			),
		).rejects.toBeInstanceOf(UsageRouteInvalidatedError);
		expect(calls).toBe(0);
		expect(outcomes).toEqual(["not-sent"]);
	});

	test("does not rotate a failed bound attempt into an unbound credential", async () => {
		configureUsageAdmission(admission());
		const failure = new Error("auth failed");
		let resolutions = 0;
		const attempts: string[] = [];
		await expect(
			withAuth(
				() => {
					resolutions++;
					return resolutions === 1 ? bound : "unbound";
				},
				async key => {
					attempts.push(key);
					throw failure;
				},
				{ usage, isAuthError: () => true },
			),
		).rejects.toBe(failure);
		expect(resolutions).toBe(1);
		expect(attempts).toEqual(["bound-secret"]);
	});

	test("validates a bound retry and does not rotate after it fails", async () => {
		configureUsageAdmission(admission());
		const failure = new Error("auth failed");
		let resolutions = 0;
		const attempts: string[] = [];
		await expect(
			withAuth(
				() => {
					resolutions++;
					return resolutions === 1 ? "initial" : resolutions === 2 ? bound : "unbound";
				},
				async key => {
					attempts.push(key);
					throw failure;
				},
				{ usage, isAuthError: () => true },
			),
		).rejects.toBe(failure);
		expect(resolutions).toBe(2);
		expect(attempts).toEqual(["initial", "bound-secret"]);
	});
	test("rejects an invalid binding returned during retry without dispatching or rotating again", async () => {
		configureUsageAdmission(admission({ validateRoute: () => false }));
		let resolutions = 0;
		const attempts: string[] = [];
		await expect(
			withAuth(
				() => {
					resolutions++;
					return resolutions === 1 ? "initial" : bound;
				},
				async key => {
					attempts.push(key);
					throw new Error("auth failed");
				},
				{ usage, isAuthError: () => true },
			),
		).rejects.toBeInstanceOf(UsageRouteInvalidatedError);
		expect(resolutions).toBe(2);
		expect(attempts).toEqual(["initial"]);
	});

	test("unbound retries retain their previous behavior", async () => {
		configureUsageAdmission(undefined);
		const calls: string[] = [];
		const result = await withAuth(
			({ error }) => (error ? "refreshed" : "initial"),
			async key => {
				calls.push(key);
				if (key === "initial") throw new Error("auth failed");
				return "ok";
			},
			{ isAuthError: () => true },
		);
		expect(result).toBe("ok");
		expect(calls).toEqual(["initial", "refreshed"]);
	});

	test("abort during bound admission prevents dispatch and settles the grant", async () => {
		const controller = new AbortController();
		const reason = new Error("aborted");
		const outcomes: string[] = [];
		configureUsageAdmission(
			admission({
				admit: async () => {
					controller.abort(reason);
					return { id: "grant", waitedMs: 0 };
				},
				settle: (_id, outcome) => outcomes.push(outcome),
			}),
		);
		let calls = 0;
		await expect(
			withAuth(
				() => bound,
				async () => {
					calls++;
				},
				{ usage, signal: controller.signal },
			),
		).rejects.toBe(reason);
		expect(calls).toBe(0);
		expect(outcomes).toEqual(["not-sent"]);
	});
});
