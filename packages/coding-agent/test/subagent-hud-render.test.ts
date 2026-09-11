/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly the running *detached* subagents as paired ID and
 * activity rows and yields no output once nothing qualifies, so the block
 * self-clears. Sync task spawns and eval `agent()` spawns are excluded:
 * their progress is already rendered inline (tool block / eval cell).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { loadTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

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

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}

function expectSameRow(output: string, ...contents: string[]): void {
	expect(output.split("\n").some(line => contents.every(content => line.includes(content)))).toBe(true);
}

function expectDescriptionNotEchoed(output: string, id: string, description: string): void {
	const row = output.split("\n").find(line => line.includes(id));
	expect(row).toBeDefined();
	const normalized = row!.toLowerCase();
	const needle = description.toLowerCase();
	expect(normalized.split(needle)).toHaveLength(2);
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
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
			expect(out).toContain(`${theme.thinking.high.split(" ")[0]} openai/gpt-5 ${theme.icon.advisor} BadgeWorker`);
			expect(out).toContain(`BadgeWorker ${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
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
			expect(withoutAdvisor).not.toContain(theme.icon.advisor);
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
			Settings.instance.override("task.showResolvedModelBadge", false);
			const disabled = render(sessions);
			expect(disabled).toContain(`${theme.status.done} HiddenBadge: Inspect rendering`);
			expect(disabled).not.toContain("openai/gpt-5");
			expect(disabled).not.toContain(theme.icon.advisor);

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
				expect(row).toContain(`variant-z ${theme.icon.advisor} ${id}`);
				expect(row.indexOf("variant-z")).toBeLessThan(row.indexOf(id));
				expect(row).not.toContain(":high");
			}
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before optional details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
				});
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
					Settings.instance.override("task.showResolvedModelBadge", enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith(" 界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain(
							`${theme.format.bracketLeft}scout${theme.format.bracketRight}`,
						);
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
				else Reflect.deleteProperty(theme, "tree");
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const out = render([
				makeSession({
					id: "LegacyWorker",
					progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
				}),
			]);
			expect(out).toContain(`${theme.status.done} custom/model:high LegacyWorker`);
			expect(out).not.toContain(theme.thinking.high.split(" ")[0]);
		});
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expectSameRow(out, "AuthLoader", "Refactoring the auth flow");
		expectSameRow(out, "SchemaMigrator", "Migrating the users table");
	});

	it("keeps the last finished tool visible until the next tool starts", () => {
		const active = makeSession({
			id: "Reader",
			description: "Inspecting renderer behavior",
			progress: makeProgress({
				id: "Reader",
				resolvedModel: "openai/gpt-5.6-sol",
				lastIntent: "Inspecting renderer behavior",
				currentTool: "read",
				currentToolArgs: "packages/coding-agent/src/modes/interactive-mode.ts",
			}),
		});
		const withoutModel = renderSubagentHudLines([active], 40, false).join("\n");
		expect(withoutModel).not.toContain("openai/gpt-5.6-sol");
		const activeLines = renderSubagentHudLines([active], 40, true);
		const activeText = Bun.stripANSI(activeLines.join("\n"));
		expectSameRow(
			Bun.stripANSI(renderSubagentHudLines([active], 120, true).join("\n")),
			"Reader",
			"openai/gpt-5.6-sol",
			"Inspecting renderer behavior",
		);
		expectSameRow(activeText, "read(packages/");
		for (const line of activeLines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(40);
		const settled = makeSession({
			...active,
			progress: makeProgress({
				id: "Reader",
				lastIntent: "Inspecting renderer behavior",
				recentTools: [{ tool: "read", args: "package.json", endMs: Date.now() }],
			}),
		});
		const settledText = Bun.stripANSI(renderSubagentHudLines([settled], 40, true).join("\n"));
		expectSameRow(settledText, theme.symbol("status.success"), "read(package.json)");
		const next = makeSession({
			...settled,
			progress: makeProgress({
				id: "Reader",
				currentTool: "grep",
				currentToolArgs: "symbol",
				recentTools: settled.progress!.recentTools,
			}),
		});
		const nextText = render([next]);
		expect(nextText).toContain("grep(symbol)");
		expect(nextText).not.toContain("read(");
	});

	it("retains failure status and path privacy in the completed tool row", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "missing.ts");
		const text = render([
			makeSession({
				id: "Reader",
				progress: makeProgress({
					id: "Reader",
					recentTools: [{ tool: "read", args: homePath, argsKey: "path", isError: true, endMs: 1 }],
				}),
			}),
		]);
		expectSameRow(text, theme.symbol("status.error"), "read(~/private-project/missing.ts)");
		expect(text).not.toContain(homePath);
	});

	it("formats selected tool arguments by semantic key without changing raw command text", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "secret.ts");
		const readOut = render([
			makeSession({
				id: "Reader",
				progress: makeProgress({
					id: "Reader",
					currentTool: "ast_grep",
					currentToolArgs: homePath,
					currentToolArgsKey: "path",
				}),
			}),
		]);
		expect(readOut).toContain("ast_grep(~/private-project/secret.ts)");
		const patternOut = render([
			makeSession({
				id: "Searcher",
				progress: makeProgress({
					id: "Searcher",
					currentTool: "grep",
					currentToolArgs: homePath,
					currentToolArgsKey: "pattern",
				}),
			}),
		]);
		expect(patternOut).toContain(`grep(${homePath})`);
		const command = `MODE=check cat "${homePath}"`;
		const bashOut = render([
			makeSession({
				id: "Runner",
				progress: makeProgress({
					id: "Runner",
					currentTool: "bash",
					currentToolArgs: command,
					currentToolArgsKey: "command",
				}),
			}),
		]);
		expect(bashOut).toContain('bash(MODE=check cat "~/private-project/secret.ts")');
	});

	it("uses configured status glyphs for completed edits without hiding file locations", async () => {
		const previousTheme = theme;
		try {
			for (const preset of ["ascii", "nerd"] as const) {
				setThemeInstance(await loadTheme("dark", { symbolPresetOverride: preset }));
				for (const isError of [false, true]) {
					const text = render([
						makeSession({
							id: "Editor",
							progress: makeProgress({
								id: "Editor",
								recentTools: [
									{ tool: "edit", args: "src/one.ts, src/two.ts", argsKey: "path", isError, endMs: 1 },
								],
							}),
						}),
					]);
					expectSameRow(
						text,
						theme.symbol(isError ? "status.error" : "status.success"),
						"edit(src/one.ts, src/two.ts)",
					);
				}
			}
		} finally {
			setThemeInstance(previousTheme);
		}
	});

	it("shortens compound path tokens without rewriting unrelated absolute paths", () => {
		const home = process.env.HOME!;
		const args = `src/**/*.ts; ${home}/private/*.ts; /mnt${home}/keep.ts`;
		const text = render(
			[
				makeSession({
					id: "Locator",
					progress: makeProgress({
						id: "Locator",
						currentTool: "glob",
						currentToolArgs: args,
						currentToolArgsKey: "path",
					}),
				}),
			],
			240,
		);
		expect(text).toContain(`glob(src/**/*.ts; ~/private/*.ts; /mnt${home}/keep.ts)`);
	});

	it("shortens a home-directory entry in colon-separated command paths", () => {
		const text = render([
			makeSession({
				id: "Runner",
				progress: makeProgress({
					id: "Runner",
					currentTool: "bash",
					currentToolArgs: `PYTHONPATH=${process.env.HOME!}:/opt/lib python`,
					currentToolArgsKey: "command",
				}),
			}),
		]);
		expect(text).toContain("PYTHONPATH=~:/opt/lib python");
	});

	it("shortens home paths adjoining shell redirections", () => {
		const text = render(
			[
				makeSession({
					id: "Runner",
					progress: makeProgress({
						id: "Runner",
						currentTool: "bash",
						currentToolArgsKey: "command",
						currentToolArgs: `cat <${process.env.HOME!}/in >>${process.env.HOME!}/out`,
					}),
				}),
			],
			240,
		);
		expect(text).toContain("cat <~/in >>~/out");
		expect(text).not.toContain(process.env.HOME!);
	});

	it("preserves model revision and effort in a roomy HUD badge", () => {
		const selector = "anthropic/claude-sonnet-4-20250514:high";
		const text = Bun.stripANSI(
			renderSubagentHudLines(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({ id: "Worker", resolvedModel: selector }),
					}),
				],
				160,
				true,
			).join("\n"),
		);
		expect(text).toContain("anthropic/");
		expect(text).toContain("20250514:high");
	});

	it("shortens home paths in live activity labels", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "source.ts");
		const text = render([
			makeSession({
				id: "Reader",
				progress: makeProgress({ id: "Reader", lastIntent: `${homePath} checking imports` }),
			}),
		]);
		expect(text).toContain("~/private-project/source.ts checking imports");
		expect(text).not.toContain(homePath);
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
		expectDescriptionNotEchoed(echoed, "AuthLoader", "AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toMatch(/AuthLoader-3.*scout/);
		expectDescriptionNotEchoed(collision, "AuthLoader-3", "AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expectDescriptionNotEchoed(mixedCase, "AuthLoader-3", "authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expectSameRow(defaultWorker, "SchemaMigrator", "Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expectSameRow(out, "StillRunning", "live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expectSameRow(fromProgressDesc, "Worker", "From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expectSameRow(fromTask, "Worker", "Investigate flaky CI on macOS");

		const generatedOverWrappedTask = render([
			makeSession({
				id: "Worker",
				description: "Generated activity label",
				progress: makeProgress({
					id: "Worker",
					description: "Generated progress label",
					assignment: "Inspect HUD precedence",
					task: "Complete assignment thoroughly:\n\n# Target\nHUD",
				}),
			}),
		]);
		expectSameRow(generatedOverWrappedTask, "Worker", "Generated progress label");
		expect(generatedOverWrappedTask).not.toContain("Complete assignment thoroughly");

		const assignmentAfterHandleEcho = render([
			makeSession({
				id: "Worker",
				progress: makeProgress({
					id: "Worker",
					lastIntent: "Worker",
					description: "worker",
					assignment: "Inspect HUD fallback",
					task: "Complete assignment thoroughly",
				}),
			}),
		]);
		expectSameRow(assignmentAfterHandleEcho, "Worker", "Inspect HUD fallback");
		expect(assignmentAfterHandleEcho).not.toContain("Complete assignment thoroughly");

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
		expectSameRow(multiLineTask, "ReviewShell", "Complete assignment thoroughly:", "# Target");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expectSameRow(multiLineDesc, "ReviewShell", "First line", "Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expectSameRow(out, "BackgroundSpawn", "detached work");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});

	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expectSameRow(out, "Detached", "background work");
		expectSameRow(out, "FromProgress", "background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expectSameRow(out, "Anna>Bob", "start");
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

	it("renders the first eight active detached subagents and summarizes the rest", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);

		for (const session of active.slice(0, 8)) {
			expectSameRow(out, session.id, session.description!);
		}
		for (const session of active.slice(8)) {
			expect(out.split("\n").some(line => line.includes(session.id) && line.includes(session.description!))).toBe(
				false,
			);
		}
		expect(out).toContain("2 more running");
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders tool lifecycle changes without waiting for the progress debounce", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		const payload = makeProgressPayload("FastReader", 0, "Inspecting source", true);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, currentTool: "read", currentToolArgs: "package.json", currentToolStartMs: 1 },
		});
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("read(package.json)");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, currentTool: "read", currentToolArgs: "bun.lock", currentToolStartMs: 1 },
		});
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("read(bun.lock)");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, recentTools: [{ tool: "read", args: "bun.lock", endMs: 2 }] },
		});
		await Promise.resolve();
		const settled = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(settled).toContain("FastReader");
		expectSameRow(settled, theme.symbol("status.success"), "read(bun.lock)");
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
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

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expectSameRow(hud, "BurstAgent0", "Burst job 0");
		expectSameRow(hud, "BurstAgent5", "Burst job 5");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
	it("rebuilds HUD immediately when badge setting changes", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("LongRunner", 0, "Long-running work", true),
			progress: makeProgress({
				id: "LongRunner",
				description: "Long-running work",
				task: "Long-running work",
				resolvedModel: "openai/gpt-5.6-sol",
			}),
		});
		vi.useFakeTimers();
		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).not.toContain("openai/gpt-5.6-sol");
		session.settings.override("task.showResolvedModelBadge", true);
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("openai/gpt-5.6-sol");
	});
});
