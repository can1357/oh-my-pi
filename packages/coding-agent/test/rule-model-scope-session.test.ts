import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type Judge, type JudgmentRequest, type NoulAnswer } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { invalidate as invalidateCapabilityCache } from "@oh-my-pi/pi-coding-agent/capability";
import { getActiveRules, resetActiveRulesForTests, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ruleRecordKey, TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { testRule } from "./helpers/rule-scope-fixtures";

const OPUS_MARKER = "OPUS_ONLY_RULE_BODY_7f3a";
const SONNET_MARKER = "SONNET_ONLY_RULE_BODY_2c9e";
const ANTHROPIC_MARKER = "ANTHROPIC_RULE_BODY_51d0";
const UNSCOPED_MARKER = "UNSCOPED_RULE_BODY_93b4";

/** Points discovery's `os.homedir()` and the process-global agent dir at `home` for the running test. */
function isolateHome(home: string): void {
	vi.spyOn(os, "homedir").mockReturnValue(home);
	const originalAgentDir = getAgentDir();
	setAgentDir(path.join(home, ".omp", "agent"));
	onTestFinished(() => setAgentDir(originalAgentDir));
}

// Same-named variants: the session renders whichever one admits its current model.
const variantRules = [
	testRule("style", { content: OPUS_MARKER, alwaysApply: true, models: ["*/claude-opus-5"] }),
	testRule("style", { content: SONNET_MARKER, alwaysApply: true, family: ["sonnet"] }),
];

const opus = getBundledModel("anthropic", "claude-opus-5");
const sonnet = getBundledModel("anthropic", "claude-sonnet-5");
const sonnetSelector = `${sonnet.provider}/${sonnet.id}`;
const opusSelector = `${opus.provider}/${opus.id}`;

describe("model-scoped rules in a live session", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-rule-model-scope-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		resetActiveRulesForTests();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		await removeWithRetries(dir);
	});

	async function startSession(options: {
		model?: typeof opus;
		rules?: Rule[];
		settings?: Settings;
		sessionManager?: SessionManager;
		taskDepth?: number;
		toolNames?: string[];
		/** Discover rules from this directory's `.omp/rules` instead of passing them in. */
		discoverRulesIn?: string;
	}): Promise<AgentSession> {
		const cwd = options.discoverRulesIn ?? dir;
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings: options.settings ?? Settings.isolated(),
			model: options.model,
			rules: options.discoverRulesIn ? undefined : (options.rules ?? variantRules),
			taskDepth: options.taskDepth,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: options.toolNames ?? ["read"],
		});
		sessions.push(session);
		return session;
	}

	function prompt(session: AgentSession): string {
		return session.agent.state.systemPrompt.join("\n");
	}

	for (const includeModelInPrompt of [true, false]) {
		it(`swaps the variant on every model switch (includeModelInPrompt=${includeModelInPrompt})`, async () => {
			const session = await startSession({ model: opus, settings: Settings.isolated({ includeModelInPrompt }) });
			expect(prompt(session)).toContain(OPUS_MARKER);
			expect(prompt(session)).not.toContain(SONNET_MARKER);

			await session.setModel(sonnet);
			expect(prompt(session)).toContain(SONNET_MARKER);
			expect(prompt(session)).not.toContain(OPUS_MARKER);
			expect(getActiveRules().map(r => r.content)).toEqual([SONNET_MARKER]);

			await session.setModel(opus);
			expect(prompt(session)).toContain(OPUS_MARKER);
			expect(prompt(session)).not.toContain(SONNET_MARKER);
		});
	}

	it("renders the restored session model's variant at startup", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", opusSelector);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(sonnetSelector);
		const session = await startSession({ settings, sessionManager });

		expect(session.model?.id).toBe(sonnet.id);
		expect(prompt(session)).toContain(SONNET_MARKER);
		expect(prompt(session)).not.toContain(OPUS_MARKER);
	});

	it("gives a subagent on another model its own variant", async () => {
		const parent = await startSession({ model: opus });
		const child = await startSession({ model: sonnet, taskDepth: 1 });
		expect(prompt(parent)).toContain(OPUS_MARKER);
		expect(prompt(child)).toContain(SONNET_MARKER);
		expect(prompt(child)).not.toContain(OPUS_MARKER);
	});

	it("keeps both variants in the rules a spawned subagent inherits after a switch", async () => {
		const parent = await startSession({ model: opus, toolNames: ["read", "task"] });
		await parent.setModel(sonnet);
		expect(prompt(parent)).toContain(SONNET_MARKER);
		// The task tool spawns subagents with its ToolSession's `rules`.
		const task = parent.getToolByName("task") as unknown as { tool?: { session?: { rules?: Rule[] } } };
		const inherited = task.tool?.session?.rules?.map(r => r.content);
		expect(inherited).toEqual([OPUS_MARKER, SONNET_MARKER]);
	});

	it("scopes the /btw side request to the current model", async () => {
		const session = await startSession({ model: opus });
		await session.setModel(sonnet);
		// `/btw` (runEphemeralTurn) sends the side request context built from the live prompt.
		const side = await session.agent.buildSideRequestContext([]);
		const sidePrompt = (side.systemPrompt ?? []).join("\n");
		expect(sidePrompt).toContain(SONNET_MARKER);
		expect(sidePrompt).not.toContain(OPUS_MARKER);
	});

	it("re-scopes TTSR and rule:// on a retry fallback while keeping the prompt bytes", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [sonnetSelector] },
			"edit.modelVariants": { [opus.id]: "replace", [sonnet.id]: "replace" },
		});
		settings.setModelRole("default", opusSelector);
		const session = await startSession({
			model: opus,
			settings,
			rules: [
				// Rendered for both models: the prompt must not change on the hop.
				testRule("claude-style", { content: ANTHROPIC_MARKER, alwaysApply: true, class: ["anthropic"] }),
				testRule("plain", { content: UNSCOPED_MARKER, alwaysApply: true }),
				testRule("opus-guard", { condition: ["OPUS_FORBIDDEN"], family: ["opus"] }),
				testRule("sonnet-guard", { condition: ["SONNET_FORBIDDEN"], family: ["sonnet"] }),
			],
		});
		expect(session.ttsrManager?.getRules().map(r => r.name)).toEqual(["opus-guard"]);

		const mock = createMockModel();
		const sentPrompts: Array<[string, string]> = [];
		session.agent.streamFn = (model, context, options) => {
			sentPrompts.push([model.id, (context.systemPrompt ?? []).join("\n")]);
			mock.push(
				model.id === opus.id
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["Recovered on the fallback"] },
			);
			return mock.stream(model, context, options);
		};

		await session.prompt("Force a fallback off opus");
		await session.waitForIdle();

		expect(session.model?.id).toBe(sonnet.id);
		const [firstModel, firstPrompt] = sentPrompts[0];
		const [lastModel, lastPrompt] = sentPrompts.at(-1)!;
		expect([firstModel, lastModel]).toEqual([opus.id, sonnet.id]);
		expect(lastPrompt).toBe(firstPrompt);
		expect(session.ttsrManager?.getRules().map(r => r.name)).toEqual(["sonnet-guard"]);
		expect(getActiveRules().map(r => r.name)).not.toContain("opus-guard");
		expect(getActiveRules().map(r => r.name)).toContain("sonnet-guard");
	});

	it("lets a rule saved mid-session (/omfg) shadow and then replace a same-named rule at once", async () => {
		const project = path.join(dir, `add-rule-${Snowflake.next()}`);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		isolateHome(path.join(project, "home"));
		// `discoverRulesIn` uses the project as agent dir too, so `<project>/rules` holds user rules.
		const userDir = path.join(project, "rules");
		const projectDir = path.join(project, ".omp", "rules");
		const writeRules = (dir: string, body: string) =>
			Promise.all([
				Bun.write(path.join(dir, "guard.md"), `---\ncondition: GUARD_TOKEN\n---\n${body}\n`),
				Bun.write(path.join(dir, "notes.md"), `---\ndescription: notes\n---\n${body}\n`),
			]);
		await writeRules(userDir, "USER");
		const session = await startSession({
			model: opus,
			discoverRulesIn: project,
			sessionManager: SessionManager.inMemory(project),
		});
		// [TTSR guard, rule:// guard, rule:// notes]; notes lands in the rulebook bucket.
		const bodies = () => {
			const content = (rules: readonly Rule[] | undefined, name: string) =>
				rules?.find(r => r.name === name)?.content.trim();
			return [
				content(session.ttsrManager?.getRules(), "guard"),
				content(getActiveRules(), "guard"),
				content(getActiveRules(), "notes"),
			];
		};
		const save = async (body: string) => {
			await writeRules(projectDir, body);
			// As `/omfg` does after saving: drop the cached file and directory snapshots.
			for (const file of ["guard.md", "notes.md"]) invalidateCapabilityCache(path.join(projectDir, file));
			invalidateCapabilityCache(projectDir);
			await session.addRule(testRule("guard", { path: path.join(projectDir, "guard.md") }));
		};
		expect(bodies()).toEqual(["USER", "USER", "USER"]);

		await save("FIRST");
		expect(bodies()).toEqual(["FIRST", "FIRST", "FIRST"]);
		await save("SECOND");
		expect(bodies()).toEqual(["SECOND", "SECOND", "SECOND"]);
	});

	it("keeps the in-flight stream buffer when a rule is added mid-stream", async () => {
		const session = await startSession({
			model: opus,
			rules: [testRule("spanning-guard", { condition: ["SPANNING_TOKEN"] })],
		});
		const ttsr = session.ttsrManager!;
		expect(ttsr.checkDelta("before SPANNING_", { source: "text" })).toEqual([]);
		await session.addRule(testRule("live-guard", { condition: ["LIVE_TOKEN"] }));
		expect(ttsr.checkDelta("TOKEN after", { source: "text" }).map(r => r.name)).toEqual(["spanning-guard"]);
	});

	it("registers a live-added rule with TTSR when the session has no sdk rule snapshot", async () => {
		const ttsrManager = new TtsrManager();
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: opus, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			ttsrManager,
		});
		sessions.push(session);
		await session.addRule(testRule("live-guard", { condition: ["LIVE_TOKEN"] }));
		expect(ttsrManager.getRules().map(r => r.name)).toEqual(["live-guard"]);
	});

	it("keeps a rule added mid-session (/omfg) registered across a retry-fallback re-scope", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [sonnetSelector] },
		});
		settings.setModelRole("default", opusSelector);
		const session = await startSession({ model: opus, settings, rules: [] });
		await session.addRule(testRule("omfg-guard", { condition: ["OMFG_FORBIDDEN"] }));
		expect(session.ttsrManager?.getRules().map(r => r.name)).toEqual(["omfg-guard"]);

		const mock = createMockModel();
		session.agent.streamFn = (model, context, options) => {
			mock.push(
				model.id === opus.id
					? { throw: "overloaded_error: provider returned error 503" }
					: { content: ["Recovered on the fallback"] },
			);
			return mock.stream(model, context, options);
		};
		await session.prompt("Force a fallback off opus");
		await session.waitForIdle();

		expect(session.model?.id).toBe(sonnet.id);
		expect(session.ttsrManager?.getRules().map(r => r.name)).toEqual(["omfg-guard"]);
		expect(getActiveRules().map(r => r.name)).toContain("omfg-guard");
	});

	it("persists the judged variant when the model changes while the judge decides", async () => {
		const question = "Does the reply claim tests pass without having run them?";
		const opusRule = testRule("honest-tests", { question, scope: ["text"], family: ["opus"] });
		const sonnetRule = testRule("honest-tests", { question, scope: ["text"], family: ["sonnet"] });
		const session = await startSession({
			model: opus,
			settings: Settings.isolated({ "compaction.enabled": false }),
			rules: [opusRule, sonnetRule],
		});
		let judgments = 0;
		// Flags only the first output, and switches the model before answering it.
		const judge = {
			label: "fake",
			judge: async (request: JudgmentRequest) => {
				const flag = judgments++ === 0;
				if (flag) await session.setModel(sonnet);
				const answers: Record<string, NoulAnswer> = {};
				for (const id in request.questions) answers[id] = { type: "noul", noul: flag ? 1 : 0 };
				return { api: "fake", provider: "fake", model: "fake", answers, usage: {} };
			},
		} as unknown as Judge;
		vi.spyOn(session, "ruleJudge").mockReturnValue(judge);
		const mock = createMockModel();
		session.agent.streamFn = (model, context, options) => {
			mock.push({ content: ["All tests pass."] });
			return mock.stream(model, context, options);
		};

		await session.prompt("Report the test status");
		await session.waitForIdle();

		const persisted = session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "ttsr_injection" ? entry.injectedRules : []));
		expect(persisted).toEqual([ruleRecordKey(opusRule)]);
	});

	it("refreshes a live advisor's scoped rules after /clear and /new rediscover them", async () => {
		const project = path.join(dir, `advisor-refresh-${Snowflake.next()}`);
		const ruleFile = path.join(project, ".omp", "rules", "style.md");
		const writeRule = (body: string) => Bun.write(ruleFile, `---\nalwaysApply: true\nfamily: sonnet\n---\n${body}\n`);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		// Discovery reads user-level config from `os.homedir()` and the process-global agent dir;
		// point both at a temp home. A rule under that home proves discovery read it.
		const home = path.join(project, "home");
		await Bun.write(
			path.join(home, ".agents", "rules", "home-marker.md"),
			"---\nalwaysApply: true\nfamily: sonnet\n---\nTEMP_HOME_RULE_5a90\n",
		);
		isolateHome(home);
		await writeRule("ORIGINAL_ADVISOR_RULE_4e1f");
		const settings = Settings.isolated();
		settings.setModelRole("advisor", sonnetSelector);
		const session = await startSession({
			model: opus,
			settings,
			discoverRulesIn: project,
			sessionManager: SessionManager.inMemory(project),
		});
		session.setAdvisorEnabled(true);
		const advisorPrompt = () => session.getAdvisorAgent()?.state.systemPrompt.join("\n") ?? "";
		expect(advisorPrompt()).toContain("ORIGINAL_ADVISOR_RULE_4e1f");
		expect(advisorPrompt()).toContain("TEMP_HOME_RULE_5a90");

		// An unchanged rules block keeps the advisor's prompt, and its prompt cache, as is.
		const setSystemPrompt = vi.spyOn(session.getAdvisorAgent()!, "setSystemPrompt");
		await session.resetSessionContext();
		expect(setSystemPrompt).not.toHaveBeenCalled();

		await writeRule("UPDATED_ADVISOR_RULE_8b2c");
		await session.resetSessionContext();
		expect(advisorPrompt()).toContain("UPDATED_ADVISOR_RULE_8b2c");
		expect(advisorPrompt()).not.toContain("ORIGINAL_ADVISOR_RULE_4e1f");

		await writeRule("NEW_SESSION_ADVISOR_RULE_c71d");
		await session.newSession();
		expect(advisorPrompt()).toContain("NEW_SESSION_ADVISOR_RULE_c71d");
		expect(advisorPrompt()).not.toContain("UPDATED_ADVISOR_RULE_8b2c");

		await fs.rm(ruleFile);
		await session.resetSessionContext();
		expect(advisorPrompt()).not.toContain("NEW_SESSION_ADVISOR_RULE_c71d");
	});

	it("gives advisors only the always-apply rules scoped to their own model", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", sonnetSelector);
		const session = await startSession({
			model: opus,
			settings,
			rules: [...variantRules, testRule("plain", { content: UNSCOPED_MARKER, alwaysApply: true })],
		});
		session.setAdvisorEnabled(true);

		const advisorPrompt = session.getAdvisorAgent()?.state.systemPrompt.join("\n") ?? "";
		expect(advisorPrompt).toContain(SONNET_MARKER);
		expect(advisorPrompt).not.toContain(OPUS_MARKER);
		expect(advisorPrompt).not.toContain(UNSCOPED_MARKER);
	});
});

