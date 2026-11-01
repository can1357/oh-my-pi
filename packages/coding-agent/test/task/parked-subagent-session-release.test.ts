/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the run's reviver closure for as long as the agent stays adopted, so anything
 * that closure keeps reachable is retained for the life of the process; a
 * reviver that pins the disposed session leaks one full session graph per
 * spawned subagent.
 */
import { afterEach, beforeEach, expect, it as registerTest, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { readActiveTime } from "@oh-my-pi/pi-coding-agent/session/active-time";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StallReportCollector } from "@oh-my-pi/pi-coding-agent/session/stall-report";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "ParkedRelease";
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
// Collection runs in a fresh child VM with concurrent compilation disabled,
// matching the existing retention probes. The whole-suite result is sensitive
// to that compiler configuration; no particular native retainer is established.
// Keep the same deadline and consumer assertions in the isolated process.
const COLLECT_DEADLINE_MS = 15_000;

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;
const executionMode: "parent" | "child" =
	process.env.OMP_PARKED_RELEASE_CHILD === import.meta.path ? "child" : "parent";
const selectedCase = process.env.OMP_PARKED_RELEASE_CASE;
let registeredChildCases = 0;

async function runIsolatedCase(name: string, timeoutMs: number): Promise<void> {
	const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-vm-"));
	try {
		const home = path.join(sandbox, "home");
		const temp = path.join(sandbox, "tmp");
		const storageEnv = {
			HOME: home,
			PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			XDG_CONFIG_HOME: path.join(sandbox, "xdg", "config"),
			XDG_DATA_HOME: path.join(sandbox, "xdg", "data"),
			XDG_STATE_HOME: path.join(sandbox, "xdg", "state"),
			XDG_CACHE_HOME: path.join(sandbox, "xdg", "cache"),
			USERPROFILE: home,
			APPDATA: path.join(sandbox, "appdata", "roaming"),
			LOCALAPPDATA: path.join(sandbox, "appdata", "local"),
			TMPDIR: temp,
			TMP: temp,
			TEMP: temp,
		};
		await Promise.all(
			[...new Set(Object.values(storageEnv))].map(directory => fs.mkdir(directory, { recursive: true })),
		);
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			env: {
				...process.env,
				...storageEnv,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				PI_CONFIG_DIR: ".omp",
				OMP_PARKED_RELEASE_CHILD: import.meta.path,
				OMP_PARKED_RELEASE_CASE: name,
				BUN_JSC_useConcurrentJIT: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Transport headroom does not change the original child's consumer timeout.
		const watchdog = setTimeout(() => child.kill(), timeoutMs + 10_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `${stdout}${stderr}`).toBe(0);
		} finally {
			clearTimeout(watchdog);
			child.kill();
			await child.exited;
		}
	} finally {
		await removeWithRetries(sandbox);
	}
}

function it(name: string, body: () => Promise<void>, timeoutMs: number): void {
	if (executionMode === "child") {
		if (name === selectedCase) {
			registeredChildCases += 1;
			registerTest(name, body, timeoutMs);
		}
		return;
	}
	// Include pre-spawn setup and allow the transport watchdog to finish teardown.
	registerTest(name, () => runIsolatedCase(name, timeoutMs), timeoutMs + 15_000);
}

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
	if (executionMode !== "child") return;
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
	if (executionMode !== "child") return;
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
	return new WeakRef(session);
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
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	cfgContextPromotionEnabled.set(session, true);
	return new WeakRef(session.settings);
}

/** Runs `AGENT_ID` to a finished keep-alive state; `release` drops the mock's session-bound recordings. */
async function runKeptAliveSubagent(parentAgentId?: string): Promise<{ release(): void; close(): void }> {
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
			parentAgentId,
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

		const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

it("retains report receipts and persisted metrics without retaining a parked subagent's live session", async () => {
	const ownerManager = SessionManager.inMemory(root);
	const todoListeners = new Set<(phases: TodoPhase[]) => void>();
	// Only the report owner is a fixture; the observed child uses the real executor and AgentSession.
	const owner = {
		sessionManager: ownerManager,
		isStreaming: false,
		getAgentId: () => MAIN_AGENT_ID,
		getTodoPhases: () => [],
		getStallReportToolSession: () => undefined,
		subscribeTodoChanges(listener: (phases: TodoPhase[]) => void) {
			todoListeners.add(listener);
			return () => todoListeners.delete(listener);
		},
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	const ownerRef = registry.register({
		id: MAIN_AGENT_ID,
		displayName: "Main",
		kind: "main",
		session: owner,
		status: "idle",
	});
	const collector = new StallReportCollector(owner);
	let run: { release(): void; close(): void } | undefined;
	try {
		run = await runKeptAliveSubagent(MAIN_AGENT_ID);
		const sessionRef = weakRefToLiveSession(AGENT_ID);
		const settingsRef = writeAndObserveLiveSettings(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		expect(await collected(settingsRef, COLLECT_DEADLINE_MS)).toBe(true);
		expect(await collected(sessionRef, COLLECT_DEADLINE_MS)).toBe(true);
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);

		const parked = registry.get(AGENT_ID)!;
		expect(parked).toMatchObject({ status: "parked", session: null });
		const persisted = await SessionManager.open(parked.sessionFile!);
		try {
			expect(readActiveTime(persisted.getBranch())).toEqual(parked.activeTime!);
			expect(parked.activeTime?.historicalUnavailable).toBe(false);
		} finally {
			await persisted.close();
		}
		const receipt = await collector.collect();
		expect(receipt.text).toContain(`status_changed: “${AGENT_ID}” → parked`);
		expect(receipt.text).toContain(`### “${AGENT_ID}”`);
		expect(receipt.text).toMatch(
			/TOTAL turns [1-9]\d*; tool calls [1-9]\d*; active time \d+s total observed running windows/,
		);
		// Collection is read-only: pending receipts survive until their actual delivery is committed.
		expect((await collector.collect()).text).toContain(`### “${AGENT_ID}”`);
		receipt.commit();
		expect((await collector.collect()).text).not.toContain(`### “${AGENT_ID}”`);
		const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
	} finally {
		let remainingTodoListeners: number | undefined;
		try {
			collector.dispose();
			remainingTodoListeners = todoListeners.size;
		} finally {
			try {
				registry.unregister(MAIN_AGENT_ID, ownerRef);
			} finally {
				try {
					await ownerManager.close();
				} finally {
					run?.close();
				}
			}
		}
		expect(remainingTodoListeners).toBe(0);
	}
}, 30_000);

if (executionMode === "child" && registeredChildCases !== 1) {
	throw new Error(`Expected one parked-release child case, registered ${registeredChildCases}`);
}
