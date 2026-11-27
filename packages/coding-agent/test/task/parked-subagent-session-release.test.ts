/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the run's reviver closure for as long as the agent stays adopted, so anything
 * that closure keeps reachable is retained for the life of the process; a
 * reviver that pins the disposed session leaks one full session graph per
 * spawned subagent.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockHandler, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { artifactsDirsFromRegistry } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "ParkedRelease";
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
// After earlier files warm the session code, JSC's optimizing-JIT worklist can
// keep an object referenced by an in-flight compile reachable for a few seconds
// (observed ~4 s locally, >8 s on loaded CI runners); collection is polled past
// that window. A healthy release returns on the first poll that sees it collected,
// so the deadline only bounds how long a real leak takes to fail.
const COLLECT_DEADLINE_MS = 15_000;

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Kept out of the test body so no strong local binding outlives the capture. */
function weakRefToLiveSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	return new WeakRef(localSession(session));
}

async function collected(ref: WeakRef<object>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}

/** Makes a settings write in the live session's own overlay, then observes the overlay weakly (outside the test body). */
function writeAndObserveLiveSettings(id: string): WeakRef<Settings> {
	const session = localSession(AgentRegistry.global().get(id)?.session);
	cfgContextPromotionEnabled.set(session, true);
	return new WeakRef(session.settings);
}

/** Runs `AGENT_ID` to a finished keep-alive state; `release` drops the mock's session-bound recordings. */
async function runKeptAliveSubagent(): Promise<{ release(): void; close(): void }> {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the test parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		authStorage.close();
		throw error;
	}
	return {
		// Recorded mock calls carry stream options with closures bound to the session.
		release: () => {
			mock.reset();
			availableSpy.mockRestore();
		},
		close: () => authStorage.close(),
	};
}

it("releases a parked keep-alive subagent's session while the agent stays revivable", async () => {
	const run = await runKeptAliveSubagent();
	try {
		const sessionRef = weakRefToLiveSession(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		expect(AgentRegistry.global().get(AGENT_ID)).toMatchObject({ status: "parked", session: null });
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);

		run.release();
		expect(await collected(sessionRef, COLLECT_DEADLINE_MS)).toBe(true);
		// Still adopted after collection: the release did not come from dropping the reviver.
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

it("parks without retaining the run's settings overlay and revives with the settings it wrote", async () => {
	const run = await runKeptAliveSubagent();
	try {
		// A write the subagent made to its own settings during the run.
		const settingsRef = writeAndObserveLiveSettings(AGENT_ID);

		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		// The reviver held the run's whole overlay — merged view, memoized values, listener buckets —
		// for as long as the parked agent stayed adopted.
		expect(await collected(settingsRef, COLLECT_DEADLINE_MS)).toBe(true);

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

/** Answers `done` (through `yield` when the run offers it), or `label` to the task label call, which offers no tools. */
const doneHandler: MockHandler = context => {
	const tools = context.tools ?? [];
	if (tools.some(tool => tool.name === "yield")) {
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
	}
	return { content: [tools.some(tool => tool.name === "read") ? "done" : "label"] };
};

/** A skill the parent session loaded, which each of its spawns passes on. */
function skillNamed(name: string): Skill {
	const baseDir = path.join(root, "skills", name);
	return { name, description: `The ${name} skill`, filePath: path.join(baseDir, "SKILL.md"), baseDir, source: "user" };
}

function namesOf(skills: readonly Skill[]): string[] {
	return skills.map(skill => skill.name);
}

/** The mock model a parent's children run on, and the auth and model registry that resolve it. */
interface ChildModel {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	/** Parent settings that run each child once on the mock model and leave it kept alive until the test parks it. */
	settings: Settings;
	/** Drops the mock's recorded calls: their stream options hold closures bound to the children's sessions. */
	releaseRecordings(): void;
}

function childModel(): ChildModel {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const model = createMockModel({ handler: doneHandler });
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === "mock" && id === model.id ? model : find(provider, id),
	);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [model]);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => [model]);
	const selector = `mock/${model.id}`;
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.isolation.enabled": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		// Vibe workers select their model by role: `good` ones through `task`, `fast` ones through `smol`.
		modelRoles: { default: selector, task: selector, smol: selector },
	});
	return { authStorage, modelRegistry, settings, releaseRecordings: () => model.reset() };
}

/** A parent session, and the spawns of its kept-alive children. */
interface SkillParent {
	/** Runs child `id` to its finished keep-alive state and returns the names of the skills its live session holds. */
	spawn(id: string): Promise<string[]>;
	releaseRecordings(): void;
	close(): void;
}

/** A parent session whose skills are what `skills` returns when a child spawns. */
async function skillParent(skills: () => readonly Skill[]): Promise<SkillParent> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const { authStorage, modelRegistry, settings, releaseRecordings } = childModel();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "skill-agent",
				description: "Runs with its parent's skills",
				systemPrompt: "test",
				source: "project",
				tools: ["read"],
			},
		],
		projectAgentsDir: null,
	});

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		// The children's transcripts go next to it, under the test's root, where they outlive each run for a revive.
		getSessionFile: () => path.join(root, "parent.jsonl"),
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		get skills() {
			return skills();
		},
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		extensionPaths: [],
		customToolPaths: [],
	};
	return {
		spawn: async id => {
			const { result } = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "report done",
				agent: "skill-agent",
				structured: false,
				identity: { id },
			});
			expect(result.exitCode, result.error).toBe(0);
			return namesOf(localSession(AgentRegistry.global().get(id)?.session).skills);
		},
		releaseRecordings,
		close: () => authStorage.close(),
	};
}

