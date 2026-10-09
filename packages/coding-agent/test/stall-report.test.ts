import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { Settings } from "../src/config/settings";
import { AsyncJobManager } from "../src/async/job-manager";
import * as brokerClients from "../src/launch/client";
import type { DaemonBrokerClient } from "../src/launch/client";
import type { DaemonCompletionNotification } from "../src/launch/protocol";
import { AgentRegistry } from "../src/registry/agent-registry";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import * as sessionLoader from "../src/session/session-loader";
import { StallReportCollector } from "../src/session/stall-report";
import type { ToolSession } from "../src/tools";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

interface Fixture {
	session: AgentSession;
	sessionManager: SessionManager;
	tool: ToolSession;
	setTodos(value: TodoPhase[]): void;
	append(
		text: string,
		options?: { tool?: string; toolCount?: number; id?: string; timestamp?: number; thinking?: string },
	): string;
}

function fixture(registry: AgentRegistry, id = "Main", launch = false): Fixture {
	const sessionManager = SessionManager.inMemory("/stall-test");
	let phases: TodoPhase[] = [];
	const listeners = new Set<(value: TodoPhase[]) => void>();
	const tool = {
		cwd: "/stall-test",
		settings: Settings.isolated({ "launch.enabled": launch }),
		agentRegistry: registry,
		getAgentId: () => id,
		getSessionId: () => sessionManager.getSessionId(),
	} as unknown as ToolSession;
	const session = {
		sessionManager,
		isStreaming: false,
		messages: [],
		getAgentId: () => id,
		getStallReportToolSession: () => tool,
		getTodoPhases: () => structuredClone(phases),
		subscribeTodoChanges: (listener: (value: TodoPhase[]) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AgentSession;
	return {
		session,
		sessionManager,
		tool,
		setTodos(value: TodoPhase[]) {
			phases = structuredClone(value);
			for (const listener of listeners) listener(structuredClone(value));
		},
		append(
			text: string,
			options: { tool?: string; toolCount?: number; id?: string; timestamp?: number; thinking?: string } = {},
		) {
			const content: AssistantMessage["content"] = [{ type: "text", text }];
			if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
			if (options.tool)
				for (let index = 0; index < (options.toolCount ?? 1); index++)
					content.push({
						type: "toolCall",
						id: `${options.id ?? "call"}${options.toolCount ? `-${index}` : ""}`,
						name: options.tool,
						arguments: { secret: "DO-NOT-REPORT-ARGS" },
					});
			return sessionManager.appendMessage({
				role: "assistant",
				content,
				timestamp: options.timestamp ?? Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		},
	};
}
function register(registry: AgentRegistry, value: Fixture, parentId?: string, rootId?: string) {
	const id = value.session.getAgentId();
	if (id === undefined) throw new Error("Fixture must supply an agent ID");
	return registry.register({
		id,
		displayName: id,
		kind: parentId ? "sub" : "main",
		parentId,
		rootSessionId: rootId ?? value.sessionManager.getSessionId(),
		session: value.session,
		status: "idle",
	});
}
function collector(value: Fixture) {
	const report = new StallReportCollector(value.session);
	cleanups.push(() => report.dispose());
	return report;
}

describe("stall report collection", () => {
	it("lists only this main and its actual descendants, with active/idle state and retained parked changes", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const child = fixture(registry, "Child");
		const childRef = register(registry, child, "Main", main.sessionManager.getSessionId());
		const nested = fixture(registry, "Nested");
		register(registry, nested, "Child", main.sessionManager.getSessionId());
		Object.defineProperty(nested.session, "isStreaming", { value: true });
		const unrelated = fixture(registry, "UnrelatedMain");
		register(registry, unrelated);
		register(registry, fixture(registry, "OldSessionChild"), "Main", "previous-main-session");
		registry.register({ id: "Advisor", displayName: "Advisor", kind: "advisor", parentId: "Main", session: null });
		const report = collector(main);
		registry.detachSession("Child", childRef);
		registry.setStatus("Child", "parked", childRef);
		const retained = await report.collect();
		const text = retained.text;
		expect(text).toContain("Active 1; idle 1; parked 1");
		expect(text).toContain("status_changed: “Child” → parked");
		expect(text).toContain("### “Nested”");
		expect(text).not.toContain("UnrelatedMain");
		expect(text).not.toContain("OldSessionChild");
		expect(text).not.toContain("Advisor");
		expect((await report.collect()).text).toContain("### “Child”");
		retained.commit();
		expect((await report.collect()).text).not.toContain("### “Child”");
	});

	it("excludes unchanged historical parked/aborted refs without reading their transcripts", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		for (const status of ["parked", "aborted"] as const)
			registry.register({
				id: `Historical-${status}`,
				displayName: `Historical-${status}`,
				kind: "sub",
				parentId: "Main",
				rootSessionId: main.sessionManager.getSessionId(),
				session: null,
				sessionFile: `/nonexistent-historical-${status}.jsonl`,
				status,
			});
		const loader = vi.spyOn(sessionLoader, "loadEntriesFromFile");
		const headers = vi.spyOn(sessionLoader, "visitEntriesFromFileStream");
		const report = collector(main);
		for (let index = 0; index < 2; index++) {
			const result = await report.collect();
			expect(result.text).not.toContain("Historical-");
			expect(result.text).toContain("Candidate agents 1; listed agent sections 1; omitted agent sections 0");
			result.commit();
		}
		expect(loader).not.toHaveBeenCalled();
		expect(headers).not.toHaveBeenCalled();
	});

	it("caps known roster sections at 100 before reading transcripts and prioritizes main, active, stale and changed refs", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const children: Fixture[] = [];
		const branchReads = [];
		for (let index = 0; index < 130; index++) {
			const child = fixture(registry, `Child-${index}`);
			const ref = register(registry, child, "Main", main.sessionManager.getSessionId());
			ref.lastActivity = index;
			children.push(child);
			branchReads.push(vi.spyOn(child.sessionManager, "getBranch"));
		}
		const stale = registry.register({
			id: "StaleRunning",
			displayName: "StaleRunning",
			kind: "sub",
			parentId: "Main",
			rootSessionId: main.sessionManager.getSessionId(),
			session: null,
			status: "running",
		});
		for (let index = 0; index < 150; index++)
			registry.register({
				id: `Historical-${index}`,
				displayName: "Historical",
				kind: "sub",
				parentId: "Main",
				rootSessionId: main.sessionManager.getSessionId(),
				session: null,
				sessionFile: `/nonexistent-historical-${index}.jsonl`,
				status: "parked",
			});
		const loader = vi.spyOn(sessionLoader, "loadEntriesFromFile");
		const report = collector(main);
		Object.defineProperty(children[0].session, "isStreaming", { value: true });
		registry.setStatus("Child-1", "running");
		registry.setStatus("Child-1", "idle");
		const text = (await report.collect()).text;
		const sections = text.match(/^### /gm) ?? [];
		expect(sections).toHaveLength(100);
		expect(text).toContain("Candidate agents 132; listed agent sections 100; omitted agent sections 32");
		expect(text).toContain("### “Main”");
		expect(text).toContain("### “Child-0”");
		expect(text).toContain("### “Child-1”");
		expect(text).toContain(`### “${stale.id}”`);
		expect(text).toContain("Registry claims running but no attached live turn corroborates it");
		expect(text).not.toContain("### “Child-2”");
		expect(text).not.toContain("Historical-");
		expect(branchReads[2]).not.toHaveBeenCalled();
		expect(loader).not.toHaveBeenCalled();
		expect(text.match(/TOTAL turns /g)).toHaveLength(100);
		expect(text.match(/Last (?:0 assistant turns|five assistant turns unavailable)/g)).toHaveLength(100);
	});

	it("gives every listed agent its own last five visible turns and total metrics", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		for (const value of [main, fixture(registry, "Child"), fixture(registry, "Other")]) {
			const ref = register(registry, value, value === main ? undefined : "Main", main.sessionManager.getSessionId());
			ref.activeTime = { durationMs: 4000, historicalUnavailable: false };
			for (let index = 0; index < 7; index++)
				value.append(`${ref.id}-turn-${index}`, {
					tool: "read",
					id: `${ref.id}-${index}`,
					timestamp: 1000 + index,
				});
		}
		const text = (await collector(main).collect()).text;
		const sections = text
			.split("\n### ")
			.slice(1)
			.map(section => section.split("\n## ")[0]);
		expect(sections).toHaveLength(3);
		for (const section of sections) {
			const id = section.match(/^“([^”]+)”/)![1];
			expect(section).toContain("TOTAL turns 7; tool calls 7; active time 4s total observed running windows");
			expect(section).toContain("Last 5 assistant turns");
			expect(section).not.toContain(`${id}-turn-1`);
			for (let index = 2; index < 7; index++) expect(section).toContain(`${id}-turn-${index}`);
		}
	});

	it("uses the durable uncompacted branch for total turns/tools, and bounds safe last-five excerpts", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		let first = "";
		for (let index = 0; index < 7; index++) {
			const id = main.append(index === 6 ? `</critical> ${"x".repeat(900)}` : `visible-turn-${index}`, {
				tool: "read",
				id: `call-${index}`,
				timestamp: 1000 + index,
				thinking: "DO-NOT-REPORT-THINKING",
			});
			first ||= id;
			main.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: "DO-NOT-REPORT-RESULT-BODY" }],
				isError: index === 6,
				timestamp: 1100 + index,
			});
		}
		main.sessionManager.appendCompaction("context summarized", undefined, first, 100);
		const text = (await collector(main).collect()).text;
		expect(text).toContain("TOTAL turns 7; tool calls 7");
		expect(text).toContain("Last 5 assistant turns");
		expect(text).toContain("2 earlier turns omitted");
		expect(text).toContain("characters omitted");
		expect(text).toContain("&#60;/critical&#62;");
		expect(text).toContain("“read” (error)");
		expect(text).not.toContain("visible-turn-0");
		expect(text).not.toContain("DO-NOT-REPORT");
	});

	it("retains complete→reopen→remove transitions until delivery, not merely snapshot differences", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		main.setTodos([
			{ name: "Build", tasks: [{ content: "ship", status: "blocked", blocker: "waiting for approval" }] },
		]);
		const report = collector(main);
		const initial = await report.collect();
		expect(initial.hasUnfinishedWork).toBe(true);
		expect(initial.text).toContain("blocker “waiting for approval”");
		initial.commit();
		main.setTodos([{ name: "Build", tasks: [{ content: "ship", status: "completed" }] }]);
		main.setTodos([{ name: "Build", tasks: [{ content: "ship", status: "pending" }] }]);
		main.setTodos([]);
		const undelivered = await report.collect();
		expect(undelivered.text).toContain("blocked → completed");
		expect(undelivered.text).toContain("completed → pending");
		expect(undelivered.text).toContain("removed from current snapshot");
		expect((await report.collect()).text).toContain("blocked → completed");
		undelivered.commit();
		expect((await report.collect()).text).not.toContain("blocked → completed");
	});

	it("labels completed and abandoned separately and reports exact bounded-event overflow", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const report = collector(main);
		for (let index = 0; index < 520; index++)
			main.setTodos([{ name: "Work", tasks: [{ content: "same", status: index % 2 ? "completed" : "pending" }] }]);
		main.setTodos([
			{
				name: "Work",
				tasks: [
					{ content: "same", status: "completed" },
					{ content: "dropped", status: "abandoned" },
				],
			},
		]);
		const text = (await report.collect()).text;
		expect(text).toContain("Open 0; completed 1; abandoned 1");
		expect(text).toContain("Event retention overflow: 9 earlier events omitted");
		expect(text).toContain("rows omitted");
	});

	it("advances metric deltas only after commit and rebases branches instead of inventing negative totals", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		const ref = register(registry, main);
		ref.activeTime = { durationMs: 1000, historicalUnavailable: false };
		const first = main.append("first");
		const report = collector(main);
		(await report.collect()).commit();
		main.append("second", { tool: "write" });
		ref.activeTime.durationMs = 3000;
		const next = await report.collect();
		expect(next.text).toContain("since reminder turns +1, tools +1, active +2s");
		const same = await report.collect();
		expect(same.text).toContain("since reminder turns +1");
		next.commit();
		main.sessionManager.branch(first);
		main.append("different branch");
		const branched = await report.collect();
		expect(branched.text).toContain("Branch changed: counter deltas are unavailable");
		expect(branched.text).not.toContain("turns +-");
	});

	it("does not substitute wall span for unavailable historical active windows", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		const ref = register(registry, main);
		main.append("historical", { timestamp: 1 });
		ref.createdAt = 1;
		ref.activeTime = { durationMs: 4000, historicalUnavailable: true };
		const text = (await collector(main).collect()).text;
		expect(text).toContain("active time 4s observed; historical running windows unavailable (partial total)");
	});

	it("retains terminal jobs after manager eviction, without consuming or rerouting delivery", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		vi.useFakeTimers();
		cleanups.push(() => {
			vi.useRealTimers();
		});
		const manager = new AsyncJobManager({ retentionMs: 0 });
		Object.defineProperty(main.session, "asyncJobManager", { value: manager });
		cleanups.push(async () => {
			await manager.dispose();
		});
		const report = collector(main);
		const id = manager.register("task", "finished-fast", async () => "done", { ownerId: "Main" });
		await manager.getJob(id)!.promise;
		vi.advanceTimersByTime(1);
		expect(manager.getJob(id)).toBeUndefined();
		expect((await report.collect()).text).toContain("finished-fast”");
		expect((await report.collect()).text).toContain("[task] completed");
	});

	it("observes owned service exits beyond the capped list and ignores unrelated owners", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry, "Main", true);
		register(registry, main);
		const observers = new Set<(notification: DaemonCompletionNotification) => void>();
		const client = {
			observeOwners(_owners: readonly string[], listener: (notification: DaemonCompletionNotification) => void) {
				observers.add(listener);
				return () => observers.delete(listener);
			},
			async request(operation: { op: string }) {
				return operation.op === "list" ? { op: "list", daemons: [] } : { op: "ping", projectDir: "/stall-test" };
			},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		const report = collector(main);
		(await report.collect()).commit();
		const snapshot: DaemonSnapshot = {
			id: "service-id",
			name: "old-finished",
			owner: main.sessionManager.getSessionId(),
			state: "failed",
			createdAt: 1,
			startedAt: 1,
			exitedAt: 2,
			exitCode: 3,
			outputBytes: 9,
			restartCount: 2,
			persist: false,
			detached: false,
		};
		for (const observer of observers)
			observer({ event: "daemon-completed", completionId: "terminal", owner: snapshot.owner!, daemon: snapshot });
		for (const observer of observers)
			observer({
				event: "daemon-completed",
				completionId: "unrelated",
				owner: "different-session",
				daemon: { ...snapshot, name: "unrelated-service" },
			});
		const text = (await report.collect()).text;
		expect(text).toContain("old-finished” [service] failed");
		expect(text).toContain("restarts 2");
		expect(text).toContain("exit code 3");
		expect(text).not.toContain("unrelated-service");
		report.dispose();
		expect(observers.size).toBe(0);
	});

	it("reports source failure rather than an authoritative empty list", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry, "Main", true);
		register(registry, main);
		vi.spyOn(brokerClients, "daemonClientForProject").mockRejectedValue(new Error("broker unavailable"));
		const text = (await collector(main).collect()).text;
		expect(text).toContain("Service source unavailable");
		expect(text).toContain("broker unavailable");
	});

	it("loads parked branch ancestry once, preserving compaction counts but excluding abandoned branches", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const child = fixture(registry, "ParkedChild");
		const first = child.append("root-turn");
		child.append("abandoned-turn");
		child.sessionManager.branch(first);
		child.append("current-turn", { tool: "read" });
		const directory = await mkdtemp(path.join(os.tmpdir(), "stall-transcript-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const file = path.join(directory, "child.jsonl");
		await writeFile(
			file,
			[child.sessionManager.getHeader(), ...child.sessionManager.getEntries()]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);
		const loader = vi.spyOn(sessionLoader, "loadEntriesFromFile");
		const report = collector(main);
		registry.register({
			id: "ParkedChild",
			displayName: "ParkedChild",
			kind: "sub",
			parentId: "Main",
			rootSessionId: main.sessionManager.getSessionId(),
			session: null,
			sessionFile: file,
			status: "parked",
		});
		const text = (await report.collect()).text;
		expect(text).toContain("TOTAL turns 2; tool calls 1");
		expect(text).toContain("current-turn");
		expect(text).not.toContain("abandoned-turn");
		await report.collect();
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it("reports unreadable parked history precisely instead of zero totals", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const report = collector(main);
		registry.register({
			id: "MissingHistory",
			displayName: "MissingHistory",
			kind: "sub",
			parentId: "Main",
			rootSessionId: main.sessionManager.getSessionId(),
			session: null,
			sessionFile: "/nonexistent-stall-test-transcript.jsonl",
			status: "parked",
		});
		const text = (await report.collect()).text;
		expect(text).toContain("TOTAL turns unavailable; tool calls unavailable; active time unavailable");
		expect(text).toContain("Transcript unavailable");
		expect(text).toContain("Last five assistant turns unavailable");
	});

	it("counts diagnostic-only replies without resetting useful activity freshness or unfinished work", async () => {
		vi.spyOn(Date, "now").mockReturnValue(900_000);
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		main.append("real work", { timestamp: 100_000 });
		main.sessionManager.appendCustomEntry("stall_diagnostic_turn", { state: "started" });
		main.append("diagnostic tool call", { tool: "read", id: "diagnostic-read", timestamp: 850_000 });
		main.sessionManager.appendCustomEntry("tool_execution_start", {
			toolCallId: "diagnostic-read",
			startedAt: new Date(860_000).toISOString(),
			intent: "inspect diagnostic state",
		});
		Object.defineProperty(main.session, "isStreaming", { value: true });
		Object.defineProperty(main.session, "isStallDiagnosticTurn", { value: () => true });
		const report = collector(main);
		const pending = await report.collect();
		expect(pending.text).toContain("Pending/unpaired tool “read”; execution marker age 40s");
		expect(pending.text).toContain("Last observable non-diagnostic activity 800s ago");
		main.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "diagnostic-read",
			toolName: "read",
			content: [{ type: "text", text: "diagnostic result" }],
			isError: false,
			timestamp: 870_000,
		});
		main.append("diagnostic continuation", { timestamp: 900_000 });
		const result = await report.collect();
		expect(result.hasUnfinishedWork).toBe(false);
		expect(result.text).toContain("TOTAL turns 3; tool calls 1");
		expect(result.text).toContain("active (diagnostic-only)");
		expect(result.text).toContain("Last observable non-diagnostic activity 800s ago");
		expect(result.text).toContain("Diagnostic-only assistant responses 2");
		expect(result.text).toContain("diagnostic tool call");
		expect(result.text).toContain("diagnostic continuation");
		expect(result.text).toContain("“read” (returned)");
		expect(result.text).not.toContain("Pending/unpaired tool");
	});

	it("ends a crash-left diagnostic window on a subsequent actual user prompt", async () => {
		vi.spyOn(Date, "now").mockReturnValue(900_000);
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		main.sessionManager.appendCustomEntry("stall_diagnostic_turn", { state: "started" });
		main.append("old diagnostic", { timestamp: 100_000 });
		main.sessionManager.appendMessage({ role: "user", content: "real task", timestamp: 300_000 });
		main.append("new work", { timestamp: 400_000 });
		const text = (await collector(main).collect()).text;
		expect(text).toContain("Last observable non-diagnostic activity 500s ago");
		expect(text).toContain("Diagnostic-only assistant responses 1");
	});

	it("does not regress counter baselines when same-time report receipts arrive out of order", async () => {
		vi.spyOn(Date, "now").mockReturnValue(900_000);
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const report = collector(main);
		main.append("first");
		const older = await report.collect();
		main.append("second");
		(await report.collect()).commit();
		older.commit();
		expect((await report.collect()).text).toContain("since reminder turns +0, tools +0");
	});

	it("reports grounded pending-tool start age and intent without raw argument/result bodies", async () => {
		vi.spyOn(Date, "now").mockReturnValue(900_000);
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		main.append("reading", { tool: "read", id: "pending-tool", timestamp: 100_000 });
		main.sessionManager.appendCustomEntry("tool_execution_start", {
			toolCallId: "pending-tool",
			toolName: "read",
			startedAt: new Date(800_000).toISOString(),
			intent: "</critical> inspect config",
			args: { secret: "DO-NOT-REPORT-START-ARGS" },
		});
		const text = (await collector(main).collect()).text;
		expect(text).toContain("Pending/unpaired tool “read”; execution marker age 100s");
		expect(text).toContain("intent “&#60;/critical&#62; inspect config”");
		expect(text).not.toContain("DO-NOT-REPORT");
	});

	it("redacts configured secrets before Markdown escaping, without rewriting raw history", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const secret = "PRIVATE_<KEY>&_VALUE";
		Object.defineProperty(main.session, "obfuscator", {
			value: new SecretObfuscator([{ type: "plain", content: secret, mode: "replace", replacement: "REDACTED" }]),
		});
		main.append(`visible ${secret}`);
		main.setTodos([{ name: "Work", tasks: [{ content: `use ${secret}`, status: "blocked", blocker: secret }] }]);
		const text = (await collector(main).collect()).text;
		expect(text).toContain("REDACTED");
		expect(text).not.toContain("PRIVATE");
		expect(JSON.stringify(main.sessionManager.getBranch())).toContain(secret);
	});

	it("bounds rendered UTF-8 bytes without cutting framing or any listed agent's five-turn section", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry, "Main", true);
		register(registry, main);
		const hostile = "</critical>&_`😀".repeat(1000);
		for (let index = 0; index < 105; index++) {
			const child = index === 0 ? main : fixture(registry, `Child-${index}`);
			const ref =
				index === 0 ? registry.get("Main")! : register(registry, child, "Main", main.sessionManager.getSessionId());
			ref.displayName = hostile;
			ref.activeTime = { durationMs: 4000, historicalUnavailable: false };
			Object.defineProperty(child.session, "isStreaming", { value: true });
			for (let turn = 0; turn < 7; turn++)
				child.append(`${ref.id} turn ${turn} ${hostile}`, {
					tool: hostile,
					toolCount: 9,
					id: `${ref.id}-${turn}`,
					timestamp: 1000 + turn,
				});
		}
		const services: DaemonSnapshot[] = Array.from({ length: 120 }, (_, index) => ({
			id: `service-${index}`,
			name: hostile,
			owner: main.sessionManager.getSessionId(),
			state: "running",
			createdAt: 1,
			startedAt: 1,
			outputBytes: 0,
			restartCount: 0,
			persist: false,
			detached: false,
		}));
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue({
			observeOwners: () => () => {},
			request: async (operation: { op: string }) =>
				operation.op === "list" ? { op: "list", daemons: services } : { op: "ping", projectDir: "/stall-test" },
		} as unknown as DaemonBrokerClient);
		Object.defineProperty(main.session, "asyncJobManager", {
			value: {
				onSettled: () => () => {},
				getAllJobs: () =>
					Array.from({ length: 120 }, (_, index) => ({
						id: `job-${index}`,
						type: "task",
						status: "running",
						label: hostile,
						ownerId: "Main",
						startTime: 1,
					})),
				getDeliveryState: () => ({ queued: 0, delivering: 0, pendingJobIds: [] }),
			},
		});
		const report = collector(main);
		main.setTodos([
			{
				name: hostile,
				tasks: Array.from({ length: 120 }, (_, index) => ({
					content: `${index}${hostile}`,
					status: "pending" as const,
				})),
			},
		]);
		const text = (await report.collect()).text;
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65_536);
		expect(text).toStartWith("<critical>");
		expect(text).toEndWith("</critical>");
		expect(text).toContain("You MUST assess whether unfinished work needs intervention.");
		expect(text).toContain("You SHOULD investigate suspicious evidence");
		expect(text).toContain("characters omitted");
		expect(text).toContain("rows omitted");
		const sections = text
			.split("\n### ")
			.slice(1)
			.map(section => section.split("\n## ")[0]);
		expect(sections.length).toBeGreaterThan(0);
		expect(sections.length).toBeLessThan(100);
		expect(sections[0]).toStartWith("“Main”");
		expect(text).toContain(
			`Candidate agents 105; listed agent sections ${sections.length}; omitted agent sections ${105 - sections.length}`,
		);
		for (const section of sections) {
			expect(section).toContain("TOTAL turns 7; tool calls 63; active time 4s total observed running windows");
			expect(section).toContain("Last 5 assistant turns");
			expect(section.match(/^- \d{4}-/gm)).toHaveLength(5);
			expect(section.match(/\[1 tool calls omitted\]/g)).toHaveLength(5);
			expect(section.match(/\(no recorded result\)/g)).toHaveLength(40);
			expect(section).not.toMatch(/&#\d*$/);
		}
		expect(text.match(/<\/critical>/g)).toHaveLength(2);
	});

	it("keeps parked service/job owners in scope independently of excluded historical roster sections", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry, "Main", true);
		register(registry, main);
		const child = fixture(registry, "HistoricalOwner");
		child.append("historical transcript must not load");
		const directory = await mkdtemp(path.join(os.tmpdir(), "stall-owner-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const file = path.join(directory, "owner.jsonl");
		await writeFile(
			file,
			[child.sessionManager.getHeader(), ...child.sessionManager.getEntries()]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);
		registry.register({
			id: "HistoricalOwner",
			displayName: "HistoricalOwner",
			kind: "sub",
			parentId: "Main",
			rootSessionId: main.sessionManager.getSessionId(),
			session: null,
			sessionFile: file,
			status: "parked",
		});
		const owned: DaemonSnapshot = {
			id: "owned",
			name: "parked-owner-service",
			owner: child.sessionManager.getSessionId(),
			state: "running",
			createdAt: 1,
			startedAt: 1,
			outputBytes: 0,
			restartCount: 0,
			persist: false,
			detached: false,
		};
		const observedOwners = new Set<string>();
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue({
			observeOwners: (owners: string[]) => {
				for (const owner of owners) observedOwners.add(owner);
				return () => {};
			},
			request: async (operation: { op: string }) =>
				operation.op === "list"
					? {
							op: "list",
							daemons: [owned, { ...owned, id: "unrelated", name: "unrelated-service", owner: "other-main" }],
						}
					: { op: "ping", projectDir: "/stall-test" },
		} as unknown as DaemonBrokerClient);
		Object.defineProperty(main.session, "asyncJobManager", {
			value: {
				onSettled: () => () => {},
				getAllJobs: () => [
					{
						id: "owned-job",
						type: "task",
						status: "running",
						label: "parked-owner-task",
						ownerId: "HistoricalOwner",
						startTime: 1,
					},
				],
				getDeliveryState: () => ({ queued: 0, delivering: 0, pendingJobIds: [] }),
			},
		});
		const loader = vi.spyOn(sessionLoader, "loadEntriesFromFile");
		const headerReads = vi.spyOn(sessionLoader, "visitEntriesFromFileStream");
		const report = collector(main);
		const text = (await report.collect()).text;
		expect(text).not.toContain("### “HistoricalOwner”");
		expect(text).toContain("parked-owner-service");
		expect(text).toContain("parked-owner-task");
		expect(text).not.toContain("unrelated-service");
		expect(observedOwners.has(child.sessionManager.getSessionId())).toBe(true);
		expect(loader).not.toHaveBeenCalled();
		expect(headerReads).toHaveBeenCalledTimes(1);
		await report.collect();
		expect(headerReads).toHaveBeenCalledTimes(1);
	});

	it("bounds interval agent snapshots, labels overflow precisely, and clears only receipt-covered snapshots", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const report = collector(main);
		for (let index = 0; index < 520; index++)
			registry.register({
				id: `Parked-${index}`,
				displayName: "Parked",
				kind: "sub",
				parentId: "Main",
				rootSessionId: main.sessionManager.getSessionId(),
				session: null,
				status: "parked",
			});
		const before = await report.collect();
		expect(before.text).toContain("Changed-agent snapshot retention overflow: 8 earlier snapshots omitted");
		expect(before.text).toContain("Known candidate agents 513");
		expect((await report.collect()).text).toContain("Changed-agent snapshot retention overflow: 8");
		registry.unregister("Parked-519");
		before.commit();
		const after = await report.collect();
		expect(after.text).not.toContain("Changed-agent snapshot retention overflow");
		expect(after.text).toContain("Candidate agents 2; listed agent sections 2; omitted agent sections 0");
		expect(after.text).toContain("### “Parked-519” (“Parked”) — removed");
		after.commit();
		expect((await report.collect()).text).not.toContain("### “Parked-519”");
	});

	it("does not retain late events after disposal and refuses further collection", async () => {
		const registry = new AgentRegistry();
		const main = fixture(registry);
		register(registry, main);
		const report = collector(main);
		report.dispose();
		main.setTodos([{ name: "late", tasks: [{ content: "late", status: "pending" }] }]);
		await expect(report.collect()).rejects.toThrow("disposed");
	});
});
