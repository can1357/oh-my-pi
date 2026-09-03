import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CodexResetFireworksEvent } from "@oh-my-pi/pi-coding-agent/modes/components/codex-reset-fireworks";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeSession(fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>): AgentSession {
	const messages: unknown[] = [];
	return {
		fetchUsageReports,
		messages,
		state: { messages, model: { contextWindow: 200_000 } },
		model: { contextWindow: 200_000 },
		isStreaming: false,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

interface CodexUsageState {
	sevenDayPercent: number;
	sevenDayResetAt: number;
	savedResets?: number;
	omitFetchedAt?: boolean;
	tier?: string;
	plan?: string;
}

function codexUsageReport(
	state: CodexUsageState,
	accountId = "account-1",
	email = "codex@example.com",
	orgId?: string,
): unknown[] {
	return [
		{
			provider: "openai-codex",
			...(state.omitFetchedAt ? {} : { fetchedAt: Date.now() }),
			metadata: {
				accountId,
				email,
				...(orgId ? { orgId } : {}),
				...(state.plan ? { planType: state.plan } : {}),
			},
			...(state.savedResets === undefined ? {} : { resetCredits: { availableCount: state.savedResets } }),
			limits: [
				{
					id: "openai-codex:secondary",
					label: "Codex 7 Day",
					scope: {
						provider: "openai-codex",
						accountId,
						windowId: "7d",
						...(state.tier ? { tier: state.tier } : {}),
					},
					window: {
						id: "7d",
						label: "7d",
						resetsAt: state.sevenDayResetAt,
					},
					amount: { unit: "percent", usedFraction: state.sevenDayPercent / 100 },
				},
			],
		},
	];
}

function makeCodexSession(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	resolveActiveIdentity: () => { accountId: string; email?: string; orgId?: string } = () => ({
		accountId: "account-1",
		email: "codex@example.com",
	}),
): AgentSession {
	const session = makeSession(fetchUsageReports) as unknown as Record<string, unknown>;
	session.sessionId = "session-1";
	session.state = {
		messages: [],
		model: { contextWindow: 200_000, provider: "openai-codex" },
	};
	session.model = { contextWindow: 200_000, provider: "openai-codex" };
	session.modelRegistry = {
		authStorage: {
			getOAuthAccountIdentity: resolveActiveIdentity,
		},
	};
	return session as unknown as AgentSession;
}

async function refreshUsage(component: StatusLineComponent, advanceMs = 0): Promise<void> {
	if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
	component.refreshUsageInBackground();
	vi.advanceTimersByTime(0);
	await flushMicrotasks();
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
		);

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("passes a startup timeout signal to the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		const component = new StatusLineComponent(
			makeSession(async nextSignal => {
				signal = nextSignal;
				return [];
			}),
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<unknown>().promise;
			}),
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(makeSession(() => late.promise));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).not.toContain("5h");

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");
	});

	it("re-fetches usage immediately when the session rotates to another org under the same email", async () => {
		let calls = 0;
		let orgId = "org-team";
		const base = makeSession(async () => {
			calls++;
			return usageReport(10);
		}) as unknown as Record<string, unknown>;
		// Same provider + email + account throughout — only the org rotates.
		base.state = {
			messages: [],
			model: { contextWindow: 200_000, provider: "anthropic" },
		};
		base.modelRegistry = {
			authStorage: {
				getOAuthAccountIdentity: () => ({
					email: "shared@example.com",
					accountId: "account-shared",
					orgId,
				}),
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Same org within the cache TTL: served from cache, no refetch.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Org rotation under the same email/account must invalidate the cache.
		orgId = "org-max";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
	});

	it("keeps reset fireworks opt-in while advancing the disabled baseline", async () => {
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		expect(Settings.instance.get("tui.codexResetFireworks")).toBe(false);
		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);
		component.dispose();
	});

	it("emits distinct enabled events for an unscheduled weekly reset and a newly banked reset", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const nextSevenDayResetAt = sevenDayResetAt + 7 * 24 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		expect(events).toEqual([]);
		state = {
			sevenDayPercent: 41,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);
		state = {
			sevenDayPercent: 2,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		state = {
			sevenDayPercent: 25,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		state = {
			sevenDayPercent: 25.2,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 1,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([
			{ kind: "unscheduled-weekly-reset" },
			{ kind: "saved-reset-banked", added: 1, available: 1 },
		]);
		component.dispose();
	});

	it("compares weekly reset drops only within the same Codex quota tier", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
			tier: "spark",
			plan: "pro",
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = { ...state, sevenDayPercent: 2, tier: undefined };
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);

		state = { ...state, sevenDayPercent: 42, tier: "spark" };
		await refreshUsage(component, 5 * 60_000);
		state = { ...state, sevenDayPercent: 2, sevenDayResetAt: sevenDayResetAt + 7 * 24 * 3_600_000 };
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([{ kind: "unscheduled-weekly-reset" }]);
		component.dispose();
	});

	it("binds each reset snapshot to the account identity used to normalize it", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const reports = [
			...codexUsageReport(
				{
					sevenDayPercent: 18,
					sevenDayResetAt,
					savedResets: 0,
				},
				"account-a",
			),
			...codexUsageReport(
				{
					sevenDayPercent: 22,
					sevenDayResetAt,
					savedResets: 1,
				},
				"account-b",
			),
		];
		const identityLookups: string[] = [];
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => reports,
				() => ({ accountId: identityLookups.shift() ?? "account-a" }),
			),
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		// The refresh starts under A, but B is active when its report is normalized.
		// A later identity lookup must not attribute B's saved reset to A.
		identityLookups.push("account-a", "account-b", "account-a");
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not attribute a workspace sibling's saved resets to the active credential", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const workspaceId = "workspace-1";
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let bobSavedResets = 0;
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => [
					...codexUsageReport(
						{ sevenDayPercent: 18, sevenDayResetAt, savedResets: 0 },
						workspaceId,
						"alice@example.com",
						workspaceId,
					),
					...codexUsageReport(
						{ sevenDayPercent: 22, sevenDayResetAt, savedResets: bobSavedResets },
						workspaceId,
						"bob@example.com",
						workspaceId,
					),
				],
				() => ({
					accountId: workspaceId,
					email: "alice@example.com",
					orgId: workspaceId,
				}),
			),
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		bobSavedResets = 1;
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("keeps an unavailable saved-reset count unknown across refreshes", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 18,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 18.1,
			sevenDayResetAt,
		};
		await refreshUsage(component, 5 * 60_000);
		state = { ...state, savedResets: 1 };
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("suppresses an early weekly drop when a prior saved-reset balance becomes unavailable", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not infer an observation time when the provider omits fetchedAt", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(makeCodexSession(async () => codexUsageReport(state)));
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
			omitFetchedAt: true,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("discards a timed-out report after a newer refresh applies", async () => {
		Settings.instance.set("tui.codexResetFireworks", true);
		const stale = Promise.withResolvers<unknown>();
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const current: CodexUsageState = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		let calls = 0;
		const component = new StatusLineComponent(
			makeCodexSession(async () => {
				calls++;
				return calls === 1 ? stale.promise : codexUsageReport(current);
			}),
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);
		expect(calls).toBe(2);

		stale.resolve(
			codexUsageReport({
				sevenDayPercent: 42,
				sevenDayResetAt,
				savedResets: 1,
			}),
		);
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);

		expect(calls).toBe(3);
		expect(events).toEqual([]);
		component.dispose();
	});
});