/** A Vibe parent session with a session file under the test's root, and the spawns of its workers. */
interface VibeParent {
	/** Spawns a `good` worker named `name`, waits for its first turn to settle, and returns the worker's id. */
	spawn(name: string): Promise<string>;
	releaseRecordings(): void;
	/** The `omp-vibe-*` directories made in the temp dir, and the temp dirs still registered as artifact dirs. */
	tempArtifactDirs(): Promise<{ made: string[]; registered: string[] }>;
	close(): Promise<void>;
}

/** A Vibe parent session whose skills are what `skills` returns when a worker spawns. */
async function vibeParent(skills: () => readonly Skill[]): Promise<VibeParent> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	// A worker spawned without a parent session file gets an `omp-vibe-*` artifact dir in the temp dir, registered for
	// the life of the process. The temp dir is moved under the test's root so that any such dir is seen and removed.
	const tmp = path.join(root, "tmp");
	await fs.mkdir(tmp, { recursive: true });
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	const { authStorage, modelRegistry, settings, releaseRecordings } = childModel();
	// The workers' transcripts and artifacts go next to the parent's session file, under the test's root.
	const sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
	const asyncJobManager = new AsyncJobManager({ onJobComplete: () => {} });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager,
		sessionManager,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
		get skills() {
			return skills();
		},
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		extensionPaths: [],
		customToolPaths: [],
	};
	return {
		spawn: async name => {
			const { id, jobId } = await VibeSessionRegistry.global().spawn(session, {
				cli: "good",
				name,
				prompt: "report done",
			});
			const job = asyncJobManager.getJob(jobId);
			await job?.promise;
			expect(job?.status, job?.errorText).toBe("completed");
			return id;
		},
		releaseRecordings,
		tempArtifactDirs: async () => ({
			made: (await fs.readdir(tmp)).filter(name => name.startsWith("omp-vibe-")),
			registered: artifactsDirsFromRegistry().filter(dir => dir.startsWith(tmp)),
		}),
		close: async () => {
			await asyncJobManager.dispose({ timeoutMs: 1_000 });
			VibeSessionRegistry.resetGlobalForTests();
			await sessionManager.close();
			authStorage.close();
		},
	};
}

/** Parks kept-alive child `id` and returns what its registry entry still holds. */
async function park(id: string): Promise<{ status: string | undefined; live: boolean }> {
	await AgentLifecycleManager.global().park(id);
	const ref = AgentRegistry.global().get(id);
	return { status: ref?.status, live: ref?.session != null };
}

async function revivedSkillNames(id: string): Promise<string[]> {
	return namesOf(localSession(await AgentLifecycleManager.global().ensureLive(id)).skills);
}

/** Observes weakly the skill list child `id`'s live session holds (outside the test body). */
function weakRefToLiveSkills(id: string): WeakRef<readonly Skill[]> {
	return new WeakRef(localSession(AgentRegistry.global().get(id)?.session).skills);
}

