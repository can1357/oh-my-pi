import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { umansUsageProvider } from "../src/usage/umans";

const DEFAULT_BASE_URL = "https://api.code.umans.ai";

const RESETS_AT = "2026-08-06T21:52:21.202174+00:00";

function umansPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		plan: { display_name: "Code Max" },
		limits: {
			requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
			concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
		},
		window: {
			started_at: "2026-08-06T16:52:21.202174+00:00",
			resets_at: RESETS_AT,
			remaining_minutes: 9,
		},
		usage: {
			requests_in_window: 48,
			remaining_requests: 152,
			weighted_in_window: 96,
			weighted_remaining_requests: 104,
			concurrent_sessions: 1,
			tokens_in: 1_200_000,
			tokens_out: 340_000,
			priority: { low: false, boxed_until: null, reason: null },
		},
		...overrides,
	};
}

function fakeFetch(payload: unknown, status = 200): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	return fn as unknown as typeof fetch;
}

function fetchRecorder(
	calls: Array<{ url: string; headers: Record<string, string> }>,
	payload: unknown,
	status = 200,
): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}
describe("umans usage provider", () => {
	it("splits requests into soft-cap (weighted) and burst-ceiling (raw) limits", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test", accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(umansPayload()) },
		);
		expect(report).not.toBeNull();
		const soft = report?.limits.find(l => l.id === "umans:requests:soft");
		expect(soft).toBeDefined();
		// Weighted "effective requests" are authoritative against the soft cap:
		// 96 effective used of 200.
		expect(soft?.amount.used).toBe(96);
		expect(soft?.amount.limit).toBe(200);
		expect(soft?.amount.remaining).toBe(104);
		expect(soft?.amount.usedFraction).toBeCloseTo(0.48, 5);
		expect(soft?.amount.remainingFraction).toBeCloseTo(0.52, 5);
		expect(soft?.amount.unit).toBe("requests");
		expect(soft?.status).toBe("ok");
		// The rolling 5h window still exposes its absolute `resets_at` as an
		// incremental countdown for the status line.
		expect(soft?.window?.resetsAt).toBe(Date.parse(RESETS_AT));
		expect(soft?.window?.resetLabel).toBe("tick");
		expect(soft?.window?.durationMs).toBe(18000_000);
		expect(soft?.window?.label).toBe("rolling 5h");
		// Raw counts against the burst ceiling are a separate row.
		const hard = report?.limits.find(l => l.id === "umans:requests:hard");
		expect(hard).toBeDefined();
		expect(hard?.amount.used).toBe(48);
		expect(hard?.amount.limit).toBe(400);
		expect(hard?.amount.usedFraction).toBeCloseTo(0.12, 5);
		expect(hard?.status).toBe("ok");
	});

	it("falls back to the legacy raw row when weighted fields are absent", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: fakeFetch(
					umansPayload({
						window: undefined,
						usage: {
							requests_in_window: 48,
							remaining_requests: 152,
							concurrent_sessions: 1,
							tokens_in: 0,
							tokens_out: 0,
							priority: { low: false },
						},
					}),
				),
			},
		);
		const requests = report?.limits.find(l => l.id === "umans:requests");
		expect(requests).toBeDefined();
		expect(report?.limits.some(l => l.id.startsWith("umans:requests:"))).toBe(false);
		expect(requests?.amount.used).toBe(48);
		expect(requests?.amount.remaining).toBe(152);
		expect(requests?.amount.usedFraction).toBeCloseTo(0.24, 5);
		expect(requests?.window?.resetsAt).toBeUndefined();
		expect(requests?.window?.label).toBe("rolling 5h");
	});

	it("does not report exhausted when raw requests exceed the soft cap but weighted headroom remains (#7858)", async () => {
		// Real payload from https://github.com/can1357/oh-my-pi/issues/7858:
		// raw 838 exceeds the 500 soft cap (previously clamped to 1.0 → false
		// exhausted), while weighted "effective requests" are 207/500 with 293
		// remaining — the account continues normally. Raw traffic only reaches
		// the burst ceiling (1000) before throttling applies.
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: fakeFetch(
					umansPayload({
						limits: {
							requests: { limit: 500, hard_cap: 1000, burst_pct: 1.0, window_seconds: 18000 },
							concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
						},
						usage: {
							requests_in_window: 838,
							remaining_requests: 0,
							weighted_in_window: 207,
							weighted_remaining_requests: 293,
							concurrent_sessions: 0,
							tokens_in: 3_557_477,
							tokens_out: 723_550,
							priority: { low: false, boxed_until: null, reason: null },
						},
					}),
				),
			},
		);
		const soft = report?.limits.find(l => l.id === "umans:requests:soft");
		expect(soft).toBeDefined();
		expect(soft?.amount.used).toBe(207);
		expect(soft?.amount.remaining).toBe(293);
		expect(soft?.amount.usedFraction).toBeCloseTo(0.414, 3);
		expect(soft?.status).toBe("ok");
		expect(soft?.window?.resetsAt).toBe(Date.parse(RESETS_AT));
		const hard = report?.limits.find(l => l.id === "umans:requests:hard");
		expect(hard).toBeDefined();
		expect(hard?.amount.used).toBe(838);
		expect(hard?.amount.limit).toBe(1000);
		expect(hard?.amount.usedFraction).toBeCloseTo(0.838, 3);
		expect(hard?.status).toBe("ok");
		expect(report?.limits.some(l => l.status === "exhausted")).toBe(false);
	});

	it("collapses to a single weighted requests row that can exhaust when no burst ceiling is reported", async () => {
		// Weighted counters present but `hard_cap` absent: without a burst
		// ceiling there is no hard row to defer exhaustion to, so the weighted
		// effective-request budget is the operative ceiling — the single row
		// must be able to report `exhausted` or a spent account could never
		// trigger the usage-aware fallback.
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: fakeFetch(
					umansPayload({
						limits: {
							requests: { limit: 200, window_seconds: 18000 },
							concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
						},
						usage: {
							requests_in_window: 400,
							remaining_requests: 0,
							weighted_in_window: 200,
							weighted_remaining_requests: 0,
							concurrent_sessions: 0,
							tokens_in: 0,
							tokens_out: 0,
							priority: { low: false },
						},
					}),
				),
			},
		);
		const requests = report?.limits.find(l => l.id === "umans:requests");
		expect(requests).toBeDefined();
		// No soft/hard split without a reported burst ceiling.
		expect(report?.limits.some(l => l.id.startsWith("umans:requests:"))).toBe(false);
		// Weighted effective requests are authoritative: raw 400 overshoots the
		// 200 limit, but it is the weighted 200/200 that reports exhausted.
		expect(requests?.amount.used).toBe(200);
		expect(requests?.amount.limit).toBe(200);
		expect(requests?.amount.usedFraction).toBe(1);
		expect(requests?.status).toBe("exhausted");
	});

	it("keeps weighted headroom decisive when no burst ceiling is reported", async () => {
		// Same #7858 shape (raw usage over the soft limit, weighted headroom
		// remaining) but with no `hard_cap` in the payload: the weighted counter
		// must still decide, so raw burst traffic cannot fabricate an exhausted
		// state even when there is no hard row to buffer it.
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: fakeFetch(
					umansPayload({
						limits: {
							requests: { limit: 200, window_seconds: 18000 },
							concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
						},
						usage: {
							requests_in_window: 300,
							remaining_requests: 0,
							weighted_in_window: 100,
							weighted_remaining_requests: 100,
							concurrent_sessions: 0,
							tokens_in: 0,
							tokens_out: 0,
							priority: { low: false },
						},
					}),
				),
			},
		);
		const requests = report?.limits.find(l => l.id === "umans:requests");
		expect(requests).toBeDefined();
		expect(requests?.amount.used).toBe(100);
		expect(requests?.amount.remaining).toBe(100);
		expect(requests?.amount.usedFraction).toBeCloseTo(0.5, 5);
		expect(requests?.status).toBe("ok");
		expect(report?.limits.some(l => l.status === "exhausted")).toBe(false);
	});

	it("reserves exhausted for the burst ceiling and warns at the soft cap", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: fakeFetch(
					umansPayload({
						usage: {
							requests_in_window: 1000,
							remaining_requests: 0,
							weighted_in_window: 500,
							weighted_remaining_requests: 0,
							concurrent_sessions: 0,
							tokens_in: 0,
							tokens_out: 0,
							priority: { low: false },
						},
					}),
				),
			},
		);
		const soft = report?.limits.find(l => l.id === "umans:requests:soft");
		expect(soft?.amount.usedFraction).toBe(1);
		// Soft cap hit = burst headroom in use; warn, never exhaust.
		expect(soft?.status).toBe("warning");
		const hard = report?.limits.find(l => l.id === "umans:requests:hard");
		expect(hard?.amount.usedFraction).toBe(1);
		// Only the raw burst ceiling can exhaust (that's where 429s start).
		expect(hard?.status).toBe("exhausted");
	});

	it("emits a concurrency limit from limits.concurrency", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch(umansPayload()) },
		);
		const concurrency = report?.limits.find(l => l.id === "umans:concurrency");
		expect(concurrency).toBeDefined();
		expect(concurrency?.amount.used).toBe(1);
		expect(concurrency?.amount.limit).toBe(4);
		expect(concurrency?.amount.unit).toBe("requests");
	});

	it("sends Authorization: Bearer <key> to the default base URL", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${DEFAULT_BASE_URL}/v1/usage`);
		expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
	});

	it("honors a custom baseUrl from params", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://custom.umans.example",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://custom.umans.example/v1/usage");
	});

	it("strips a trailing /v1 from a custom baseUrl", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://api.code.umans.ai/v1",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://api.code.umans.ai/v1/usage");
	});

	it("preserves a path-mounted gateway prefix while stripping /v1", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://gateway.example/team/umans/v1",
			},
			{ fetch: fetchRecorder(calls, umansPayload()) },
		);
		expect(calls[0]?.url).toBe("https://gateway.example/team/umans/v1/usage");
	});

	it("surfaces priority.low as a provider note", async () => {
		const payload = umansPayload({
			usage: {
				requests_in_window: 250,
				remaining_requests: 0,
				concurrent_sessions: 1,
				tokens_in: 0,
				tokens_out: 0,
				priority: { low: true, boxed_until: "2026-06-27T12:00:00Z", reason: "burst" },
			},
		});
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch(payload) },
		);
		expect(report?.notes).toContain("Requests deprioritized after a rate-limit burst.");
	});

	it("throws on a 401 auth failure so checkCredentials flags the bad key", async () => {
		await expect(
			umansUsageProvider.fetchUsage(
				{
					provider: "umans",
					credential: { type: "api_key", apiKey: "sk-test" },
				},
				{ fetch: fakeFetch({ message: "unauthorized" }, 401) },
			),
		).rejects.toThrow(/401/);
	});

	it("throws on a 403 auth failure so checkCredentials flags the bad key", async () => {
		await expect(
			umansUsageProvider.fetchUsage(
				{
					provider: "umans",
					credential: { type: "api_key", apiKey: "sk-test" },
				},
				{ fetch: fakeFetch({ message: "forbidden" }, 403) },
			),
		).rejects.toThrow(/403/);
	});

	it("returns null on a transient non-auth HTTP failure (500)", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{ fetch: fakeFetch({ message: "internal server error" }, 500) },
		);
		expect(report).toBeNull();
	});

	it("returns null when supports() is called for a different provider or credential type", () => {
		expect(umansUsageProvider.supports?.({ provider: "zai", credential: { type: "api_key", apiKey: "x" } })).toBe(
			false,
		);
		expect(
			umansUsageProvider.supports?.({ provider: "umans", credential: { type: "oauth", accessToken: "x" } }),
		).toBe(false);
		expect(umansUsageProvider.supports?.({ provider: "umans", credential: { type: "api_key", apiKey: "x" } })).toBe(
			true,
		);
	});

	it("includes plan display name and account identity in metadata", async () => {
		const report = await umansUsageProvider.fetchUsage(
			{
				provider: "umans",
				credential: { type: "api_key", apiKey: "sk-test", accountId: "acct-42", email: "dev@example.com" },
			},
			{ fetch: fakeFetch(umansPayload({ plan: { display_name: "Code Pro" } })) },
		);
		expect(report?.metadata?.plan).toBe("Code Pro");
		expect(report?.metadata?.accountId).toBe("acct-42");
		expect(report?.metadata?.email).toBe("dev@example.com");
	});
});
