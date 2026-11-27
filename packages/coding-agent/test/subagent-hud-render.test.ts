/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists every running subagent — detached background spawns and
 * sync task calls alike — as numbered `N Id: description` jump-list rows and
 * yields no output once nothing qualifies, so the block self-clears.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	isSettingsInitialized,
	resetSettingsForTest,
	Settings,
	settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentProgress } from "@oh-my-pi/pi-coding-agent/task/task-details";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { StatusHud, SubagentHud, SubagentHudModel, subagentEntries, subagentLayout, TodoHud } from "../src/ui/dock";
import { thinkingLevelGlyph } from "../src/utils/render-utils";
import { setActiveTodoDescriptions } from "../src/ui/tools/todo";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, renderRows } from "./helpers/mode-terminal";

import { cfgDisplayPinnedAgents, cfgDisplaySubagentLivePreview } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTaskShowResolvedModelBadge } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

/** A node as the native backend describes it. */
interface DescribedNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly DescribedNode[];
}

/** The active theme's glyph for `key`. */
const symbol = (key: string): string => currentTheme().symbols.symbol(key);

/** The HUD model the interactive mode feeds for `sessions` (resolved-model badges per `task.showResolvedModelBadge`). */
function hudModel(sessions: ObservableSession[], options: { livePreview?: boolean; expanded?: boolean } = {}) {
	const model = new SubagentHudModel();
	model.entries.set(subagentEntries(sessions, isSettingsInitialized() && cfgTaskShowResolvedModelBadge.get(settings)));
	model.livePreview.set(options.livePreview ?? false);
	model.expanded.set(options.expanded ?? false);
	return model;
}

/** The HUD on a test terminal `columns` wide, its clock at the wall clock. */
function hudTerminal(model: SubagentHudModel, columns = 120): TestTerminal {
	return createTestTerminal(() => ({ main: SubagentHud({ model }) }), {
		columns,
		rows: 200,
		theme: currentTheme(),
		now: Date.now(),
	});
}

/** The HUD's rows (escapes kept) for `sessions`. */
function renderRaw(sessions: ObservableSession[], columns = 120, livePreview = false): string[] {
	const term = hudTerminal(hudModel(sessions, { livePreview }), columns);
	try {
		const rows = [...term.rows()];
		while (rows.length > 0 && Bun.stripANSI(rows.at(-1)!).trim() === "") rows.pop();
		return rows;
	} finally {
		term.dispose();
	}
}

function render(sessions: ObservableSession[], columns = 120, livePreview = false): string {
	return renderRaw(sessions, columns, livePreview)
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n");
}

/** Click each row of the HUD for `model` and record what it asks for: an agent id, `toggle`, or nothing. */
function clickTargets(model: SubagentHudModel, columns = 120): { rows: string[]; targets: (string | undefined)[] } {
	const term = hudTerminal(model, columns);
	try {
		const rows = term.screen();
		const targets = rows.map((_, row) => {
			let target: string | undefined;
			model.onFocus = id => {
				target = id;
			};
			model.onToggle = () => {
				target = "toggle";
			};
			term.mouse({ row, col: 2, button: "left", action: "press", mods: [] });
			term.mouse({ row, col: 2, button: "left", action: "release", mods: [] });
			return target;
		});
		return { rows, targets };
	} finally {
		term.dispose();
	}
}