// If this regresses, a child spawned once its parent replaced its skill list (as a skill refresh does) gets the old
// skills, or a parked child comes back with its parent's current skills instead of the ones it was spawned with.
it("spawns a child with its parent's replaced skill list and revives parked siblings with their own", async () => {
	let parentSkills = ["alpha", "beta", "gamma"].map(skillNamed);
	const parent = await skillParent(() => parentSkills);
	try {
		const siblings = [await parent.spawn("ReplacedFirst"), await parent.spawn("ReplacedSecond")];
		const parked = [await park("ReplacedFirst"), await park("ReplacedSecond")];
		parentSkills = ["delta", "epsilon"].map(skillNamed);
		const third = await parent.spawn("ReplacedThird");
		const revived = [await revivedSkillNames("ReplacedFirst"), await revivedSkillNames("ReplacedSecond")];
		expect({ siblings, parked, third, revived }).toEqual({
			siblings: [
				["alpha", "beta", "gamma"],
				["alpha", "beta", "gamma"],
			],
			parked: [
				{ status: "parked", live: false },
				{ status: "parked", live: false },
			],
			third: ["delta", "epsilon"],
			revived: [
				["alpha", "beta", "gamma"],
				["alpha", "beta", "gamma"],
			],
		});
	} finally {
		parent.close();
	}
}, 60_000);

// If this regresses, an SDK caller that edits the array it handed its session (replaces an entry, or empties and
// refills it) still spawns children with the skills it held before the edit, or a parked child comes back with the
// edited skills instead of the ones it was spawned with.
it("spawns a child with its parent's skill list as edited in place and revives a parked child with its own", async () => {
	// The SDK keeps the caller's array as the session's skills.
	const parentSkills = ["alpha", "beta", "gamma"].map(skillNamed);
	const parent = await skillParent(() => parentSkills);
	try {
		const first = await parent.spawn("EditedFirst");
		const parked = await park("EditedFirst");
		parentSkills[1] = skillNamed("zeta");
		const replacedEntry = await parent.spawn("EditedSecond");
		parentSkills.length = 0;
		const emptied = await parent.spawn("EditedThird");
		parentSkills.push(skillNamed("alpha"), skillNamed("eta"), skillNamed("gamma"));
		const refilled = await parent.spawn("EditedFourth");
		const revived = await revivedSkillNames("EditedFirst");
		expect({ first, parked, replacedEntry, emptied, refilled, revived }).toEqual({
			first: ["alpha", "beta", "gamma"],
			parked: { status: "parked", live: false },
			replacedEntry: ["alpha", "zeta", "gamma"],
			emptied: [],
			refilled: ["alpha", "eta", "gamma"],
			revived: ["alpha", "beta", "gamma"],
		});
	} finally {
		parent.close();
	}
}, 60_000);

// If this regresses, a parent that empties its skill list in place keeps its copy of the old list in memory for as long
// as the list lives, even once no child holds that copy.
it("lets the copy of a parent's skill list go once a child spawns from the emptied list", async () => {
	const alpha = skillNamed("alpha");
	const beta = skillNamed("beta");
	const parentSkills = [alpha, beta];
	const parent = await skillParent(() => parentSkills);
	try {
		const first = await parent.spawn("EvictedFirst");
		const copyRef = weakRefToLiveSkills("EvictedFirst");
		// End the only child holding the copy, with its reviver.
		const released = await AgentLifecycleManager.global().release("EvictedFirst");
		parentSkills.length = 0;
		const emptied = await parent.spawn("EvictedSecond");
		parent.releaseRecordings();
		// The parent's list is still live here, so the copy is collected only if nothing keeps it for that list.
		const copyCollected = await collected(copyRef, COLLECT_DEADLINE_MS);
		// Refilled with the same skills, in the same order.
		parentSkills.push(alpha, beta);
		const refilled = await parent.spawn("EvictedThird");
		expect({ first, released, emptied, copyCollected, refilled }).toEqual({
			first: ["alpha", "beta"],
			released: true,
			emptied: [],
			copyCollected: true,
			refilled: ["alpha", "beta"],
		});
	} finally {
		parent.close();
	}
}, 60_000);

/** Skills in the parent's list in the retention tests, and in the calibration lists the test holds itself. */
const MARKED_SKILLS = 128;
/** Children parked before the first census, so the second one sees only what further children add. */
const WARMUP_CHILDREN = 8;
/** Children parked between the two censuses. */
const MEASURED_CHILDREN = 32;
/**
 * Lists a census may count that no parked child keeps: an object let go just before a census can stay reachable for a
 * few seconds (see {@link COLLECT_DEADLINE_MS}). A copy for each child adds {@link MEASURED_CHILDREN} lists.
 */
