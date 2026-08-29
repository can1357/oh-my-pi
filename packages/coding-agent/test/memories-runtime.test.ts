import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	getMemoryRoot,
	startMemoryStartupTask,
} from "@oh-my-pi/pi-coding-agent/memories";
import * as memoryStorage from "@oh-my-pi/pi-coding-agent/memories/storage";
import { getAgentDbPath, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

interface SessionFixture {
	agentDir: string;
	sessionDir: string;
	sessionFile: string;
	settings: Settings;
	session: any;
	modelRegistry: any;
	model: Model;
	whenSettled: Promise<void>;
}

let sharedRoot: TempDir | undefined;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}
async function makeTempDir(prefix: string): Promise<string> {
	const base = sharedRoot?.path() ?? os.tmpdir();
	const dir = path.join(base, `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

function createModel(id = "test-model"): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

function createModelRegistry(model: Model): any {
	return {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
		resolver: vi.fn(() => async () => "test-api-key"),
	};
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<SessionFixture> {
	const agentDir = await makeTempDir("memories-runtime-agent");
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);

	const settings = Settings.isolated({
		"memories.enabled": true,
		"memories.minRolloutIdleHours": 0,
		"memories.maxRolloutsPerStartup": 16,
		"memories.threadScanLimit": 64,
		"memories.phase2HeartbeatSeconds": 1,
		...(overrides ?? {}),
	});
	const model = createModel();
	const modelRegistry = createModelRegistry(model);
	const settled = deferred();
	const refreshBaseSystemPrompt = vi.fn(async () => {
		settled.resolve();
	});
	const session = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionDir: () => sessionDir,
			getSessionId: () => "current-thread",
			getCwd: () => agentDir,
		},
		settings,
		model,
		modelRegistry,
		refreshBaseSystemPrompt,
	};

	return { agentDir, sessionDir, sessionFile, settings, session, modelRegistry, model, whenSettled: settled.promise };
}

// Resolve any already-scheduled microtasks/macrotasks without a fixed wall delay.
const flushAsync = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0));

// Await the pipeline's completion signal (its final `refreshBaseSystemPrompt`)
// instead of polling, racing a generous timeout so a stalled regression fails
// loudly rather than hanging.
async function settle(promise: Promise<void>, label: string, timeoutMs = 3000): Promise<void> {
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
	});
	try {
		await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

beforeAll(async () => {
	sharedRoot = await TempDir.create(`@memories-runtime-${Snowflake.next()}`);
});

afterAll(async () => {
	if (sharedRoot) {
		await Bun.sleep(0);
		await sharedRoot.remove();
	}
	sharedRoot = undefined;
});

describe("memories runtime", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		// Prevent getXdgDataPath/getXdgStatePath from resolving to real user data
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("XDG_DATA_HOME", savedXdgData);
		restoreEnvValue("XDG_STATE_HOME", savedXdgState);
	});

	test("startup gating follows memory.backend and skips subagents", async () => {
		const disabled = await createFixture({ "memories.enabled": false });
		const openSpy = vi.spyOn(memoryStorage, "openMemoryDb");
		startMemoryStartupTask({
			session: disabled.session,
			settings: disabled.settings,
			modelRegistry: disabled.modelRegistry,
			agentDir: disabled.agentDir,
			taskDepth: 0,
		});
		expect(openSpy).not.toHaveBeenCalled();
		const explicitlyOff = await createFixture({ "memory.backend": "off", "memories.enabled": true });
		startMemoryStartupTask({
			session: explicitlyOff.session,
			settings: explicitlyOff.settings,
			modelRegistry: explicitlyOff.modelRegistry,
			agentDir: explicitlyOff.agentDir,
			taskDepth: 0,
		});
		expect(openSpy).not.toHaveBeenCalled();

		const subagent = await createFixture({ "memories.enabled": true });
		startMemoryStartupTask({
			session: subagent.session,
			settings: subagent.settings,
			modelRegistry: subagent.modelRegistry,
			agentDir: subagent.agentDir,
			taskDepth: 1,
		});
		expect(openSpy).not.toHaveBeenCalled();
	});

	test("startup gating skips when DB is unavailable", async () => {
		const fx = await createFixture();
		vi.spyOn(memoryStorage, "openMemoryDb").mockImplementation(() => {
			throw new Error("db unavailable");
		});
		const stage1Spy = vi.spyOn(ai, "completeSimple");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await flushAsync();
		expect(stage1Spy).not.toHaveBeenCalled();
	});

	test("runs phase1 to phase2 and writes consolidated outputs", async () => {
		const fx = await createFixture();
		const rolloutPath = path.join(fx.sessionDir, "thread-a.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-a", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							rollout_summary: "Rollout summary A",
							rollout_slug: "thread-a-rollout",
							raw_memory: "Raw memory A",
						}),
					},
				],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			} as any)
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							memory_md: "# Memory\n\nConsolidated body",
							memory_summary: "Consolidated summary",
							skills: [{ name: "deploy-playbook", content: "# Deploy\nUse blue/green." }],
						}),
					},
				],
			} as any);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await settle(fx.whenSettled, "phase1->phase2 pipeline");
		expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe(
			"# Memory\n\nConsolidated body",
		);
		expect((await fs.readFile(path.join(memoryRoot, "memory_summary.md"), "utf8")).trim()).toBe(
			"Consolidated summary",
		);
		expect((await fs.readFile(path.join(memoryRoot, "skills", "deploy-playbook", "SKILL.md"), "utf8")).trim()).toBe(
			"# Deploy\nUse blue/green.",
		);
		expect(fx.session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ai.completeSimple).toHaveBeenCalled();
		expect(ai.completeSimple).toHaveBeenCalledTimes(2);
		const phase2Prompt = completeSpy.mock.calls[1]?.[1];
		expect(phase2Prompt?.systemPrompt?.[0]).toContain("memory-stage-two consolidator");
	});

	test("clamps stage1 and phase2 reasoning effort against the model's supported range", async () => {
		// Regression for #1480: memory pipeline hardcoded `Effort.Low`/`Effort.Medium`,
		// which `requireSupportedEffort` rejects on models whose supported range starts
		// above `low` (e.g. deepseek-v4-pro → [high, xhigh]). The fix routes both call
		// sites through `clampThinkingLevelForModel`, lifting the requested effort to
		// the model's floor instead of throwing.
		const fx = await createFixture();
		const constrainedModel: Model = {
			...fx.model,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.XHigh] },
		};
		fx.session.model = constrainedModel;
		fx.modelRegistry.find = vi.fn(() => constrainedModel);
		fx.modelRegistry.getAll = vi.fn(() => [constrainedModel]);

		const rolloutPath = path.join(fx.sessionDir, "thread-constrained.jsonl");
		const rolloutRows = [
			{ type: "session", id: "thread-constrained", cwd: fx.agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(rolloutPath, `${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`);

		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							rollout_summary: "Rollout summary",
							rollout_slug: "thread-constrained",
							raw_memory: "Raw memory",
						}),
					},
				],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			} as any)
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							memory_md: "# Memory\n\nBody",
							memory_summary: "Summary",
							skills: [],
						}),
					},
				],
			} as any);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await settle(fx.whenSettled, "effort-clamp pipeline");
		expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe("# Memory\n\nBody");

		expect(spy).toHaveBeenCalledTimes(2);
		// stage1 requested `low`, phase2 requested `medium`; both must clamp up to the
		// model's floor (`high`) instead of being passed through and throwing.
		expect(spy.mock.calls[0]?.[2]?.reasoning).toBe(Effort.High);
		expect(spy.mock.calls[1]?.[2]?.reasoning).toBe(Effort.High);
	});

	test("phase2 sync prunes stale summaries and preserves raw memory ordering", async () => {
		const fx = await createFixture();
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						memory_md: "# Memory\n\nMerged",
						memory_summary: "Merged summary",
						skills: [{ name: "ops", content: "# Ops\nRunbook" }],
					}),
				},
			],
		} as any);

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "thread-a",
				updatedAt: 100,
				rolloutPath: "/tmp/a.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
			{
				id: "thread-b",
				updatedAt: 200,
				rolloutPath: "/tmp/b.jsonl",
				cwd: fx.session.sessionManager.getCwd(),
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-a", 100, "raw-a", "summary-a", "alpha", 100);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-b", 200, "raw-b", "summary-b", "beta", 200);
		memoryStorage.enqueueGlobalWatermark(db, 200, fx.session.sessionManager.getCwd(), {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "rollout_summaries"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "rollout_summaries", "old.md"), "stale");

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await settle(fx.whenSettled, "phase2 sync/prune");
		const files = await fs.readdir(path.join(memoryRoot, "rollout_summaries"));
		expect(files.includes("old.md")).toBe(false);
		expect(files).toEqual(expect.arrayContaining(["thread-a-alpha.md", "thread-b-beta.md"]));
		const raw = await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8");
		expect(raw.indexOf("## thread-b")).toBeLessThan(raw.indexOf("## thread-a"));
	});

	test("phase2 empty-input cleanup removes consolidated files and skills dir", async () => {
		const fx = await createFixture();
		const memoryRoot = getMemoryRoot(fx.agentDir, fx.session.sessionManager.getCwd());
		await fs.mkdir(path.join(memoryRoot, "skills", "legacy"), { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "MEMORY.md"), "legacy memory");
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "legacy summary");
		await fs.writeFile(path.join(memoryRoot, "skills", "legacy", "SKILL.md"), "legacy skill");

		const db = memoryStorage.openMemoryDb(getAgentDbPath(fx.agentDir));
		memoryStorage.enqueueGlobalWatermark(db, 300, fx.session.sessionManager.getCwd(), {
			forceDirtyWhenNotAdvanced: true,
		});
		memoryStorage.closeMemoryDb(db);

		startMemoryStartupTask({
			session: fx.session,
			settings: fx.settings,
			modelRegistry: fx.modelRegistry,
			agentDir: fx.agentDir,
			taskDepth: 0,
		});

		await settle(fx.whenSettled, "phase2 empty-input cleanup");
		expect(await Bun.file(path.join(memoryRoot, "MEMORY.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(memoryRoot, "memory_summary.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(memoryRoot, "skills")).exists()).toBe(false);
		expect((await fs.readFile(path.join(memoryRoot, "raw_memories.md"), "utf8")).trim()).toBe(
			"# Raw Memories\n\nNo raw memories yet.",
		);
	});
});

describe("buildMemoryToolDeveloperInstructions", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("XDG_DATA_HOME", savedXdgData);
		restoreEnvValue("XDG_STATE_HOME", savedXdgState);
	});

	test("returns undefined for missing or empty summaries", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({ "memory.backend": "local" });

		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();

		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "   \n\t\n");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings)).toBeUndefined();
	});

	test("renders payload with truncation for non-empty summary", async () => {
		const agentDir = await makeTempDir("memories-runtime-instructions");
		const settings = Settings.isolated({
			"memory.backend": "local",
			"memories.summaryInjectionTokenLimit": 8,
		});
		const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(
			path.join(memoryRoot, "memory_summary.md"),
			`${"A".repeat(120)}\n${"B".repeat(120)}\n${"C".repeat(120)}`,
		);

		const payload = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(payload).toBeDefined();
		expect(payload).toContain("memory://root/memory_summary.md");
		expect(payload).not.toContain(memoryRoot);
		expect(payload).toContain("...[truncated]...");
	});
});
