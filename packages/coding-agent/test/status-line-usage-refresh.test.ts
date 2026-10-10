import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CodexResetFireworksEvent } from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiCodexResetFireworks } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeSession(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	getSessionId: () => string = () => "conversation-1",
): AgentSession {
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
			getSessionId,
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
	/** Expiry (epoch ms) of each saved reset, when the report lists them. */
	creditExpiresAt?: number[];
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
			...(state.savedResets === undefined
				? {}
				: {
						resetCredits: {
							availableCount: state.savedResets,
							credits: state.creditExpiresAt?.map(at => ({
								expiresAt: new Date(at).toISOString(),
								status: "available",
							})),
						},
					}),
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
	getSessionId?: () => string,
): AgentSession {
	const session = makeSession(fetchUsageReports, getSessionId) as unknown as Record<string, unknown>;
	session.sessionId = "session-1";
	session.state = {
		messages: [],
		model: { contextWindow: 200_000, provider: "openai-codex" },
	};
	session.model = { contextWindow: 200_000, provider: "openai-codex" };
	session.modelRegistry = {
		authStorage: {
			oauth: { identity: resolveActiveIdentity },
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
			statusLineHost,
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
			statusLineHost,
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
			statusLineHost,
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
		const component = new StatusLineComponent(
			makeSession(() => late.promise),
			statusLineHost,
		);
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

	it("shows Claude's banked count, current availability, and expiry in the usage segment", async () => {
		const expiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
		const reports = usageReport(25) as Array<Record<string, unknown>>;
		reports[0]!.resetCredits = {
			availableCount: 3,
			redeemableCount: 0,
			reason: "weekly cooldown",
			credits: [
				{
					id: "cedar",
					title: "Claude reset",
					program: "cedar_ember",
					remainingCount: 3,
					usable: false,
					requiresLimit: true,
					clears: ["anthropic:5h", "anthropic:7d"],
					blocking: [],
					usedFractions: {},
					expiresAt,
				},
			],
		};
		const component = new StatusLineComponent(
			makeSession(async () => reports),
			statusLineHost,
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		await refreshUsage(component);

		const output = plain(component.getTopBorder(120).content);
		expect(output).toContain("✦ 3 (0 usable)");
		expect(output).toContain("exp 2d");
		expect(output).toContain("weekly cooldown");
	});

	it("counts down to the warned Claude grant, not an earlier one clearing only a quiet window", async () => {
		const grant = (id: string, program: string, clears: string[], hours: number) => ({
			id,
			program,
			remainingCount: 1,
			usable: true,
			requiresLimit: false,
			clears,
			blocking: [],
			usedFractions: {},
			expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
			status: "available",
		});
		const reports = usageReport(10) as Array<Record<string, unknown>>;
		(reports[0]!.limits as unknown[]).push({
			id: "anthropic:7d",
			label: "Claude 7 Day",
			scope: { provider: "anthropic", windowId: "7d" },
			window: { id: "7d", label: "7d", resetsAt: Date.now() + 80 * 3_600_000 },
			amount: { unit: "percent", usedFraction: 0.8 },
		});
		reports[0]!.resetCredits = {
			availableCount: 2,
			redeemableCount: 1,
			nextCreditId: "juniper",
			eligible: true,
			credits: [
				grant("juniper", "juniper_tide", ["anthropic:5h"], 1),
				grant("cedar", "cedar_ember", ["anthropic:7d"], 6),
			],
		};
		const component = new StatusLineComponent(
			makeSession(async () => reports),
			statusLineHost,
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		await refreshUsage(component);

		expect(plain(component.getTopBorder(120).content)).toContain("▲ 1 exp 6h");
		component.dispose();
	});

	it.each([
		{ name: "keeps a reset beyond 7 days plain", expiresInHours: 8 * 24, text: "✦ 1 exp 8d" },
		{ name: "flags a reset expiring within 7 days", expiresInHours: 5 * 24, text: "✦ 1 ▲ 1 exp 5d" },
		{ name: "flags a reset expiring within 24 hours", expiresInHours: 6, text: "✦ 1 ▲ 1 exp 6h" },
	])("$name in the active account's usage segment", async ({ expiresInHours, text }) => {
		const state: CodexUsageState = {
			sevenDayPercent: 60,
			sevenDayResetAt: Date.now() + 80 * 3_600_000,
			savedResets: 1,
			creditExpiresAt: [Date.now() + expiresInHours * 3_600_000],
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		component.updateSettings({ preset: "custom", leftSegments: ["usage"], rightSegments: [] });

		await refreshUsage(component);

		expect(plain(component.getTopBorder(120).content)).toContain(text);
		component.dispose();
	});

	it("warns once per conversation about another account's reset expiring within 24 hours", async () => {
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let fetches = 0;
		const reports = () => {
			fetches++;
			return [
				...codexUsageReport({ sevenDayPercent: 10, sevenDayResetAt }),
				...codexUsageReport(
					{ sevenDayPercent: 60, sevenDayResetAt, savedResets: 1, creditExpiresAt: [Date.now() + 6 * 3_600_000] },
					"account-2",
					"codex@example.com",
					"ws-team",
				),
			];
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => reports()),
			statusLineHost,
		);
		const notices: string[] = [];
		component.setResetExpiryNoticeHandler(notice => notices.push(notice));

		await refreshUsage(component);
		await refreshUsage(component, 5 * 60_000);

		expect(fetches).toBe(2);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Saved Codex reset on codex@example.com (ws-team) expires in 6h");
		expect(notices[0]).toContain("/usage");
		component.dispose();
	});

	it("warns about a banked Claude reset the provider will not spend yet", async () => {
		const claude = () => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			metadata: { email: "claude@example.com" },
			limits: [
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d" },
					window: { id: "7d", label: "7d", resetsAt: Date.now() + 80 * 3_600_000 },
					amount: { unit: "percent", usedFraction: 0.5 },
				},
			],
			resetCredits: {
				availableCount: 2,
				redeemableCount: 0,
				nextCreditId: "paused",
				credits: [
					{
						id: "paused",
						program: "cedar_ember",
						remainingCount: 2,
						usable: false,
						requiresLimit: false,
						clears: ["anthropic:5h", "anthropic:7d"],
						blocking: [],
						usedFractions: {},
						expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
						status: "paused",
					},
				],
			},
		});
		const codex = codexUsageReport({ sevenDayPercent: 10, sevenDayResetAt: Date.now() + 80 * 3_600_000 });
		const component = new StatusLineComponent(
			makeCodexSession(async () => [...codex, claude()]),
			statusLineHost,
		);
		const notices: string[] = [];
		component.setResetExpiryNoticeHandler(notice => notices.push(notice));

		await refreshUsage(component);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("2 saved Claude resets on claude@example.com expire, soonest in 6h");
		component.dispose();
	});

	it("warns each conversation that /new or /resume opens in place, once", async () => {
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let conversation = "conversation-1";
		const session = makeCodexSession(
			async () =>
				codexUsageReport({
					sevenDayPercent: 60,
					sevenDayResetAt,
					savedResets: 1,
					creditExpiresAt: [Date.now() + 6 * 3_600_000],
				}),
			undefined,
			() => conversation,
		);
		const component = new StatusLineComponent(session, statusLineHost);
		const notices: string[] = [];
		component.setResetExpiryNoticeHandler(notice => notices.push(notice));

		await refreshUsage(component);
		conversation = "conversation-2"; // /new
		await refreshUsage(component, 5 * 60_000);
		conversation = "conversation-3"; // /resume of a conversation not warned yet
		await refreshUsage(component, 5 * 60_000);
		conversation = "conversation-1"; // /resume of the first one
		await refreshUsage(component, 5 * 60_000);

		expect(notices).toHaveLength(3);
		component.dispose();
	});

	it("does not warn again when focus moves to a subagent and back", async () => {
		let fetches = 0;
		const reports = async () => {
			fetches++;
			return codexUsageReport({
				sevenDayPercent: 60,
				sevenDayResetAt: Date.now() + 80 * 3_600_000,
				savedResets: 1,
				creditExpiresAt: [Date.now() + 6 * 3_600_000],
			});
		};
		const main = makeCodexSession(reports);
		const subagent = makeCodexSession(reports, undefined, () => "subagent-1");
		const component = new StatusLineComponent(main, statusLineHost);
		const notices: string[] = [];
		component.setResetExpiryNoticeHandler(notice => notices.push(notice));

		await refreshUsage(component);
		component.setSession(subagent, "agent-1");
		await refreshUsage(component);
		component.setSession(main);
		await refreshUsage(component);

		expect(fetches).toBe(3);
		expect(notices).toHaveLength(1);
		component.dispose();
	});

	it("does not warn about a reset that expires in more than 24 hours", async () => {
		const state: CodexUsageState = {
			sevenDayPercent: 60,
			sevenDayResetAt: Date.now() + 80 * 3_600_000,
			savedResets: 1,
			creditExpiresAt: [Date.now() + 25 * 3_600_000],
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		component.updateSettings({ preset: "custom", leftSegments: ["usage"], rightSegments: [] });
		const notices: string[] = [];
		component.setResetExpiryNoticeHandler(notice => notices.push(notice));

		await refreshUsage(component);

		expect(plain(component.getTopBorder(120).content)).toContain("▲ 1 exp 1d 1h");
		expect(notices).toEqual([]);
		component.dispose();
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
				oauth: {
					identity: () => ({
						email: "shared@example.com",
						accountId: "account-shared",
						orgId,
					}),
				},
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession, statusLineHost);

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
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		expect(cfgTuiCodexResetFireworks.get(Settings.instance)).toBe(false);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const nextSevenDayResetAt = sevenDayResetAt + 7 * 24 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
			tier: "spark",
			plan: "pro",
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
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
			statusLineHost,
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
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
			statusLineHost,
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 18,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
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
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
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
			statusLineHost,
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