const TRANSIENT_LISTS = MEASURED_CHILDREN / 4;

/** Skills that each carry a property no other object in the process has, so a census can find them. */
interface MarkedSkills {
	/** The name of the property each of these skills carries. */
	marker: string;
	/** The one list that holds these skills when they are made. */
	skills: Skill[];
}

function markedSkills(kind: string): MarkedSkills {
	const marker = `${kind}Marker-${crypto.randomUUID()}`;
	// Not enumerable, so a spread of a skill makes an unmarked object. The value is a string, a heap cell that the
	// snapshot links each skill to.
	const skills = Array.from({ length: MARKED_SKILLS }, (_, index) =>
		Object.defineProperty(skillNamed(`${kind}-${index}`), marker, { value: marker }),
	);
	return { marker, skills };
}

/**
 * Counts, in one heap snapshot, the lists that hold every skill of each set in `sets`, whatever keeps those lists.
 * `Bun.generateHeapSnapshot()` returns JavaScriptCore's heap snapshot, in JavaScriptCore's own format, not V8's: each
 * node is [id, size, class name index, flags] and each edge is [from id, to id, edge type index, property name index or
 * element index]. It counts lists, not bytes: the snapshot does not size the storage of a frozen array's entries.
 */
function markedListCensus(sets: readonly MarkedSkills[]): number[] {
	Bun.gc(true);
	const { nodes, nodeClassNames, edges, edgeTypes, edgeNames } = Bun.generateHeapSnapshot();
	const property = edgeTypes.indexOf("Property");
	const markers = sets.map(set => edgeNames.indexOf(set.marker));
	expect([property, ...markers]).not.toContain(-1);
	// Each marked skill, by the set whose marker property it has.
	const setOf = new Map<number, number>();
	for (let at = 0; at < edges.length; at += 4) {
		if (edges[at + 2] !== property) continue;
		const set = markers.indexOf(edges[at + 3]);
		if (set !== -1) setOf.set(edges[at], set);
	}
	const found = sets.map(() => 0);
	for (const set of setOf.values()) found[set]++;
	expect(found).toEqual(sets.map(set => set.skills.length));
	// The distinct marked skills each node holds, by set.
	const held = sets.map(() => new Map<number, Set<number>>());
	for (let at = 0; at < edges.length; at += 4) {
		const set = setOf.get(edges[at + 1]);
		if (set === undefined) continue;
		const holder = edges[at];
		const skills = held[set].get(holder) ?? new Set<number>();
		skills.add(edges[at + 1]);
		held[set].set(holder, skills);
	}
	// Lists only: a plain array holds its entries itself; a frozen one, through the sparse map it points to.
	const listClasses = ["Array", "SparseArrayValueMap"].map(name => nodeClassNames.indexOf(name));
	expect(listClasses).not.toContain(-1);
	const lists = sets.map(() => 0);
	for (let at = 0; at < nodes.length; at += 4) {
		if (!listClasses.includes(nodes[at + 2])) continue;
		for (const [set, holders] of held.entries()) {
			if (holders.get(nodes[at])?.size === sets[set].skills.length) lists[set]++;
		}
	}
	return lists;
}

/** One snapshot's count of the lists that hold every fixture skill, and of those that hold every calibration skill. */
interface ListCounts {
	fixture: number;
	calibration: number;
}

/** Censuses taken as a parent's children park. */
interface ParkedRetention {
	/** After {@link WARMUP_CHILDREN} children parked. */
	before: ListCounts;
	/** After {@link MEASURED_CHILDREN} more children parked. */
	after: ListCounts;
}

/**
 * Spawns children through `spawnChild`, which returns each child's id, and parks each one. After parking, the registry
 * has no live child session (`session: null`). Takes a census once {@link WARMUP_CHILDREN} children are parked and again
 * once {@link MEASURED_CHILDREN} more are. The snapshot counts skill-list holders in the process, regardless of what
 * retains them.
 *
 * Census control: through both censuses the test holds a calibration set of skills in exactly two lists, one plain and
 * one frozen, and each census must count exactly those two. The fixture's count leaves them out: they hold other skills.
 */