describe("subagent HUD lines", () => {
	beforeAll(() => {
		initTheme();
	});

	describe("model badges", () => {
		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("places thinking, model and optional advisor before the detached agent name", () => {
			const session = makeSession({
				id: "BadgeWorker",
				agent: "scout",
				description: "Inspect rendering",
				progress: makeProgress({
					id: "BadgeWorker",
					resolvedModel: "openai/gpt-5:high",
					resolvedModelIdentity: "openai/gpt-5",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				}),
			});
			const out = render([session]);
			expect(out).toContain(
				`${thinkingLevelGlyph(symbol, "high")} openai/gpt-5 ${symbol("icon.advisor")} BadgeWorker`,
			);
			expect(out).toContain(`BadgeWorker ${symbol("format.bracketLeft")}scout${symbol("format.bracketRight")}`);
			expect(out).toContain(": Inspect rendering");

			session.progress = makeProgress({
				id: "BadgeWorker",
				resolvedModel: "openai/gpt-5:high",
				resolvedModelIdentity: "openai/gpt-5",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: false,
			});
			const withoutAdvisor = render([session]);
			expect(withoutAdvisor).toContain("openai/gpt-5 BadgeWorker");
			expect(withoutAdvisor).not.toContain(symbol("icon.advisor"));
		});

		it("keeps metadata hidden when disabled or settings have not initialized", () => {
			const sessions = [
				makeSession({
					id: "HiddenBadge",
					description: "Inspect rendering",
					progress: makeProgress({
						id: "HiddenBadge",
						resolvedModel: "openai/gpt-5:high",
						resolvedModelIdentity: "openai/gpt-5",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					}),
				}),
			];
			cfgTaskShowResolvedModelBadge.override(Settings.instance, false);
			const disabled = render(sessions);
			expect(disabled).toContain(`${symbol("status.running")} HiddenBadge: Inspect rendering`);
			expect(disabled).not.toContain("openai/gpt-5");
			expect(disabled).not.toContain(symbol("icon.advisor"));

			resetSettingsForTest();
			expect(render(sessions)).toBe(disabled);
		});

		it("preserves model identity and the agent name while fitting descriptions and task previews", () => {
			const metadata = {
				resolvedModel: `provider/${"shared-prefix-".repeat(8)}variant-z:high`,
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			};
			const sessions = [
				makeSession({
					id: "Description",
					description: "Inspect rendering ".repeat(20),
					progress: makeProgress({ id: "Description", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					progress: makeProgress({ id: "TaskPreview", task: "Inspect rendering ".repeat(20), ...metadata }),
				}),
			];
			const lines = render(sessions, 60).split("\n");
			for (const id of ["Description", "TaskPreview"]) {
				const row = lines.find(line => line.includes(id))!;
				expect(row).toContain(`variant-z ${symbol("icon.advisor")} ${id}`);
				expect(row.indexOf("variant-z")).toBeLessThan(row.indexOf(id));
				expect(row).not.toContain(":high");
			}
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before optional details", () => {
			const symbols = currentTheme().symbols;
			const glyph = symbols.symbol.bind(symbols);
			const tree: Record<string, string> = { "tree.branch": "界├", "tree.last": "界界└", "tree.vertical": "界界│" };
			const custom = vi.spyOn(symbols, "symbol").mockImplementation(key => tree[key] ?? glyph(key));
			try {
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						description: "Every available column ".repeat(10),
						progress: makeProgress({ id: "LongWorker", resolvedModelIdentity: "provider/model", advisor: true }),
					}),
					makeSession({ id: "ShortWorker", agent: "scout", description: "Every available column ".repeat(10) }),
				];
				for (const enabled of [true, false]) {
					cfgTaskShowResolvedModelBadge.override(Settings.instance, enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith("  界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith("  界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain(
							`${glyph("format.bracketLeft")}scout${glyph("format.bracketRight")}`,
						);
					}
				}
			} finally {
				custom.mockRestore();
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const out = render([
				makeSession({
					id: "LegacyWorker",
					progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
				}),
			]);
			expect(out).toContain(`${symbol("status.running")} custom/model:high LegacyWorker`);
			expect(out).not.toContain(thinkingLevelGlyph(symbol, "high"));
		});
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expect(out).toContain("AuthLoader: Refactoring the auth flow");
		expect(out).toContain("SchemaMigrator: Migrating the users table");
	});

	it("counts running agents and previews the raw assignment, not the rendered prompt", () => {
		const assignment = "Run the 512-rule corpus against the native build and report every mismatch";
		const out = render([
			makeSession({
				id: "Corpus",
				progress: makeProgress({
					id: "Corpus",
					task: `Complete assignment thoroughly:\n\n${assignment}`,
					assignment,
				}),
			}),
			makeSession({ id: "Bench", description: "Benchmark the shared build" }),
		]);
		expect(out).toContain("Subagents · 2 running");
		expect(out).toContain(`Corpus ${assignment}`);
		expect(out).not.toContain("Complete assignment thoroughly");
	});

	it("strips terminal control sequences from the assignment preview", () => {
		const assignment = "\x1b]0;pwned\x07\x1b[2JAudit the corpus";
		const raw = renderRaw([
			makeSession({ id: "Corpus", progress: makeProgress({ id: "Corpus", task: assignment, assignment }) }),
		]).join("\n");
		expect(Bun.stripANSI(raw)).toContain("Audit the corpus");
		expect(raw).not.toContain("\x1b]0;");
		expect(raw).not.toContain("\x1b[2J");
	});

	it("shows a non-default role badge and hides descriptions that only echo the id", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("AuthLoader");
		expect(withRole).toMatch(/AuthLoader.*scout/);
		expect(withRole).toContain("Refactor the auth flow");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain("AuthLoader");
		expect(echoed).toMatch(/AuthLoader.*scout/);
		expect(echoed).not.toContain("AuthLoader: AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toMatch(/AuthLoader-3.*scout/);
		expect(collision).not.toContain("AuthLoader-3: AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expect(mixedCase).not.toContain("AuthLoader-3: authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expect(defaultWorker).toContain("SchemaMigrator: Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(render(sessions)).toBe("");

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("StillRunning: live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(fromProgressDesc).toContain("Worker: From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(fromTask).toContain("Worker Investigate flaky CI on macOS");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain("ReviewShell");
		expect(multiLineTask).toContain("Complete assignment thoroughly: ↵ # Tar");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expect(multiLineDesc).toContain("First line ↵ Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("lists sync and detached spawns alike", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) join the pinned jump list.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
			makeSession({ id: "BackgroundSpawn", description: "detached work" }),
		];
		const out = render(sessions);
		expect(out).toContain("BackgroundSpawn: detached work");
		expect(out).toContain("SyncSpawn: inline task work");
		expect(out).toContain("EvalSpawn: eval cell work");
		const { targets } = clickTargets(hudModel(sessions));
		expect(targets.slice(2, 5)).toEqual(["SyncSpawn", "EvalSpawn", "BackgroundSpawn"]);
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("Detached: background work");
		expect(out).toContain("FromProgress: background work");
		expect(out).toContain("Inline: sync work");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("Anna>Bob:");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every live agent when expanded, with a collapse row", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const term = hudTerminal(hudModel(active, { expanded: true }));
		const out = term.screen().join("\n");
		term.dispose();

		for (const session of active) {
			expect(out).toContain(`${session.id}: ${session.description}`);
		}
		expect(out).not.toContain("more running");
		expect(out).toContain("show less");
	});

	it("collapses to a few rows with an expander by default", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);
		expect(out).toContain("Worker0: job 0");
		expect(out).toContain("Worker2: job 2");
		expect(out).not.toContain("Worker3: job 3");
		expect(out).toContain("7 more — expand");
		expect(out).not.toContain("show less");
	});

	describe("live preview", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("shows the current tool call only when enabled", () => {
			const sessions = [
				makeSession({
					id: "AuthLoader",
					description: "Refactoring the auth flow",
					progress: makeProgress({
						id: "AuthLoader",
						currentTool: "read",
						currentToolArgs: "src/auth.ts:50-100",
					}),
				}),
			];
			expect(render(sessions)).not.toContain("read: src/auth.ts:50-100");
			const out = render(sessions, 120, true);
			expect(out).toContain("AuthLoader: Refactoring the auth flow");
			expect(out).toContain("read: src/auth.ts:50-100");
		});

		it("falls back to the most recent tool when idle between calls", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							recentTools: [{ tool: "grep", args: "renderSubagentHudLines", endMs: Date.now() }],
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("grep: renderSubagentHudLines");
		});

		it("follows the call the model is still writing until it runs, over the last finished one", () => {
			const writing = { kind: "call", tool: "write", args: "tests/test_norm.py", argsKey: "path" } as const;
			const row = (overrides: Partial<AgentProgress>) =>
				render(
					[
						makeSession({
							id: "Writer",
							progress: makeProgress({
								id: "Writer",
								recentTools: [{ tool: "edit", args: "src/norm.py", argsKey: "path", endMs: 1 }],
								...overrides,
							}),
						}),
					],
					120,
					true,
				)
					.split("\n")
					.at(-1);
			const done = symbol("status.success");
			// Not yet run, so not marked with how it ended.
			expect(row({ streaming: writing })).toEndWith(`${symbol("tree.hook")} write: tests/test_norm.py`);
			expect(row({ streaming: { ...writing, intent: "Write the norm test" } })).toContain(
				"write: Write the norm test",
			);
			expect(row({ currentTool: "bash", currentToolArgs: "bun test", streaming: writing })).toContain(
				"bash: bun test",
			);
			// Reasoning and prose are not calls: the row keeps the last one.
			expect(row({ streaming: { kind: "thinking" } })).toContain(`${done} edit: src/norm.py`);
		});

		it("adds an elapsed marker to long-running calls and stays within the viewport", () => {
			const columns = 120;
			const out = render(
				[
					makeSession({
						id: "Builder",
						progress: makeProgress({
							id: "Builder",
							currentTool: "bash",
							currentToolArgs: "npm test",
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("bash: npm test"));
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("shortens long tool details to the viewport", () => {
			const columns = 60;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: "x".repeat(300),
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			expect(out).toContain("read: xxxxxxxx");
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});
		it("shortens home-directory paths in preview details", () => {
			const homeFile = `${os.homedir()}/.ssh/config`;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: `cat ${homeFile}`,
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("cat ~/.ssh/config");
			expect(out).not.toContain(os.homedir());
		});

		it("shortens a path argument by its key but keeps a literal search pattern as written", () => {
			// A fixed home: the detail is capped at 40 columns, which would cut the literal pattern under a long HOME.
			vi.spyOn(os, "homedir").mockReturnValue(path.join(path.sep, "home", "tester"));
			const homeFile = `${os.homedir()}/.ssh/config`;
			const preview = (key: string) =>
				render(
					[
						makeSession({
							id: "Reader",
							progress: makeProgress({
								id: "Reader",
								currentTool: "grep",
								currentToolArgs: homeFile,
								currentToolArgsKey: key,
							}),
						}),
					],
					200,
					true,
				);
			expect(preview("path")).toContain("~/.ssh/config");
			expect(preview("path")).not.toContain(os.homedir());
			// A search pattern that names a home path must still show what was searched.
			expect(preview("pattern")).toContain(homeFile);
		});

		it("marks the last completed call with how it ended while idle between calls", () => {
			const rowFor = (isError: boolean) =>
				render(
					[
						makeSession({
							id: "Worker",
							progress: makeProgress({
								id: "Worker",
								recentTools: [{ tool: "read", args: "a.ts", argsKey: "path", isError, endMs: Date.now() }],
							}),
						}),
					],
					120,
					true,
				)
					.split("\n")
					.find(line => line.includes("read: a.ts"));
			const success = symbol("status.success");
			const error = symbol("status.error");
			expect(rowFor(false)).toContain(`${success} read: a.ts`);
			expect(rowFor(true)).toContain(`${error} read: a.ts`);
			expect(rowFor(false)).not.toContain(error);
		});

		it("keeps the elapsed marker with a very long tool name at a narrow width", () => {
			const columns = 40;
			const out = render(
				[
					makeSession({
						id: "Mcp",
						progress: makeProgress({
							id: "Mcp",
							currentTool: `mcp__tool_${"x".repeat(120)}`,
							currentToolArgs: "some detail that cannot fit",
							currentToolStartMs: Date.now() - 20_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("mcp__tool_"));
			expect(toolRow).toBeDefined();
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("fits every rendered component row within the viewport without wrapping the elapsed marker", () => {
			const sessions = [
				makeSession({
					id: "Builder",
					description: "Narrow build",
					progress: makeProgress({
						id: "Builder",
						currentTool: "bash",
						currentToolArgs: `cat ${os.homedir()}/.ssh/config`,
						currentToolStartMs: Date.now() - 10_000,
					}),
				}),
				makeSession({
					id: "Reader",
					progress: makeProgress({
						id: "Reader",
						currentTool: "read",
						currentToolArgs: "x".repeat(300),
						currentToolStartMs: Date.now() - 12_000,
					}),
				}),
			];
			for (const columns of [60, 120]) {
				const rows = render(sessions, columns, true).split("\n");
				for (const row of rows) {
					expect(Bun.stringWidth(row)).toBeLessThanOrEqual(columns);
				}
				const elapsedRows = rows.filter(row => /\d+s/.test(row));
				expect(elapsedRows.length).toBeGreaterThan(0);
				for (const row of elapsedRows) {
					expect(row).toMatch(/bash|read/);
				}
			}
		});

		it("routes clicks on a preview row to its agent and keeps later rows and the expander aligned", () => {
			const sessions = ["Alpha", "Beta", "Gamma", "Delta"].map(id =>
				makeSession({ id, progress: makeProgress({ id, currentTool: "read", currentToolArgs: `${id}.ts` }) }),
			);
			const { rows, targets } = clickTargets(hudModel(sessions, { livePreview: true }));
			const targetOf = (text: string) => targets[rows.findIndex(row => row.includes(text))];
			expect(targetOf("Alpha.ts")).toBe("Alpha");
			expect(targetOf("Beta")).toBe("Beta");
			expect(targetOf("Gamma.ts")).toBe("Gamma");
			expect(targetOf("more — expand")).toBe("toggle");
		});

		it("labels a call with its own intent, never an earlier call's", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							lastIntent: "Reading auth config",
							currentTool: "mcp__db_query",
							currentToolArgs: "SELECT 1",
							recentTools: [{ tool: "read", args: "auth.ts", intent: "Reading auth config", endMs: 1 }],
						}),
					}),
					makeSession({
						id: "Between",
						progress: makeProgress({
							id: "Between",
							lastIntent: "Reading auth config",
							recentTools: [{ tool: "mcp__db_query", args: "SELECT 2", endMs: 2 }],
						}),
					}),
					makeSession({
						id: "Intentful",
						progress: makeProgress({
							id: "Intentful",
							currentTool: "read",
							currentToolArgs: "auth.ts",
							currentToolIntent: "Checking the session cookie",
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("mcp__db_query: SELECT 1");
			expect(out).toContain("mcp__db_query: SELECT 2");
			expect(out).toContain("read: Checking the session cookie");
			expect(out).not.toContain("Reading auth config");
		});

		it("keeps the header and agent rows within the padded HUD width", () => {
			const sessions = [
				makeSession({ id: `Worker${"W".repeat(80)}`, description: "Every available column ".repeat(10) }),
			];
			for (const columns of [40, 60]) {
				// No wrapping: exactly the blank row, the header and one agent row.
				const rows = renderRaw(sessions, columns, true);
				expect(rows).toHaveLength(3);
				for (const row of rows) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(columns);
			}
		});
	});
});

describe("subagent HUD click rows", () => {
	beforeAll(() => {
		initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const { rows, targets } = clickTargets(hudModel([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })]));
		expect(rows[2]).toContain("Alpha");
		expect(rows[3]).toContain("Beta");
		expect(targets).toEqual([undefined, undefined, "Alpha", "Beta"]);
	});

	it("resolves the expander row to the toggle", () => {
		const sessions = ["A", "B", "C", "D"].map(id => makeSession({ id }));
		const { rows, targets } = clickTargets(hudModel(sessions));
		const expander = rows.findIndex(row => row.includes("more — expand"));
		expect(targets[expander]).toBe("toggle");
		expect(targets[expander - 1]).toBe("C");
	});
});

describe("subagent HUD layout", () => {
	it("fits small lists without an expander", () => {
		expect(subagentLayout(0, false)).toEqual({ items: 0, toggle: undefined });
		expect(subagentLayout(3, false)).toEqual({ items: 3, toggle: undefined });
		expect(subagentLayout(3, true)).toEqual({ items: 3, toggle: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(subagentLayout(4, false)).toEqual({ items: 3, toggle: "expand" });
		expect(subagentLayout(10, false)).toEqual({ items: 3, toggle: "expand" });
	});

	it("expands to every row with a collapse row", () => {
		expect(subagentLayout(5, true)).toEqual({ items: 5, toggle: "collapse" });
		expect(subagentLayout(10, true)).toEqual({ items: 10, toggle: "collapse" });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			eventBus,
			createModeTerminal({ columns: 120, rows: 40 }).frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		setActiveTodoDescriptions([]);
		resetSettingsForTest();
	});

	/** The pinned subagents HUD as the terminal draws it, its clock at the wall clock. */
	const hudText = (): string => {
		const term = hudTerminal(mode.hud.subagents);
		try {
			return term.screen().join("\n");
		} finally {
			term.dispose();
		}
	};
	const todoText = (): string[] => renderRows(() => TodoHud({ model: mode.hud.todo }));

	it("coalesces a burst of progress observer changes into one HUD rebuild", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const rebuild = vi.spyOn(mode.hud.subagents.entries, "set");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();

		const hud = hudText();
		expect(hud).toContain("BurstAgent0: Burst job 0");
		expect(hud).toContain("BurstAgent2: Burst job 2");
		expect(hud).not.toContain("BurstAgent3: Burst job 3");
		expect(hud).toContain("3 more — expand");
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it("does not repaint unchanged background progress after the HUD settles", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		const payload = makeProgressPayload("Background", 0, "Compile", true);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();
		const settled = mode.hud.subagents.entries();
		for (let index = 0; index < 20; index++) {
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				...payload,
				progress: { ...payload.progress, durationMs: index + 1 },
			});
			await Promise.resolve();
			vi.runAllTimers();
			await Promise.resolve();
		}
		// Unchanged facts keep the same entries: nothing the HUD draws repaints.
		expect(mode.hud.subagents.entries()).toEqual(settled);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Background", 0, "Link", true));
		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();
		expect(hudText()).toContain("Link");
	});

	it("updates native checklist matches outside the terminal TODO window", async () => {
		cfgDisplayPinnedAgents.override(Settings.instance, "off");
		await mode.init({ suppressWelcomeIntro: true });
		const checklistStatus = (): unknown => {
			const tree = createRoot(dispose => {
				try {
					const [root] = resolveChildren(StatusHud({ model: mode.hud.status }))();
					return root ? (describeTree(root, staticEnvironment(currentTheme())) as DescribedNode) : undefined;
				} finally {
					dispose();
				}
			});
			const checklist = (tree?.c ?? []).find(child => child.k === "checklist");
			const phases = checklist?.p?.phases as { items: { status: string }[] }[] | undefined;
			return phases?.[5]?.items[0]?.status;
		};
		mode.setTodos(
			[
				"Inspect inputs",
				"Design interface",
				"Implement parser",
				"Check output",
				"Document settings",
				"Verify deployment",
			].map((content, index) => ({
				name: `Phase ${index + 1}`,
				tasks: [{ content, status: "pending" as const }],
			})),
		);
		expect(checklistStatus()).toBe("pending");
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Reviewer", 0, "Unrelated work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		const terminalRows = todoText();
		expect(terminalRows.join("\n")).not.toContain("Verify deployment");

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Reviewer", 0, "Verify deployment", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(todoText()).toEqual(terminalRows);
		expect(checklistStatus()).toBe("active");
	});

	it("lights the transcript todo card's matching task after the sticky HUD auto-cleared", async () => {
		cfgDisplayPinnedAgents.override(Settings.instance, "off");
		cfgTasksTodoClearDelay.override(session.settings, 0);
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		const target = "Verify transcript repaint";
		const transcriptPhases: TodoPhase[] = [
			{
				name: "Review",
				tasks: [...Array.from({ length: 10 }, (_, index) => `Inspect module ${index}`), target].map(content => ({
					content,
					status: "pending",
				})),
			},
		];
		const closedPhases: TodoPhase[] = transcriptPhases.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task => ({ ...task, status: "completed" })),
		}));
		session.sessionManager.appendCustomEntry("user_todo_edit", { phases: closedPhases });
		session.setTodoPhases(closedPhases);
		mode.setTodos(closedPhases);
		vi.advanceTimersByTime(0);
		await session.settleInFlightMessagePersistence();
		await session.sessionManager.flush();
		expect(todoText()).toEqual([]);
		// The built-in todo tool draws the card (this session mounts no tools of its own).
		vi.spyOn(session, "hasBuiltInTool").mockImplementation(name => name === "todo");
		const card = mode.presentToolCall({
			name: "todo",
			args: { op: "init" },
			tool: undefined,
			id: "todo-1",
			cwd: "/",
		});
		card.setArgsComplete("todo-1");
		card.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { op: "init", phases: transcriptPhases, storage: "session" },
			},
			false,
			"todo-1",
		);
		/** The card's status for the target task. */
		const targetStatus = (): unknown => {
			const tree = createRoot(dispose => {
				try {
					return describeTree(card.block.node, staticEnvironment(currentTheme())) as DescribedNode;
				} finally {
					dispose();
				}
			});
			const all = (node: DescribedNode): DescribedNode[] => [node, ...(node.c ?? []).flatMap(all)];
			const checklist = all(tree).find(node => node.k === "checklist");
			const phases = checklist?.p?.phases as { items: { text: string; status: string }[] }[] | undefined;
			return phases?.flatMap(phase => phase.items).find(item => item.text === target)?.status;
		};
		expect(targetStatus()).toBe("pending");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Reviewer", 0, "Unrelated work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(targetStatus()).toBe("pending");

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Reviewer", 0, target, true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(targetStatus()).toBe("active");
		expect(todoText()).toEqual([]);
		expect(hudText()).toBe("");

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("Reviewer", 0, "Unrelated work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(targetStatus()).toBe("pending");
	});

	it("applies the setting over a clicked expand override", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
		}
		await Promise.resolve();
		vi.advanceTimersByTime(100);

		// A click on the expander row.
		mode.hud.subagents.onToggle?.();
		expect(hudText()).toContain("Override4");

		mode.applyPinnedAgentsSetting();
		expect(hudText()).not.toContain("Override4");
		expect(hudText()).toContain("more — expand");
	});

	it("advances a quiet call's elapsed marker from the terminal clock, without rebuilding the HUD", async () => {
		cfgDisplaySubagentLivePreview.override(Settings.instance, true);
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		setSystemTime(1_000_000);
		const payload = makeProgressPayload("Sleeper", 0, "Run sleep", true);
		payload.progress = {
			...payload.progress,
			currentTool: "bash",
			currentToolArgs: "sleep 40",
			currentToolStartMs: 1_000_000 - 20_000,
		};
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100); // observer UI coalesce window
		const entries = mode.hud.subagents.entries();
		expect(hudText()).toContain("bash: sleep 40 · 20.1s");

		vi.advanceTimersByTime(1_000);
		expect(mode.hud.subagents.entries()).toBe(entries);
		expect(hudText()).toContain("bash: sleep 40 · 21.1s");
	});

	it("drops the elapsed marker for an identical new call", async () => {
		cfgDisplaySubagentLivePreview.override(Settings.instance, true);
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		setSystemTime(1_000_000);
		const payload = makeProgressPayload("Builder", 0, "Build", true);
		payload.progress = {
			...payload.progress,
			currentTool: "bash",
			currentToolArgs: "build it",
			currentToolStartMs: Date.now(),
		};
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(hudText()).toContain("bash: build it");
		expect(hudText()).not.toContain("bash: build it ·");

		vi.advanceTimersByTime(6_000);
		expect(hudText()).toContain("bash: build it ·");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, currentToolStartMs: Date.now(), toolCount: 2 },
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(hudText()).toContain("bash: build it");
		expect(hudText()).not.toContain("bash: build it ·");
	});
});
