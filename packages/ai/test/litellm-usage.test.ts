/**
 * Contract tests for the LiteLLM management usage adapter: which management
 * endpoints it reads (and how), how key/user USD budget counters normalize
 * into usage limits, which timestamps it trusts, and how scope failures reach
 * the AuthStorage usage cache.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { USAGE_REPORT_TTL_MS } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	type UsageFetchParams,
	type UsageLimit,
	type UsageLogger,
	type UsageReport,
	usageReportSchema,
} from "@oh-my-pi/pi-ai/usage";
import { litellmUsageProvider } from "@oh-my-pi/pi-ai/usage/litellm";
import { withEnv } from "./helpers";

const ALIAS = "team-gateway";
const ALIAS_BASE_URL = "https://gw.example/team/v1/";
const MANAGEMENT_ENDPOINT = "https://gw.example/team";
const KEY_INFO_URL = `${MANAGEMENT_ENDPOINT}/key/info`;
const USER_INFO_URL = `${MANAGEMENT_ENDPOINT}/v2/user/info`;
const MANAGEMENT_KEY = "sk-fixture";
const VIRTUAL_KEY = "fixture-user";
const KEY_LIMIT_ID = `${ALIAS}:key:${Bun.hash(MANAGEMENT_KEY).toString(16)}:budget`;
const USER_LIMIT_ID = `${ALIAS}:user:budget`;

const REPORT_NOTE = "Reported key/user budget counters may lag enforcement; other gateway limits are not included.";
const USER_SCOPE_NOTE = "Whether the user budget applies to team-scoped requests depends on gateway policy.";
const NO_LIMIT_NOTE = "No finite budget limit reported.";
const THROTTLE_NOTE = "This key has opted into budget throttling; gateway policy may throttle rather than block it.";

/** Pinned clock for temporary-budget expiry decisions. */
const NOW = Date.UTC(2029, 11, 1);
const FUTURE_EXPIRY = "2030-01-01T00:00:00Z";
const PAST_EXPIRY = "2029-11-30T00:00:00Z";
/** A zone with a non-zero UTC offset makes host-local parsing of zoneless timestamps observable. */
const NON_UTC_ZONE = "Asia/Kolkata";

type Reply = { status?: number; body?: unknown; text?: string } | Error;

interface GatewayFixture {
	apiKey: string;
	keyInfo?: Reply;
	userInfo?: Reply;
}

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

function reply(body: unknown, status = 200): Reply {
	return { status, body };
}

const VALID_KEY_INFO = reply({ key: MANAGEMENT_KEY, info: { user_id: "u1", spend: 10, max_budget: 40 } });
const VALID_USER_INFO = reply({ user_id: "u1", spend: 25, max_budget: 100 });

/**
 * Fake gateway routed by management path suffix; records full request URLs so
 * query strings and foreign paths stay visible to assertions. Honors an
 * aborted signal the way the platform fetch does.
 */
function gatewayFetch(fixture: GatewayFixture, requests: RecordedRequest[]): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		init?.signal?.throwIfAborted();
		const route = url.endsWith("/key/info")
			? fixture.keyInfo
			: url.endsWith("/v2/user/info")
				? fixture.userInfo
				: undefined;
		if (route === undefined) return Response.json({ detail: "Not Found" }, { status: 404 });
		if (route instanceof Error) throw route;
		return new Response(route.text ?? JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
}

async function probe(fixture: GatewayFixture, params: Partial<UsageFetchParams> = {}, logger?: UsageLogger) {
	const requests: RecordedRequest[] = [];
	const report = await litellmUsageProvider.fetchUsage(
		{ provider: ALIAS, baseUrl: ALIAS_BASE_URL, credential: { type: "api_key", apiKey: fixture.apiKey }, ...params },
		{ fetch: gatewayFetch(fixture, requests), logger },
	);
	return { report, requests };
}