async function parkedChildRetention(
	fixture: MarkedSkills,
	spawnChild: (name: string) => Promise<string>,
	releaseRecordings: () => void,
): Promise<ParkedRetention> {
	const calibration = markedSkills("calibration");
	const frozenCalibration = Object.freeze([...calibration.skills]);
	const census = (): ListCounts => {
		const [fixtureLists, calibrationLists] = markedListCensus([fixture, calibration]);
		return { fixture: fixtureLists, calibration: calibrationLists };
	};
	let spawned = 0;
	const parkChildren = async (count: number) => {
		const parked: Array<{ status: string | undefined; live: boolean }> = [];
		for (let child = 0; child < count; child++) parked.push(await park(await spawnChild(`Parked${spawned++}`)));
		expect(parked).toEqual(Array.from({ length: count }, () => ({ status: "parked", live: false })));
		releaseRecordings();
	};
	await parkChildren(WARMUP_CHILDREN);
	const before = census();
	await parkChildren(MEASURED_CHILDREN);
	const after = census();
	// Reads both calibration lists after the last census, so that they are live while it runs.
	expect(
		{
			calibration: [before.calibration, after.calibration],
			calibrationLists: [calibration.skills.length, frozenCalibration.length],
		},
		JSON.stringify({ before, after }),
	).toEqual({ calibration: [2, 2], calibrationLists: [MARKED_SKILLS, MARKED_SKILLS] });
	return { before, after };
}

// If this regresses, each `task` child a parent spawns on its thread gets a copy of the parent's whole skill list of its
// own, and a parked one keeps it for as long as it can be revived.
it("keeps no copy of its parent's skill list for each parked task child", async () => {
	const fixture = markedSkills("fixture");
	const parent = await skillParent(() => fixture.skills);
	try {
		const spawnChild = async (id: string) => {
			await parent.spawn(id);
			return id;
		};
		const retention = await parkedChildRetention(fixture, spawnChild, parent.releaseRecordings);
		expect(retention.after.fixture - retention.before.fixture, JSON.stringify(retention)).toBeLessThan(
			TRANSIENT_LISTS,
		);
	} finally {
		parent.close();
	}
}, 120_000);

// Control for the case above: if the census missed the copies parked children keep, both cases would pass.
it("counts one skill list for each parked task child given a copy of its own", async () => {
	const fixture = markedSkills("fixture");
	// A new array on each read, as when each spawn copies the list: each child keeps a copy of its own.
	const parent = await skillParent(() => [...fixture.skills]);
	try {
		const spawnChild = async (id: string) => {
			await parent.spawn(id);
			return id;
		};
		const retention = await parkedChildRetention(fixture, spawnChild, parent.releaseRecordings);
		expect(retention.after.fixture - retention.before.fixture, JSON.stringify(retention)).toBeGreaterThan(
			MEASURED_CHILDREN - TRANSIENT_LISTS,
		);
	} finally {
		parent.close();
	}
}, 120_000);

// If this regresses, each vibe worker a parent spawns on its thread gets a copy of the parent's whole skill list of its
// own, and a parked one keeps it for as long as it can be revived.
it("keeps no copy of its parent's skill list for each parked vibe worker", async () => {
	const fixture = markedSkills("fixture");
	const parent = await vibeParent(() => fixture.skills);
	try {
		const retention = await parkedChildRetention(fixture, parent.spawn, parent.releaseRecordings);
		expect(retention.after.fixture - retention.before.fixture, JSON.stringify(retention)).toBeLessThan(
			TRANSIENT_LISTS,
		);
		expect(await parent.tempArtifactDirs()).toEqual({ made: [], registered: [] });
	} finally {
		await parent.close();
	}
}, 120_000);

// Control for the case above: if the census missed the copies parked workers keep, both cases would pass.
it("counts one skill list for each parked vibe worker given a copy of its own", async () => {
	const fixture = markedSkills("fixture");
	// A new array on each read, as when each spawn copies the list: each worker keeps a copy of its own.
	const parent = await vibeParent(() => [...fixture.skills]);
	try {
		const retention = await parkedChildRetention(fixture, parent.spawn, parent.releaseRecordings);
		expect(retention.after.fixture - retention.before.fixture, JSON.stringify(retention)).toBeGreaterThan(
			MEASURED_CHILDREN - TRANSIENT_LISTS,
		);
		expect(await parent.tempArtifactDirs()).toEqual({ made: [], registered: [] });
	} finally {
		await parent.close();
	}
}, 120_000);
