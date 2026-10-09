import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgStallRemindersEnabled,
	cfgStallRemindersIntervalMinutes,
	cfgStallRemindersPolicy,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { StallReportCollector, type StallReport } from "@oh-my-pi/pi-coding-agent/session/stall-report";
import { StallReminderController } from "@oh-my-pi/pi-coding-agent/session/stall-reminders";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];
const marker = "Periodic main-agent diagnostic assessment";
const originalCollect = StallReportCollector.prototype.collect;

// These integration cases use the real AgentSession platform timer and await collection/provider
// signals; deterministic timer arithmetic and repeated missed intervals are covered by ManualClock.
describe("AgentSession periodic stall reminder delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let sampled: PromiseWithResolvers<void>;
	let reports: StallReport[];
	let commits: number;
	let collectCalls: number;
	let restoreCollector: () => void;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-stall-reminders-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		sampled = Promise.withResolvers<void>();
		reports = [];
		commits = 0;
		collectCalls = 0;
		// Keep real collection/telemetry; observe the receipt without replacing the report.
		const observer = spyOn(StallReportCollector.prototype, "collect").mockImplementation(
			async function (this: StallReportCollector) {
				collectCalls++;
				const report = await originalCollect.call(this);
				const commit = report.commit;
				report.commit = () => {
					commits++;
					commit.call(report);
				};
				reports.push(report);
				sampled.resolve();
				return report;
			},
		);
		restoreCollector = () => observer.mockRestore();
	});

	afterEach(async () => {
		await session?.dispose();
		restoreCollector();
		authStorage.close();
		tempDir.removeSync();
		session = undefined;
	});

	function createSession(options?: { tool?: AgentTool; kind?: "main" | "sub"; persistent?: boolean }) {
		const model = createMockModel({ provider: "openai", id: "gpt-stall-test" }).model;
		const contexts: Context[] = [];
		const diagnosticFlags: boolean[] = [];
		const providerCalled = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
			"stallReminders.intervalMinutes": 0.0005,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: options?.tool ? [options.tool] : [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push({ ...context, messages: [...context.messages] });
				diagnosticFlags.push(session?.isStallDiagnosticTurn() ?? false);
				providerCalled.resolve();
				const firstTool = options?.tool && contexts.length === 1;
				const message: AssistantMessage = {
					role: "assistant",
					content: firstTool
						? [{ type: "toolCall", id: "slow-0", name: options.tool!.name, arguments: {} }]
						: [{ type: "text", text: "Assessment complete." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: firstTool ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: firstTool ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: options?.persistent
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"))
				: SessionManager.inMemory(tempDir.path()),
			toolRegistry: new Map(options?.tool ? [[options.tool.name, options.tool]] : []),
			agentKind: options?.kind ?? "main",
			memoryEnabled: false,
		});
		return { settings, contexts, diagnosticFlags, providerCalled, session };
	}

	test("an enabled idle main wakes through an actual synthetic developer prompt without a user submission", async () => {
		const h = createSession();
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(h.providerCalled.promise, 3_000, "idle report never reached the provider");
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		await h.session.waitForIdle();
		expect(h.contexts).toHaveLength(1);
		expect(JSON.stringify(h.contexts[0]!.messages)).toContain(marker);
		const reminder = h.session.messages.find(message => JSON.stringify(message).includes(marker));
		expect(reminder).toMatchObject({
			role: "developer",
			attribution: "agent",
			synthetic: true,
			userInitiated: false,
		});
		expect(h.session.messages.some(message => message.role === "user")).toBe(false);
		expect(commits).toBe(1);
		expect(h.diagnosticFlags).toEqual([true]);
		expect(h.session.isStallDiagnosticTurn()).toBe(false);
		const diagnosticEntries = h.session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "stall_diagnostic_turn")
			.map(entry => (entry.type === "custom" ? entry.data : undefined));
		expect(diagnosticEntries).toEqual([{ state: "started" }, { state: "finished" }]);
		expect(JSON.stringify(h.contexts)).not.toContain("stall_diagnostic_turn");
	});

	test("a periodic report behind a hung foreground tool is one-slot, noninterrupting, and reaches the next provider boundary", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let aborted = false;
		const tool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Held foreground tool",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				signal?.addEventListener("abort", () => {
					aborted = true;
				});
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		const h = createSession({ tool });
		const run = h.session.prompt("perform the real task");
		await withTimeout(started.promise, 3_000, "foreground tool did not start");
		try {
			cfgStallRemindersEnabled.override(h.settings, true);
			await withTimeout(sampled.promise, 3_000, "busy report was not sampled");
			// Deliberately cross real platform intervals while an actual foreground tool is hung.
			// Fake time would not exercise the session's runtime timer/boundary interaction here.
			await Bun.sleep(120);
			expect(collectCalls).toBe(1);
			expect(commits).toBe(0);
			expect(aborted).toBe(false);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
			expect(h.session.messages.some(message => JSON.stringify(message).includes(marker))).toBe(false);
		} finally {
			release.resolve();
		}
		await run;
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		expect(aborted).toBe(false);
		expect(JSON.stringify(h.contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(h.contexts[1]!.messages)).toContain(marker);
		expect(reports[0]!.text).toContain("Sampled at");
		expect(commits).toBe(1);
		expect(h.diagnosticFlags.every(flag => !flag)).toBe(true);
		expect(
			h.session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "stall_diagnostic_turn"),
		).toBe(false);
	});

	test("a report deferred by real foreground bash wakes automatically after that command settles", async () => {
		const h = createSession();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				started.resolve();
				await release.promise;
				return new Response("FOREGROUND_DONE");
			},
		});
		const code = `fetch(${JSON.stringify(server.url.href)}).then(response => response.text()).then(text => process.stdout.write(text))`;
		const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${code.replaceAll("'", "'\\''")}'`;
		const foreground = h.session.executeBash(command);
		try {
			await withTimeout(started.promise, 5_000, "foreground subprocess did not reach its gate");
			cfgStallRemindersEnabled.override(h.settings, true);
			await withTimeout(sampled.promise, 3_000, "foreground-blocked report was not sampled");
			await setImmediate();
			expect(h.session.isBashRunning).toBe(true);
			expect(h.contexts).toHaveLength(0);
			expect(commits).toBe(0);
			release.resolve();
			const result = await foreground;
			expect(result.output).toContain("FOREGROUND_DONE");
			// Await the real one-shot retry/provider event, never a guessed wall-clock sleep.
			await withTimeout(h.providerCalled.promise, 3_000, "report did not wake after foreground bash settled");
			cfgStallRemindersEnabled.override(h.settings, false);
			await setImmediate();
			await h.session.waitForIdle();
			expect(h.contexts).toHaveLength(1);
			expect(JSON.stringify(h.contexts[0]!.messages)).toContain(marker);
			expect(JSON.stringify(h.contexts[0]!.messages)).toContain("FOREGROUND_DONE");
			expect(commits).toBe(1);
			expect(collectCalls).toBe(1);
		} finally {
			release.resolve();
			await foreground.catch(() => {});
			server.stop(true);
		}
	});

	test.each(["plan", "hold"] as const)(
		"a report parked by %s wakes after that gate releases into real foreground bash",
		async gate => {
			const h = createSession();
			let hold = gate === "hold" ? h.session.holdStallReminderDelivery() : undefined;
			if (gate === "plan") h.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch() {
					started.resolve();
					await release.promise;
					return new Response("TRANSITION_FOREGROUND_DONE");
				},
			});
			const code = `fetch(${JSON.stringify(server.url.href)}).then(response => response.text()).then(text => process.stdout.write(text))`;
			const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${code.replaceAll("'", "'\\''")}'`;
			let foreground: Promise<BashResult> | undefined;
			try {
				cfgStallRemindersEnabled.override(h.settings, true);
				await withTimeout(sampled.promise, 3_000, "parked report was not sampled");
				await setImmediate();
				expect(h.contexts).toHaveLength(0);
				expect(commits).toBe(0);
				foreground = h.session.executeBash(command);
				await withTimeout(started.promise, 5_000, "transition foreground subprocess did not reach its gate");
				if (gate === "plan") {
					hold = h.session.holdStallReminderDelivery();
					h.session.setPlanModeState(undefined);
				}
				hold![Symbol.dispose]();
				hold = undefined;
				expect(h.session.isBashRunning).toBe(true);
				expect(collectCalls).toBe(1);
				expect(commits).toBe(0);
				release.resolve();
				expect((await foreground).output).toContain("TRANSITION_FOREGROUND_DONE");
				await withTimeout(
					h.providerCalled.promise,
					3_000,
					"parked report did not wake after foreground settlement",
				);
				cfgStallRemindersEnabled.override(h.settings, false);
				await setImmediate();
				await h.session.waitForIdle();
				expect(h.contexts).toHaveLength(1);
				expect(JSON.stringify(h.contexts[0]!.messages)).toContain(JSON.stringify(reports[0]!.text));
				expect(JSON.stringify(h.contexts[0]!.messages)).toContain("TRANSITION_FOREGROUND_DONE");
				expect(commits).toBe(1);
			} finally {
				release.resolve();
				hold?.[Symbol.dispose]();
				await foreground?.catch(() => {});
				server.stop(true);
			}
		},
	);

	test("protocol deferral keeps one report uncommitted and delivers it only inside a client-owned prompt", async () => {
		const h = createSession();
		h.session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "deferred report was not sampled");
		await setImmediate();
		await h.session.waitForIdle();
		expect(h.contexts).toHaveLength(0);
		expect(collectCalls).toBe(1);
		expect(commits).toBe(0);
		expect(h.session.messages).toHaveLength(0);
		await h.session.prompt("client-owned continuation");
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		expect(JSON.stringify(h.contexts.at(-1)!.messages)).toContain(marker);
		expect(commits).toBe(1);
	});

	test("plan mode parks a reminder, and completed host-scoped plan exit wakes it without a user prompt", async () => {
		const h = createSession();
		h.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "plan-mode report was not sampled");
		await setImmediate();
		await h.session.waitForIdle();
		expect(h.contexts).toHaveLength(0);
		expect(commits).toBe(0);
		{
			using _stallReminderDelivery = h.session.holdStallReminderDelivery();
			h.session.setPlanModeState(undefined);
			await setImmediate();
			await h.session.waitForIdle();
			expect(h.contexts).toHaveLength(0);
			expect(commits).toBe(0);
		}
		await withTimeout(h.providerCalled.promise, 3_000, "report did not wake after leaving plan mode");
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		await h.session.waitForIdle();
		expect(h.session.messages.some(message => message.role === "user")).toBe(false);
		expect(JSON.stringify(h.contexts.at(-1)!.messages)).toContain(marker);
		expect(commits).toBe(1);
	});

	test("nested host holds cannot release a pending reminder early, even when an inner hold is disposed twice", async () => {
		const h = createSession();
		h.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "held report was not sampled");
		await setImmediate();
		const outer = h.session.holdStallReminderDelivery();
		const inner = h.session.holdStallReminderDelivery();
		try {
			h.session.setPlanModeState(undefined);
			inner[Symbol.dispose]();
			inner[Symbol.dispose]();
			await setImmediate();
			await h.session.waitForIdle();
			expect(h.contexts).toHaveLength(0);
			expect(commits).toBe(0);
		} finally {
			inner[Symbol.dispose]();
			outer[Symbol.dispose]();
		}
		await withTimeout(h.providerCalled.promise, 3_000, "outer hold did not release reminder delivery");
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		await h.session.waitForIdle();
		expect(commits).toBe(1);
	});

	test("an approved execution turn receives its report aside while the host still holds autonomous reminders", async () => {
		const h = createSession();
		h.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "approval report was not sampled");
		await setImmediate();
		{
			using _stallReminderDelivery = h.session.holdStallReminderDelivery();
			h.session.setPlanModeState(undefined);
			await h.session.prompt("approved execution", { synthetic: true, expandPromptTemplates: false });
			cfgStallRemindersEnabled.override(h.settings, false);
			await setImmediate();
			expect(JSON.stringify(h.contexts.at(-1)!.messages)).toContain(marker);
			expect(h.diagnosticFlags.every(flag => !flag)).toBe(true);
			expect(commits).toBe(1);
		}
	});

	test("a deliberate Esc remains authoritative until a real user prompt resumes work", async () => {
		const h = createSession();
		await h.session.abort({ reason: USER_INTERRUPT_LABEL });
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "post-interrupt report was not sampled");
		await setImmediate();
		await h.session.waitForIdle();
		expect(h.contexts).toHaveLength(0);
		expect(commits).toBe(0);
		await h.session.prompt("resume deliberately");
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		expect(JSON.stringify(h.contexts.at(-1)!.messages)).toContain(marker);
		expect(commits).toBe(1);
	});

	test("unfinished-only does not wake a truly idle main without work", async () => {
		const h = createSession();
		cfgStallRemindersPolicy.override(h.settings, "unfinished-only");
		cfgStallRemindersEnabled.override(h.settings, true);
		await withTimeout(sampled.promise, 3_000, "idle state was not assessed");
		await setImmediate();
		await h.session.waitForIdle();
		cfgStallRemindersEnabled.override(h.settings, false);
		await setImmediate();
		expect(h.contexts).toHaveLength(0);
		expect(commits).toBe(0);
		expect(reports.every(report => !report.hasUnfinishedWork)).toBe(true);
	});

	for (const transition of ["new", "reset", "switch"] as const) {
		test(`${transition} discards the outgoing session report without committing or leaking it`, async () => {
			const h = createSession({ persistent: transition === "switch" });
			h.session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			cfgStallRemindersEnabled.override(h.settings, true);
			await withTimeout(sampled.promise, 3_000, "outgoing report was not sampled");
			await setImmediate();
			const oldText = reports[0]!.text;
			if (transition === "new") {
				expect(await h.session.newSession()).toBe(true);
			} else if (transition === "reset") {
				expect(await h.session.resetSessionContext()).toBeDefined();
			} else {
				const target = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
				target.appendMessage({ role: "user", content: "target branch", timestamp: Date.now() });
				await target.ensureOnDisk();
				const targetFile = target.getSessionFile();
				if (!targetFile) throw new Error("Expected target session file");
				await target.close();
				expect(await h.session.switchSession(targetFile)).toBe(true);
			}
			cfgStallRemindersEnabled.override(h.settings, false);
			await setImmediate();
			await h.session.prompt("fresh context");
			expect(commits).toBe(0);
			expect(JSON.stringify(h.contexts)).not.toContain(oldText);
			expect(h.session.messages.some(message => JSON.stringify(message).includes(marker))).toBe(false);
		});
	}

	test("subagent sessions never configure the reminder controller even when the inherited setting is enabled", async () => {
		const configure = spyOn(StallReminderController.prototype, "configure");
		try {
			const h = createSession({ kind: "sub" });
			cfgStallRemindersIntervalMinutes.override(h.settings, 0.0001);
			cfgStallRemindersEnabled.override(h.settings, true);
			await setImmediate();
			expect(configure).not.toHaveBeenCalled();
			expect(collectCalls).toBe(0);
			expect(h.contexts).toHaveLength(0);
		} finally {
			configure.mockRestore();
		}
	});

	test("beginDispose synchronously removes enabled collector tracking", async () => {
		const h = createSession();
		const dispose = spyOn(StallReportCollector.prototype, "dispose");
		try {
			cfgStallRemindersEnabled.override(h.settings, true);
			await setImmediate();
			h.session.beginDispose();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(collectCalls).toBe(0);
			expect(h.contexts).toHaveLength(0);
		} finally {
			dispose.mockRestore();
		}
	});
});