function requireLimit(report: UsageReport | null, id: string): UsageLimit {
	const limit = report?.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

async function keyBudget(info: Record<string, unknown>): Promise<UsageLimit> {
	const { report } = await probe({
		apiKey: MANAGEMENT_KEY,
		keyInfo: reply({ key: MANAGEMENT_KEY, info }),
		userInfo: reply({}, 404),
	});
	return requireLimit(report, KEY_LIMIT_ID);
}

async function userBudget(user: Record<string, unknown>): Promise<UsageLimit> {
	const { report } = await probe({ apiKey: VIRTUAL_KEY, userInfo: reply(user) });
	return requireLimit(report, USER_LIMIT_ID);
}

function adjustedKey(increase: unknown, expiry: unknown): Record<string, unknown> {
	return { spend: 40, max_budget: 100, metadata: { temp_budget_increase: increase, temp_budget_expiry: expiry } };
}

function expectWireValid(report: UsageReport | null): void {
	const validated = usageReportSchema(report);
	expect(validated instanceof type.errors ? validated.summary : "valid").toBe("valid");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiteLLM usage provider: management endpoints", () => {
	it("reports a virtual key's self-user budget from the alias's management origin", async () => {
		const { report, requests } = await probe({
			apiKey: VIRTUAL_KEY,
			userInfo: reply({
				user_id: "u1",
				user_email: "ada@example.com",
				spend: 25,
				max_budget: 100,
				budget_duration: "7d",
				budget_reset_at: "2030-01-07T00:00:00",
				// Outside the allowlist; the exact equality below proves they are dropped.
				token: "token-secret",
				key: VIRTUAL_KEY,
				teams: ["team-secret"],
				metadata: { note: "metadata-secret" },
			}),
		});

		// No `sk-` prefix: only the flat self-user record, read without a query.
		expect(requests.map(request => request.url)).toEqual([USER_INFO_URL]);
		expect(report).toEqual({
			provider: ALIAS,
			fetchedAt: expect.any(Number),
			limits: [
				{
					id: USER_LIMIT_ID,
					label: "User budget",
					scope: { provider: ALIAS, shared: true, windowId: "7d", accountId: "u1" },
					window: { id: "7d", label: "7d", resetsAt: Date.UTC(2030, 0, 7) },
					amount: {
						used: 25,
						limit: 100,
						remaining: 75,
						usedFraction: 0.25,
						remainingFraction: 0.75,
						unit: "usd",
					},
					status: "ok",
				},
			],
			notes: [REPORT_NOTE, USER_SCOPE_NOTE],
			metadata: {
				source: "litellm-management",
				endpoint: MANAGEMENT_ENDPOINT,
				accountId: "u1",
				email: "ada@example.com",
			},
		});
		expectWireValid(report);
	});

	it("reads a management key's own record before the self-user record with the trimmed bearer", async () => {
		const { report, requests } = await probe({
			// Command- and file-sourced keys often carry surrounding whitespace.
			apiKey: `  ${MANAGEMENT_KEY}\n`,
			keyInfo: reply({
				key: MANAGEMENT_KEY,
				info: {
					user_id: "u1",
					spend: 10,
					max_budget: 40,
					budget_duration: "30d",
					budget_reset_at: "2030-01-31T00:00:00Z",
				},
			}),
			userInfo: VALID_USER_INFO,
		});

		expect(requests.map(request => request.url)).toEqual([KEY_INFO_URL, USER_INFO_URL]);
		for (const { init } of requests) {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${MANAGEMENT_KEY}`);
			expect(headers.get("accept")).toBe("application/json");
			expect(init?.redirect).toBe("error");
		}
		expect(report?.limits.map(limit => limit.id)).toEqual([KEY_LIMIT_ID, USER_LIMIT_ID]);
		expect(requireLimit(report, KEY_LIMIT_ID)).toEqual({
			id: KEY_LIMIT_ID,
			label: "Key budget",
			scope: { provider: ALIAS, shared: true, windowId: "30d", accountId: "u1" },
			window: { id: "30d", label: "30d", resetsAt: Date.UTC(2030, 0, 31) },
			amount: { used: 10, limit: 40, remaining: 30, usedFraction: 0.25, remainingFraction: 0.75, unit: "usd" },
			status: "ok",
		});
		expect(report?.notes).toEqual([REPORT_NOTE, USER_SCOPE_NOTE]);
	});

	it("keeps every non-401 failure local to its own scope", async () => {
		const cases: [scenario: string, fixture: Omit<GatewayFixture, "apiKey">, limitIds: string[] | null][] = [
			["key endpoint 500", { keyInfo: reply({}, 500), userInfo: VALID_USER_INFO }, [USER_LIMIT_ID]],
			[
				"key endpoint transport failure",
				{ keyInfo: new TypeError("fetch failed"), userInfo: VALID_USER_INFO },
				[USER_LIMIT_ID],
			],
			[
				"key endpoint answers non-JSON",
				{ keyInfo: { text: "<html>proxy error</html>" }, userInfo: VALID_USER_INFO },
				[USER_LIMIT_ID],
			],
			["key without an owner: self-user 400", { keyInfo: VALID_KEY_INFO, userInfo: reply({}, 400) }, [KEY_LIMIT_ID]],
			[
				"self-user 403 is not an auth failure",
				{ keyInfo: VALID_KEY_INFO, userInfo: reply({}, 403) },
				[KEY_LIMIT_ID],
			],
			["gateway without /v2/user/info", { keyInfo: VALID_KEY_INFO, userInfo: reply({}, 404) }, [KEY_LIMIT_ID]],
			["neither scope available", { keyInfo: reply({}, 500), userInfo: reply({}, 404) }, null],
		];
		for (const [scenario, fixture, limitIds] of cases) {
			const { report, requests } = await probe({ apiKey: MANAGEMENT_KEY, ...fixture });
			expect(
				requests.map(request => request.url),
				scenario,
			).toEqual([KEY_INFO_URL, USER_INFO_URL]);
			expect(report?.limits.map(limit => limit.id) ?? null, scenario).toEqual(limitIds);
			// The user-scope caveat accompanies a user row only; the owner falls back to the key's user_id.
			const notes = limitIds?.includes(USER_LIMIT_ID) ? [REPORT_NOTE, USER_SCOPE_NOTE] : [REPORT_NOTE];
			expect(report?.notes, scenario).toEqual(limitIds === null ? undefined : notes);
			expect(report?.metadata?.accountId, scenario).toBe(limitIds === null ? undefined : "u1");
		}
	});

	it("rejects with a fixed 401 error and discards the other scope's data", async () => {
		const denied = reply({ detail: `Authentication Error, invalid key ${MANAGEMENT_KEY}` }, 401);
		const cases: [scenario: string, fixture: GatewayFixture][] = [
			[
				"self-user 401 after a valid key record",
				{ apiKey: MANAGEMENT_KEY, keyInfo: VALID_KEY_INFO, userInfo: denied },
			],
			[
				"key 401 before a valid self-user record",
				{ apiKey: MANAGEMENT_KEY, keyInfo: denied, userInfo: VALID_USER_INFO },
			],
		];
		for (const [scenario, fixture] of cases) {
			const error = await probe(fixture).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error, scenario).toBeInstanceOf(ProviderHttpError);
			expect(error, scenario).toMatchObject({ status: 401, message: "LiteLLM usage endpoint returned 401" });
		}
	});

	it("forwards an already-aborted signal to each scope once, without retrying", async () => {
		const controller = new AbortController();
		controller.abort();
		const { report, requests } = await probe(
			{ apiKey: MANAGEMENT_KEY, keyInfo: VALID_KEY_INFO, userInfo: VALID_USER_INFO },
			{ signal: controller.signal },
		);

		expect(report).toBeNull();
		expect(requests.map(request => [request.url, request.init?.signal?.aborted])).toEqual([
			[KEY_INFO_URL, true],
			[USER_INFO_URL, true],
		]);
	});

	it("keeps key material, team data, and arbitrary metadata out of reports and logs", async () => {
		const bearer = "sk-privacy-fixture";
		const secrets = [bearer, "sk-...ture", "token-hash-secret", "alias-secret", "team-secret", "metadata-secret"];
		const logged: unknown[] = [];
		const logger: UsageLogger = {
			debug: (message, meta) => logged.push(message, meta),
			warn: (message, meta) => logged.push(message, meta),
		};
		const keyInfo = reply({
			key: bearer,
			info: {
				key_name: "sk-...ture",
				token: "token-hash-secret",
				key_alias: "alias-secret",
				team_id: "team-secret",
				user_id: "u1",
				spend: 10,
				max_budget: 40,
				metadata: { arbitrary: "metadata-secret" },
			},
		});
		// Failing scopes echo secrets back, so the logging paths for HTTP, transport, and decode failures run too.
		const echoed = `Bearer ${bearer} rejected for team-secret (token-hash-secret)`;
		const partial = await probe({ apiKey: bearer, keyInfo, userInfo: reply({ detail: echoed }, 403) }, {}, logger);
		const failed = await probe(
			{
				apiKey: bearer,
				keyInfo: new TypeError(`connect failed: ${echoed}`),
				userInfo: { text: `not json: ${echoed}` },
			},
			{},
			logger,
		);

		expect(partial.report?.limits).toHaveLength(1);
		expect(failed.report).toBeNull();
		const reportJson = JSON.stringify(partial.report);
		// `Bun.inspect` renders Error messages that JSON.stringify would hide.
		const logText = Bun.inspect(logged);
		for (const secret of secrets) {
			expect(reportJson).not.toContain(secret);
			expect(logText).not.toContain(secret);
		}
	});

	it("refuses to follow a gateway redirect to another server", async () => {
		const redirectedRequests: string[] = [];
		const target = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				redirectedRequests.push(`${request.method} ${request.url} ${request.headers.get("authorization") ?? ""}`);
				return Response.json({ user_id: "u-redirected", spend: 1, max_budget: 2 });
			},
		});
		const gateway = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/key/info")
					return Response.json({ key: MANAGEMENT_KEY, info: { spend: 3, max_budget: 9 } });
				if (pathname === "/v2/user/info") return Response.redirect(new URL("/v2/user/info", target.url).href, 302);
				return Response.json({ detail: "Not Found" }, { status: 404 });
			},
		});
		try {
			const report = await litellmUsageProvider.fetchUsage(
				{
					provider: ALIAS,
					baseUrl: new URL("/v1", gateway.url).href,
					credential: { type: "api_key", apiKey: MANAGEMENT_KEY },
				},
				{ fetch },
			);

			expect(redirectedRequests).toEqual([]);
			// The redirected scope is simply unavailable; the key scope still reports.
			expect(report?.limits.map(limit => limit.id)).toEqual([KEY_LIMIT_ID]);
		} finally {
			await gateway.stop(true);
			await target.stop(true);
		}
	});
});

describe("LiteLLM usage provider: request preconditions", () => {
	it("sends nothing without an API key or a usable HTTP(S) management endpoint", async () => {
		const cases: [scenario: string, params: Partial<UsageFetchParams>][] = [
			["OAuth credential", { credential: { type: "oauth", accessToken: MANAGEMENT_KEY } }],
			["blank API key", { credential: { type: "api_key", apiKey: "   " } }],
			// An explicit empty endpoint must not select the built-in default either.
			["empty endpoint", { provider: "litellm", baseUrl: "" }],
			["non-HTTP endpoint", { baseUrl: "ftp://gw.example/team/v1" }],
			["malformed endpoint", { baseUrl: "not a url" }],
		];
		for (const [scenario, params] of cases) {
			const supported = litellmUsageProvider.supports?.({
				provider: ALIAS,
				baseUrl: ALIAS_BASE_URL,
				credential: { type: "api_key", apiKey: MANAGEMENT_KEY },
				...params,
			});
			const { report, requests } = await probe(
				{ apiKey: MANAGEMENT_KEY, keyInfo: VALID_KEY_INFO, userInfo: VALID_USER_INFO },
				params,
			);
			expect(supported, scenario).toBe(false);
			expect(report, scenario).toBeNull();
			expect(requests, scenario).toEqual([]);
		}
	});

	it("falls back to LITELLM_BASE_URL only for the built-in provider", async () => {
		const fixture: GatewayFixture = { apiKey: VIRTUAL_KEY, userInfo: VALID_USER_INFO };
		await withEnv({ LITELLM_BASE_URL: "http://127.0.0.1:4010/custom/v1" }, async () => {
			const alias = await probe(fixture, { baseUrl: undefined });
			expect(
				litellmUsageProvider.supports?.({ provider: ALIAS, credential: { type: "api_key", apiKey: VIRTUAL_KEY } }),
			).toBe(false);
			expect(alias.report).toBeNull();
			expect(alias.requests).toEqual([]);

			const builtIn = await probe(fixture, { provider: "litellm", baseUrl: undefined });
			expect(builtIn.requests.map(request => request.url)).toEqual(["http://127.0.0.1:4010/custom/v2/user/info"]);
			expect(builtIn.report?.provider).toBe("litellm");
			expect(builtIn.report?.metadata?.endpoint).toBe("http://127.0.0.1:4010/custom");
		});
		await withEnv({ LITELLM_BASE_URL: undefined }, async () => {
			const builtIn = await probe(fixture, { provider: "litellm", baseUrl: undefined });
			expect(builtIn.requests.map(request => request.url)).toEqual(["http://localhost:4000/v2/user/info"]);
		});
	});
});

describe("LiteLLM usage provider: budget counters", () => {
	it("reports exhausted budgets without clamping absolute spend", async () => {
		const { report } = await probe({
			apiKey: MANAGEMENT_KEY,
			// An explicit zero cap is a cap: it must not inherit the budget table's 50.
			keyInfo: reply({
				key: MANAGEMENT_KEY,
				info: { user_id: "u1", spend: 0, max_budget: 0, litellm_budget_table: { max_budget: 50 } },
			}),
			userInfo: reply({ user_id: "u1", spend: 150, max_budget: 100 }),
		});

		const key = requireLimit(report, KEY_LIMIT_ID);
		expect(key.amount).toEqual({
			used: 0,
			limit: 0,
			remaining: 0,
			usedFraction: 1,
			remainingFraction: 0,
			unit: "usd",
		});
		expect(key.status).toBe("exhausted");
		const user = requireLimit(report, USER_LIMIT_ID);
		expect(user.amount).toEqual({
			used: 150,
			limit: 100,
			remaining: 0,
			usedFraction: 1,
			remainingFraction: 0,
			unit: "usd",
		});
		expect(user.status).toBe("exhausted");
		expectWireValid(report);
	});

	it("reports spend alone when no finite cap applies", async () => {
		const { report } = await probe({
			apiKey: MANAGEMENT_KEY,
			// A malformed own cap is explicit: it must not fall through to the budget table's cap.
			keyInfo: reply({
				key: MANAGEMENT_KEY,
				info: { user_id: "u1", spend: 7, max_budget: "100", litellm_budget_table: { max_budget: 50 } },
			}),
			userInfo: reply({ user_id: "u1", spend: 7, max_budget: null }),
		});

		for (const id of [KEY_LIMIT_ID, USER_LIMIT_ID]) {
			const limit = requireLimit(report, id);
			expect(limit.amount, id).toEqual({ used: 7, unit: "usd" });
			expect(limit.status, id).toBe("unknown");
			expect(limit.notes, id).toEqual([NO_LIMIT_NOTE]);
		}
		expectWireValid(report);
	});

	it("omits a row whose spend or owner is unusable instead of guessing", async () => {
		const cases: [scenario: string, fixture: GatewayFixture][] = [
			[
				"string spend is not coerced",
				{
					apiKey: MANAGEMENT_KEY,
					keyInfo: reply({ key: MANAGEMENT_KEY, info: { spend: "5", max_budget: 10 } }),
					userInfo: reply({}, 404),
				},
			],
			[
				"missing spend is not treated as zero",
				{ apiKey: VIRTUAL_KEY, userInfo: reply({ user_id: "u1", max_budget: 10 }) },
			],
			["negative spend", { apiKey: VIRTUAL_KEY, userInfo: reply({ user_id: "u1", spend: -1, max_budget: 10 }) }],
			["self-user record without a user id", { apiKey: VIRTUAL_KEY, userInfo: reply({ spend: 1, max_budget: 10 }) }],
		];
		for (const [scenario, fixture] of cases) {
			const { report } = await probe(fixture);
			expect(report, scenario).toBeNull();
		}
	});

	it("inherits the budget-table cap independently of which reset schedule applies", async () => {
		const table = { max_budget: 50, budget_duration: "30d", budget_reset_at: "2030-01-31T00:00:00Z" };
		const cases: [scenario: string, info: Record<string, unknown>, cap: number, window: UsageLimit["window"]][] = [
			[
				"table cap with the key's own schedule",
				{
					spend: 10,
					max_budget: null,
					budget_duration: "1d",
					budget_reset_at: "2030-01-02T00:00:00Z",
					litellm_budget_table: table,
				},
				50,
				{ id: "1d", label: "1d", resetsAt: Date.UTC(2030, 0, 2) },
			],
			[
				"own cap with the table's schedule",
				{
					spend: 10,
					max_budget: 20,
					budget_duration: null,
					budget_reset_at: "2030-01-02T00:00:00Z",
					litellm_budget_table: table,
				},
				20,
				{ id: "30d", label: "30d", resetsAt: Date.UTC(2030, 0, 31) },
			],
			[
				"a blank own schedule does not fall back to the table's",
				{ spend: 10, max_budget: null, budget_duration: " ", litellm_budget_table: table },
				50,
				undefined,
			],
		];
		for (const [scenario, info, cap, window] of cases) {
			const limit = await keyBudget(info);
			expect(limit.amount.limit, scenario).toBe(cap);
			expect(limit.window, scenario).toEqual(window);
			expect(limit.scope.windowId, scenario).toBe(window?.id);
		}
	});

	it("applies only a complete, unexpired temporary key budget adjustment", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const cases: [scenario: string, info: Record<string, unknown>, cap: number | undefined][] = [
			["active increase", adjustedKey(50, FUTURE_EXPIRY), 150],
			["active decrease", adjustedKey(-50, FUTURE_EXPIRY), 50],
			["zero adjustment", adjustedKey(0, FUTURE_EXPIRY), 100],
			["expired adjustment", adjustedKey(50, PAST_EXPIRY), 100],
			["increase without an expiry", { spend: 40, max_budget: 100, metadata: { temp_budget_increase: 50 } }, 100],
			["non-numeric increase", adjustedKey("50", FUTURE_EXPIRY), undefined],
			[
				"overflowing sum",
				{
					spend: 40,
					max_budget: Number.MAX_VALUE,
					metadata: { temp_budget_increase: Number.MAX_VALUE, temp_budget_expiry: FUTURE_EXPIRY },
				},
				undefined,
			],
			[
				"unknown base cap",
				{ spend: 40, max_budget: null, metadata: { temp_budget_increase: 50, temp_budget_expiry: FUTURE_EXPIRY } },
				undefined,
			],
		];
		for (const [scenario, info, cap] of cases) {
			const limit = await keyBudget(info);
			expect(limit.amount.limit, scenario).toBe(cap);
			expect(limit.status, scenario).toBe(cap === undefined ? "unknown" : "ok");
		}
	});

	it("derives the key row only from the key's own counters", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const { report } = await probe({
			apiKey: MANAGEMENT_KEY,
			keyInfo: reply({
				key: MANAGEMENT_KEY,
				info: {
					spend: 40,
					max_budget: null,
					litellm_budget_table: {
						max_budget: 100,
						temp_budget_increase: 50,
						temp_budget_expiry: FUTURE_EXPIRY,
						metadata: { temp_budget_increase: 50, temp_budget_expiry: FUTURE_EXPIRY },
					},
					model_max_budget: { "gpt-4o": { max_budget: 1, budget_duration: "1d" } },
					model_spend: { "gpt-4o": 0.99 },
					budget_limits: [{ budget_duration: "1h", max_budget: 1, reset_at: "2029-12-01T01:00:00Z" }],
					soft_budget: 10,
				},
			}),
			userInfo: reply({}, 404),
		});

		expect(report?.limits.map(limit => limit.id)).toEqual([KEY_LIMIT_ID]);
		expect(requireLimit(report, KEY_LIMIT_ID).amount).toMatchObject({ used: 40, limit: 100, remaining: 60 });
	});

	it("adds the throttling caveat only to an exhausted key that opted in", async () => {
		const optedIn = { throttle_on_budget_exceeded: true };
		const { report } = await probe({
			apiKey: MANAGEMENT_KEY,
			keyInfo: reply({
				key: MANAGEMENT_KEY,
				info: { user_id: "u1", spend: 100, max_budget: 100, metadata: optedIn },
			}),
			userInfo: reply({ user_id: "u1", spend: 5, max_budget: 5, metadata: optedIn }),
		});

		expect(requireLimit(report, KEY_LIMIT_ID).notes).toEqual([THROTTLE_NOTE]);
		// User budgets have no throttling opt-in, whatever their metadata carries.
		expect(requireLimit(report, USER_LIMIT_ID).notes).toBeUndefined();
		expect((await keyBudget({ spend: 10, max_budget: 100, metadata: optedIn })).notes).toBeUndefined();
		expect((await keyBudget({ spend: 100, max_budget: 100 })).notes).toBeUndefined();
	});
});

describe("LiteLLM usage provider: timestamps", () => {
	it("parses reset times in the bounded ISO subset as UTC and drops impossible dates", async () => {
		await withEnv({ TZ: NON_UTC_ZONE }, async () => {
			const cases: [resetAt: string, resetsAt: number | undefined][] = [
				["2030-01-07", Date.UTC(2030, 0, 7)],
				["2030-01-07T12:00:00", Date.UTC(2030, 0, 7, 12)],
				["2030-01-07 12:00:00", Date.UTC(2030, 0, 7, 12)],
				["2030-01-07T12:00:00.123456+05:30", Date.UTC(2030, 0, 7, 6, 30, 0, 123)],
				["2029-12-31T23:30:00-0130", Date.UTC(2030, 0, 1, 1, 0)],
				["2028-02-29T00:00:00Z", Date.UTC(2028, 1, 29)],
				// `Date.parse` silently rolls these forward (March 2, March 1, next midnight).
				["2030-02-30T00:00:00Z", undefined],
				["2029-02-29T00:00:00Z", undefined],
				["2030-01-07T24:00:00Z", undefined],
				["01/07/2030", undefined],
			];
			for (const [resetAt, resetsAt] of cases) {
				const limit = await userBudget({
					user_id: "u1",
					spend: 1,
					max_budget: 10,
					budget_duration: "7d",
					budget_reset_at: resetAt,
				});
				// An unusable reset drops only the countdown, never the window.
				expect(limit.window, resetAt).toEqual({ id: "7d", label: "7d", resetsAt });
			}
		});
	});

	it("treats a temporary budget as active only before a valid expiry instant", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		await withEnv({ TZ: NON_UTC_ZONE }, async () => {
			const cases: [expiry: string, cap: number | undefined][] = [
				["2030-01-01", 150],
				["2029-01-01", 100],
				// 03:00 UTC is still ahead of the pinned clock; read as Kolkata time it would already have expired.
				["2029-12-01 03:00:00", 150],
				// Expiring exactly now is no longer active.
				["2029-12-01T00:00:00Z", 100],
				// An impossible date must not grant headroom.
				["2030-02-30T00:00:00Z", undefined],
				// A real leap day is a valid (expired) instant, not a malformed one.
				["2028-02-29T00:00:00Z", 100],
			];
			for (const [expiry, cap] of cases) {
				const limit = await keyBudget(adjustedKey(50, expiry));
				expect(limit.amount.limit, expiry).toBe(cap);
			}
		});
	});
});

describe("LiteLLM usage provider: cached reports", () => {
	it("replaces a stale cap with spend-only data, serves last-good through outages, and drops it after a 401", async () => {
		await withEnv({ LITELLM_API_KEY: undefined, LITELLM_BASE_URL: undefined }, async () => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const keyLimitId = `litellm:key:${Bun.hash(MANAGEMENT_KEY).toString(16)}:budget`;
			const fixture: GatewayFixture = {
				apiKey: MANAGEMENT_KEY,
				keyInfo: reply({ key: MANAGEMENT_KEY, info: { user_id: "u1", spend: 10, max_budget: 100 } }),
				userInfo: reply({}, 404),
			};
			const requests: RecordedRequest[] = [];
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			await store.saveApiKey("litellm", MANAGEMENT_KEY);
			const authStorage = new AuthStorage(store, {
				usageFetch: Object.assign(gatewayFetch(fixture, requests), { preconnect: fetch.preconnect }),
				usageProviderResolver: provider => (provider === "litellm" ? litellmUsageProvider : undefined),
			});
			const keyBudgetAmount = async () => {
				const reports = await authStorage.usage.reports({ baseUrlResolver: () => ALIAS_BASE_URL });
				const report = reports?.find(candidate => candidate.provider === "litellm");
				return report ? requireLimit(report, keyLimitId).amount : undefined;
			};
			try {
				await authStorage.credentials.reload();
				expect(await keyBudgetAmount()).toMatchObject({ used: 10, limit: 100 });
				expect(requests.map(request => request.url)).toEqual([KEY_INFO_URL, USER_INFO_URL]);

				// After the snapshot ages out, a transient outage still probes, then serves last-good.
				now += 2 * USAGE_REPORT_TTL_MS;
				fixture.keyInfo = reply({}, 500);
				expect(await keyBudgetAmount()).toMatchObject({ used: 10, limit: 100 });
				expect(requests).toHaveLength(4);

				// A later spend-only success replaces the bounded snapshot instead of keeping its cap.
				now += 2 * USAGE_REPORT_TTL_MS;
				fixture.keyInfo = reply({ key: MANAGEMENT_KEY, info: { user_id: "u1", spend: 12, max_budget: null } });
				expect(await keyBudgetAmount()).toEqual({ used: 12, unit: "usd" });

				// A revoked key drops last-good usage but leaves the inference credential in place.
				now += 2 * USAGE_REPORT_TTL_MS;
				fixture.keyInfo = reply({ detail: "invalid key" }, 401);
				expect(await keyBudgetAmount()).toBeUndefined();
				expect(store.listAuthCredentials("litellm").map(row => row.credential)).toEqual([
					{ type: "api_key", key: MANAGEMENT_KEY },
				]);
				expect(await authStorage.keys.get("litellm")).toBe(MANAGEMENT_KEY);
			} finally {
				authStorage.close();
			}
		});
	});
});