describe("advisor model-scoped rules across an advisor model change", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-rule-model-scope-advisor-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(async () => {
		await session?.dispose().catch(() => {});
		authStorage.close();
		await removeWithRetries(dir);
	});

	it("rebuilds the advisor prompt for the fallback model", async () => {
		const advisorFallback = getBundledModel("anthropic", "claude-opus-5");
		const advisorPrimary = sonnet;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { advisor: [opusSelector] },
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", sonnetSelector);
		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();
		const sentAdvisorPrompts: Array<[string, string]> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: opus, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mainMock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			advisorTools: [],
			advisorConfigs: [{ name: "scoped", model: sonnetSelector }],
			advisorModelRulesPrompt: model => (model.id === advisorPrimary.id ? SONNET_MARKER : OPUS_MARKER),
			advisorStreamFn: (model, context, options) => {
				sentAdvisorPrompts.push([model.id, (context.systemPrompt ?? []).join("\n")]);
				advisorMock.push(
					model.id === advisorPrimary.id
						? { throw: "overloaded_error: provider returned error 503" }
						: { content: ["Advisor recovered"] },
				);
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fallbackSucceeded.resolve();
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		const timedOut = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timedOut.reject(new Error("advisor retry fallback did not succeed within 3s")),
			3_000,
		);
		try {
			await Promise.race([fallbackSucceeded.promise, timedOut.promise]);
		} finally {
			clearTimeout(timer);
		}

		expect(sentAdvisorPrompts.map(([id]) => id)).toEqual([advisorPrimary.id, advisorFallback.id]);
		expect(sentAdvisorPrompts[0][1]).toContain(SONNET_MARKER);
		expect(sentAdvisorPrompts[1][1]).toContain(OPUS_MARKER);
		expect(sentAdvisorPrompts[1][1]).not.toContain(SONNET_MARKER);
	});
});
