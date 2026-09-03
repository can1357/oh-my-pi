import { describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext, OAuthAccess, OAuthAccessSource } from "@oh-my-pi/pi-ai";
import {
	AUTH_RETRY_MAX_ATTEMPTS,
	isApiKeyResolver,
	isAuthRetryableError,
	resolveApiKeyOnce,
	withAuth,
	withOAuthAccess,
} from "@oh-my-pi/pi-ai";
import { OAuthError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";

function authError(status = 401): Error & { status: number } {
	return Object.assign(new Error(`${status} authentication_error`), { status });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

function opaque429Error(): Error & { status: number } {
	return Object.assign(new Error(""), { status: 429 });
}

describe("isApiKeyResolver / resolveApiKeyOnce", () => {
	it("narrows resolver vs static key and resolves the initial value", async () => {
		expect(isApiKeyResolver("static")).toBe(false);
		expect(isApiKeyResolver(undefined)).toBe(false);
		expect(isApiKeyResolver(() => "k")).toBe(true);

		expect(await resolveApiKeyOnce("static")).toBe("static");
		expect(await resolveApiKeyOnce(undefined)).toBeUndefined();

		let seen: ApiKeyResolveContext | undefined;
		const resolved = await resolveApiKeyOnce(ctx => {
			seen = ctx;
			return "minted";
		});
		expect(resolved).toBe("minted");
		// Initial resolve must look like an initial resolve, not a retry.
		expect(seen).toEqual({ lastChance: false, error: undefined, signal: undefined });
	});
});

describe("isAuthRetryableError", () => {
	it("retries typed token-refresh requests without treating other OAuth failures as retryable", () => {
		expect(
			isAuthRetryableError(
				new OAuthError("OAuth token expired before request", {
					kind: "token-refresh",
					provider: "google-antigravity",
				}),
			),
		).toBe(true);
		expect(
			isAuthRetryableError(
				new OAuthError("OAuth provider is misconfigured", {
					kind: "configuration",
					provider: "google-antigravity",
				}),
			),
		).toBe(false);
	});

	it("treats 401/403 and usage-limit phrasing as retryable, everything else as not", () => {
		expect(isAuthRetryableError(authError(401))).toBe(true);
		expect(isAuthRetryableError(usageLimitError())).toBe(true);
		expect(
			isAuthRetryableError(new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" })),
		).toBe(true);
		expect(
			isAuthRetryableError(new ProviderHttpError("Generic provider failure", 429, { code: "rate_limit_error" })),
		).toBe(false);
		// A 429 whose body names the *account's* rate limit is rotatable (switch
		// account), even though it isn't a 401 and isn't phrased "usage limit".
		expect(
			isAuthRetryableError(
				Object.assign(
					new Error(
						'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=9779000',
					),
					{ status: 429 },
				),
			),
		).toBe(true);
		// A generic (non-account) 429 rate limit is NOT rotatable — switching
		// credentials won't help an org/global limit.
		expect(isAuthRetryableError(Object.assign(new Error("429 too many requests"), { status: 429 }))).toBe(false);
		expect(isAuthRetryableError("Error: 401 unauthorized")).toBe(true);
		expect(isAuthRetryableError("Encountered invalidated oauth token for user, failing request")).toBe(true);
		// xAI SuperGrok surfaces account exhaustion as 403 + "run out of credits" /
		// spending-limit, not 429. Must rotate so multi-account xai-oauth pools work.
		expect(
			isAuthRetryableError(
				Object.assign(
					new Error(
						"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)",
					),
					{ status: 403 },
				),
			),
		).toBe(true);
		// Bare 403: token valid but access denied (plan/model/org policy) — a
		// sibling account may not share the restriction, so rotate.
		expect(isAuthRetryableError(authError(403))).toBe(true);
		expect(isAuthRetryableError("Error: 403 forbidden")).toBe(true);
		// Cline's client-surface gate (403) is per-model client policy, not a
		// credential problem: sibling keys fail identically, so rotation would
		// only burn them.
		expect(
			isAuthRetryableError(
				new Error(
					"Error 403: deepseek/deepseek-v4-flash is only available via Cline product surfaces. If you are using an old version of Cline, please update to the latest version",
				),
			),
		).toBe(false);
		expect(isAuthRetryableError(authError(500))).toBe(false);
		expect(isAuthRetryableError(new Error("network blip"))).toBe(false);
		expect(isAuthRetryableError(undefined)).toBe(false);
	});
});

describe("withAuth", () => {
	it("runs a single attempt for a static string key (no retry)", async () => {
		const keys: Array<string | undefined> = [];
		const result = await withAuth("static-key", async key => {
			keys.push(key);
			return `ok:${key}`;
		});
		expect(result).toBe("ok:static-key");
		expect(keys).toEqual(["static-key"]);
	});

	it("throws when a static key is missing", async () => {
		await expect(withAuth(undefined, async () => "never", { missingKeyMessage: "no key for foo" })).rejects.toThrow(
			"no key for foo",
		);
	});

	it("refreshes the same account, then switches, in order", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "k0" : ctx.lastChance ? "k2" : "k1";
			},
			async key => {
				keys.push(key);
				if (key === "k2") return "success";
				throw authError();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(["k0", "k1", "k2"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: false, hasError: true },
			{ lastChance: true, hasError: true },
		]);
	});

	it("does not exhaust every sibling on pure 401 auth failures", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["k0", "k1", "k2", "k3"];
		let resolveIndex = 0;
		let lastError: unknown;
		let caught: unknown;

		try {
			await withAuth(
				ctx => {
					contexts.push(ctx);
					return ctx.error === undefined ? pool[0] : pool[++resolveIndex];
				},
				async key => {
					keys.push(key);
					lastError = authError();
					throw lastError;
				},
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(lastError);
		expect(keys).toEqual(["k0", "k1", "k2"]);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, false, true]);
	});

	it("continues quota rotation when a refreshed 401 retry becomes a usage limit", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["k0", "k1", "k2", "k3"];
		let resolveIndex = 0;
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? pool[0] : pool[++resolveIndex];
			},
			async key => {
				keys.push(key);
				if (key === "k3") return "success";
				if (key === "k0") throw authError();
				throw usageLimitError();
			},
		);

		expect(result).toBe("success");
		expect(keys).toEqual(pool);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, false, true, true]);
	});

	it("switches accounts before refreshing the same account on usage limits", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "k0" : ctx.lastChance ? "k2" : "k1";
			},
			async key => {
				keys.push(key);
				if (key === "k2") return "success";
				throw usageLimitError();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(["k0", "k2"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: true, hasError: true },
		]);
	});

	it("switches accounts before refreshing on opaque 429 usage outcomes", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "k0" : ctx.lastChance ? "k2" : "k1";
			},
			async key => {
				keys.push(key);
				if (key === "k2") return "success";
				throw opaque429Error();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(["k0", "k2"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: true, hasError: true },
		]);
	});

	it("rotates through every distinct sibling after consecutive usage limits", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["k0", "k1", "k2", "k3"];
		let nextSibling = 0;
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? pool[0] : pool[++nextSibling];
			},
			async key => {
				keys.push(key);
				if (key === "k3") return "success";
				throw usageLimitError();
			},
		);

		expect(result).toBe("success");
		expect(keys).toEqual(pool);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, true, true, true]);
	});

	it("rotates through every distinct sibling on consecutive 403s without a refresh detour", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["k0", "k1", "k2", "k3"];
		let nextSibling = 0;
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? pool[0] : pool[++nextSibling];
			},
			async key => {
				keys.push(key);
				if (key === "k3") return "success";
				throw authError(403);
			},
		);

		expect(result).toBe("success");
		expect(keys).toEqual(pool);
		// All-`lastChance` rotation: a 403 is a valid-token denial, so the
		// refresh-same step (b) is skipped like on usage limits.
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, true, true, true]);
	});

	it("leaves a 403 concurrency cap to the transient retry layer", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["k0", "k1", "k2", "k3"];
		let resolveIndex = 0;
		const concurrencyCap = Object.assign(new Error("concurrent requests limit reached"), { status: 403 });

		await expect(
			withAuth(
				ctx => {
					contexts.push(ctx);
					return ctx.error === undefined ? pool[0] : pool[++resolveIndex];
				},
				async key => {
					keys.push(key);
					throw concurrencyCap;
				},
			),
		).rejects.toBe(concurrencyCap);

		// The outer transient retry/backoff layer owns concurrency caps. The auth
		// retry layer must not refresh or select a sibling credential.
		expect(keys).toEqual(["k0"]);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false]);
	});

	it("surfaces the last 403 when every sibling is denied", async () => {
		const errors = [authError(403), authError(403)];
		const resolved = ["k0", "k1", "k0"];
		let resolveIndex = 0;
		let attemptIndex = 0;

		await expect(
			withAuth(
				() => resolved[resolveIndex++],
				async () => {
					throw errors[Math.min(attemptIndex++, errors.length - 1)]!;
				},
			),
		).rejects.toBe(errors[1]);
	});

	it("stops usage-limit rotation before retrying an already-attempted credential", async () => {
		const keys: string[] = [];
		const errors = [usageLimitError(), usageLimitError()];
		const resolved = ["k0", "k1", "k0"];
		let resolveIndex = 0;
		let attemptIndex = 0;

		await expect(
			withAuth(
				() => resolved[resolveIndex++],
				async key => {
					keys.push(key);
					throw errors[Math.min(attemptIndex++, errors.length - 1)]!;
				},
			),
		).rejects.toBe(errors[1]);
		expect(keys).toEqual(["k0", "k1"]);
	});

	it("caps endlessly unique resolver retries", async () => {
		const keys: string[] = [];
		let resolveIndex = 0;
		let lastError: unknown;
		let caught: unknown;

		try {
			await withAuth(
				() => `k${resolveIndex++}`,
				async key => {
					keys.push(key);
					lastError = usageLimitError();
					throw lastError;
				},
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(lastError);
		expect(keys).toHaveLength(AUTH_RETRY_MAX_ATTEMPTS);
		expect(resolveIndex).toBe(AUTH_RETRY_MAX_ATTEMPTS);
	});

	it("does not attempt a retry key resolved after abort", async () => {
		const controller = new AbortController();
		const keys: string[] = [];
		const original = usageLimitError();

		await expect(
			withAuth(
				ctx => {
					if (ctx.error === undefined) return "k0";
					controller.abort();
					return "k1";
				},
				async key => {
					keys.push(key);
					throw original;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(original);
		expect(keys).toEqual(["k0"]);
	});

	it("switches credentials when OpenRouter exhausts the daily free-model allowance", async () => {
		const keys: string[] = [];
		const result = await withAuth(
			ctx => (ctx.error === undefined || !ctx.lastChance ? "exhausted-key" : "healthy-key"),
			async key => {
				keys.push(key);
				if (key === "healthy-key") return "success";
				throw Object.assign(
					new Error(
						"429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
					),
					{ status: 429 },
				);
			},
		);

		expect(result).toBe("success");
		expect(keys).toEqual(["exhausted-key", "healthy-key"]);
	});

	it("stops retrying when the resolver returns undefined", async () => {
		const keys: string[] = [];
		const original = authError();
		await expect(
			withAuth(
				ctx => (ctx.error === undefined ? "k0" : undefined),
				async key => {
					keys.push(key);
					throw original;
				},
			),
		).rejects.toBe(original);
		expect(keys).toEqual(["k0"]);
	});

	it("does not re-attempt when the re-resolved key is unchanged", async () => {
		const keys: string[] = [];
		const original = authError();
		// refresh-same returns the same key (skip), switch returns the same key (skip).
		await expect(
			withAuth(
				() => "same",
				async key => {
					keys.push(key);
					throw original;
				},
			),
		).rejects.toBe(original);
		expect(keys).toEqual(["same"]);
	});

	it("propagates non-auth errors without retrying", async () => {
		const keys: string[] = [];
		const boom = new Error("network blip");
		await expect(
			withAuth(
				ctx => (ctx.error === undefined ? "k0" : "k1"),
				async key => {
					keys.push(key);
					throw boom;
				},
			),
		).rejects.toBe(boom);
		expect(keys).toEqual(["k0"]);
	});

	it("honors a custom isAuthError classifier", async () => {
		const keys: string[] = [];
		const result = await withAuth(
			ctx => (ctx.error === undefined ? "k0" : "k1"),
			async key => {
				keys.push(key);
				if (key === "k0") throw new Error("CUSTOM_RETRY");
				return "ok";
			},
			{ isAuthError: error => error instanceof Error && error.message === "CUSTOM_RETRY" },
		);
		expect(result).toBe("ok");
		expect(keys).toEqual(["k0", "k1"]);
	});
});

describe("withOAuthAccess", () => {
	type FakeStorage = OAuthAccessSource & {
		calls: Array<{ forceRefresh: boolean | undefined } | "rotate">;
	};

	function fakeStorage(tokens: { initial?: OAuthAccess; forced?: OAuthAccess; rotated?: OAuthAccess }): FakeStorage {
		const storage: FakeStorage = {
			calls: [],
			async getOAuthAccess(_provider, _sessionId, options) {
				storage.calls.push({ forceRefresh: options?.forceRefresh });
				if (options?.forceRefresh) return tokens.forced;
				// After a rotate, the next plain resolve yields the sibling.
				if (storage.calls.includes("rotate")) return tokens.rotated;
				return tokens.initial;
			},
			async rotateSessionCredential() {
				storage.calls.push("rotate");
				return tokens.rotated !== undefined;
			},
		};
		return storage;
	}

	const access = (token: string, extra?: Partial<OAuthAccess>): OAuthAccess => ({
		accessToken: token,
		...extra,
	});

	it("returns the first attempt without extra resolves", async () => {
		const storage = fakeStorage({ initial: access("t1") });
		const result = await withOAuthAccess(storage, "prov", async a => `ok:${a.accessToken}`);
		expect(result).toBe("ok:t1");
		expect(storage.calls).toEqual([{ forceRefresh: undefined }]);
	});

	it("uses the seed for the initial attempt and skips the initial resolve", async () => {
		const storage = fakeStorage({ initial: access("t1") });
		const result = await withOAuthAccess(storage, "prov", async a => a.accessToken, {
			seed: access("seeded"),
		});
		expect(result).toBe("seeded");
		expect(storage.calls).toEqual([]);
	});

	it("force-refreshes the same account on 401, carrying identity metadata", async () => {
		const storage = fakeStorage({
			initial: access("stale"),
			forced: access("fresh", { accountId: "acc-2", projectId: "proj-2" }),
		});
		const attempts: OAuthAccess[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a);
			if (a.accessToken === "stale") throw authError();
			return a.projectId;
		});
		expect(result).toBe("proj-2");
		expect(attempts.map(a => a.accessToken)).toEqual(["stale", "fresh"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, { forceRefresh: true }]);
	});

	it("allows one token-refresh replay without rotating to a sibling", async () => {
		const storage = fakeStorage({
			initial: access("stale", { credentialId: 7 }),
			forced: access("fresh", { credentialId: 7 }),
			rotated: access("sibling", { credentialId: 8 }),
		});
		const firstError = new OAuthError("First token expired before request", {
			kind: "token-refresh",
			provider: "prov",
		});
		const secondError = new OAuthError("Refreshed token also expired before request", {
			kind: "token-refresh",
			provider: "prov",
		});
		const attempts: string[] = [];
		await expect(
			withOAuthAccess(storage, "prov", async a => {
				attempts.push(a.accessToken);
				throw attempts.length === 1 ? firstError : secondError;
			}),
		).rejects.toBe(secondError);

		expect(attempts).toEqual(["stale", "fresh"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, { forceRefresh: true }]);
	});

	it("honors a token-refresh request after an earlier 401 refresh", async () => {
		const attempts: string[] = [];
		const calls: Array<{ forceRefresh: boolean | undefined } | "rotate"> = [];
		const forced = [access("fresh-but-expired", { credentialId: 7 }), access("renewed", { credentialId: 7 })];
		const storage: OAuthAccessSource = {
			async getOAuthAccess(_provider, _sessionId, options) {
				calls.push({ forceRefresh: options?.forceRefresh });
				if (options?.forceRefresh) return forced.shift();
				return access("stale", { credentialId: 7 });
			},
			async rotateSessionCredential() {
				calls.push("rotate");
				return true;
			},
		};
		const refreshRequest = new OAuthError("Refreshed token expired before request", {
			kind: "token-refresh",
			provider: "prov",
		});

		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "stale") throw authError();
			if (a.accessToken === "fresh-but-expired") throw refreshRequest;
			return "ok";
		});

		expect(result).toBe("ok");
		expect(attempts).toEqual(["stale", "fresh-but-expired", "renewed"]);
		expect(calls).toEqual([{ forceRefresh: undefined }, { forceRefresh: true }, { forceRefresh: true }]);
	});

	it("tries a refreshed bearer for the same credential id on 401 before rotating", async () => {
		const storage = fakeStorage({
			initial: access("stale", { credentialId: 7 }),
			forced: access("fresh", { credentialId: 7 }),
			rotated: access("sibling", { credentialId: 8 }),
		});
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "stale") throw authError();
			return "ok";
		});
		expect(result).toBe("ok");
		expect(attempts).toEqual(["stale", "fresh"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, { forceRefresh: true }]);
	});

	it("does not exhaust every OAuth sibling on pure 401 auth failures", async () => {
		const attempts: string[] = [];
		const calls: Array<{ forceRefresh: boolean | undefined } | "rotate"> = [];
		const rotated = [access("sibling-1", { credentialId: 2 }), access("sibling-2", { credentialId: 3 })];
		let rotateIndex = 0;
		let lastError: unknown;
		let caught: unknown;
		const storage: OAuthAccessSource = {
			async getOAuthAccess(_provider, _sessionId, options) {
				calls.push({ forceRefresh: options?.forceRefresh });
				if (options?.forceRefresh) return access("fresh", { credentialId: 1 });
				if (rotateIndex > 0) return rotated[rotateIndex - 1];
				return access("stale", { credentialId: 1 });
			},
			async rotateSessionCredential() {
				calls.push("rotate");
				rotateIndex += 1;
				return true;
			},
		};

		try {
			await withOAuthAccess(storage, "prov", async a => {
				attempts.push(a.accessToken);
				lastError = authError();
				throw lastError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(lastError);
		expect(attempts).toEqual(["stale", "fresh", "sibling-1"]);
		expect(calls).toEqual([
			{ forceRefresh: undefined },
			{ forceRefresh: true },
			"rotate",
			{ forceRefresh: undefined },
		]);
	});

	it("invalidates and rotates directly when upstream reports an invalidated OAuth token", async () => {
		const storage = fakeStorage({
			initial: access("dead", { credentialId: 1 }),
			rotated: access("sibling", { credentialId: 2 }),
		});
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "dead") {
				throw new Error("Encountered invalidated oauth token for user, failing request");
			}
			return "ok";
		});

		expect(result).toBe("ok");
		expect(attempts).toEqual(["dead", "sibling"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, "rotate", { forceRefresh: undefined }]);
	});

	it("rotates directly to a sibling on usage limits", async () => {
		const storage = fakeStorage({
			initial: access("dead"),
			rotated: access("sibling"),
		});
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "dead") throw usageLimitError();
			return "ok";
		});
		expect(result).toBe("ok");
		// Usage-limit failures burn/rotate the exhausted account directly; a
		// force-refresh of the same account would duplicate the failed side effect.
		expect(attempts).toEqual(["dead", "sibling"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, "rotate", { forceRefresh: undefined }]);
	});

	it("passes the failed OAuth bearer to rotation", async () => {
		const rotationTargets: Array<{ apiKey: string | undefined; credentialId: number | undefined }> = [];
		const storage: OAuthAccessSource = {
			async getOAuthAccess() {
				return rotationTargets.length === 0
					? access("dead", { credentialId: 17 })
					: access("sibling", { credentialId: 18 });
			},
			async rotateSessionCredential(_provider, _sessionId, options) {
				rotationTargets.push({ apiKey: options?.apiKey, credentialId: options?.credentialId });
				return true;
			},
		};
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "dead") throw usageLimitError();
			return "ok";
		});

		expect(result).toBe("ok");
		expect(attempts).toEqual(["dead", "sibling"]);
		expect(rotationTargets).toEqual([{ apiKey: "dead", credentialId: 17 }]);
	});

	it("caps endlessly unique OAuth rotation attempts", async () => {
		const attempts: string[] = [];
		let nextCredential = 0;
		let rotateCalls = 0;
		let lastError: unknown;
		let caught: unknown;
		const storage: OAuthAccessSource = {
			async getOAuthAccess() {
				const credentialId = nextCredential++;
				return access(`token-${credentialId}`, { credentialId });
			},
			async rotateSessionCredential() {
				rotateCalls += 1;
				return true;
			},
		};

		try {
			await withOAuthAccess(storage, "prov", async a => {
				attempts.push(a.accessToken);
				lastError = usageLimitError();
				throw lastError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(lastError);
		expect(attempts).toHaveLength(AUTH_RETRY_MAX_ATTEMPTS);
		expect(rotateCalls).toBe(AUTH_RETRY_MAX_ATTEMPTS - 1);
	});

	it("propagates non-auth errors immediately and surfaces the last auth error when exhausted", async () => {
		const boom = new Error("syntax error");
		await expect(
			withOAuthAccess(fakeStorage({ initial: access("t1") }), "prov", async () => {
				throw boom;
			}),
		).rejects.toBe(boom);

		const dead = authError();
		await expect(
			withOAuthAccess(fakeStorage({ initial: access("t1") }), "prov", async () => {
				throw dead;
			}),
		).rejects.toBe(dead);
	});

	it("throws the missing-access message when no credential resolves", async () => {
		await expect(
			withOAuthAccess(fakeStorage({}), "prov", async () => "never", {
				missingAccessMessage: "no codex account",
			}),
		).rejects.toThrow("no codex account");
	});
});
