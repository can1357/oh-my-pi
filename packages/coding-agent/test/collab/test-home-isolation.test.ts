/**
 * Contract: collab tests never leak guest replica `.jsonl` files or host
 * discovery sockets into the developer's real `~/.omp`.
 *
 * 1. `installInMemoryRelay()` redirects an unmocked `os.homedir()` into a
 *    per-install temp directory (while preserving an explicit `setAgentDir()`
 *    override or caller-owned `os.homedir()` spy) and `uninstallInMemoryRelay()`
 *    removes that temp directory cleanly.
 * 2. Without home isolation (`installInMemoryRelay({ isolateHome: false })`),
 *    `isBunTestRuntime()` refuses unisolated real `~/.omp` paths with
 *    `CollabTestIsolationError` before touching disk, while honoring explicit
 *    overrides (`getConfigRootDir()` spy, `os.homedir()` spy, `options.dir`,
 *    `options.replicaDir`, and temp directories inside `$HOME` outside `.omp`
 *    such as Windows `%USERPROFILE%\AppData\Local\Temp`).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { assertIsolatedTestCollabDir, CollabTestIsolationError } from "@oh-my-pi/pi-coding-agent/collab/paths";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { collabHostsRuntimeDir, listCollabHosts } from "@oh-my-pi/pi-coding-agent/collab/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as utils from "@oh-my-pi/pi-utils";
import {
	directoryExists,
	getAgentDir,
	getConfigDirName,
	getConfigRootDir,
	isEnoent,
	pathIsWithin,
	refreshDirsFromEnv,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const REAL_HOMEDIR = os.homedir();
const ISOLATED_DIR_ENV_KEYS = [
	"OMP_PROFILE",
	"PI_PROFILE",
	"OMP_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_CONFIG_DIR",
	"PI_CONFIG_DIR",
] as const;
const ORIGINAL_DIR_ENV = new Map<string, string | undefined>(
	ISOLATED_DIR_ENV_KEYS.map(key => [key, process.env[key] ?? Bun.env[key]]),
);

function realConfigDir(): string {
	return path.join(REAL_HOMEDIR, getConfigDirName());
}

async function snapshotDirEntries(dir: string): Promise<string[] | null> {
	try {
		return (await fs.readdir(dir)).sort();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

function makeHostContext(sessionId: string): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session" as const, id: sessionId, timestamp: "2026-11-10T00:00:00Z", cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "isolation-test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

function makeGuestContext(onReplicaSwitch: (replicaPath: string) => void): InteractiveModeContext {
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => undefined,
			getCwd: () => "/tmp",
		},
		session: {
			switchSession: async (replicaPath: string) => {
				onReplicaSwitch(replicaPath);
				return true;
			},
			newSession: () => Promise.resolve(),
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => Promise.resolve(),
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

const cleanupPaths: string[] = [];

beforeEach(() => {
	for (const key of ISOLATED_DIR_ENV_KEYS) {
		restoreEnvValue(key, undefined);
	}
	utils.__resetDirsFromEnvForTests();
});

afterEach(async () => {
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
	for (const [key, value] of ORIGINAL_DIR_ENV) {
		restoreEnvValue(key, value);
	}
	utils.__resetDirsFromEnvForTests();
	for (const target of cleanupPaths.splice(0)) {
		await removeWithRetries(target);
	}
});

describe("collab test home isolation", () => {
	it("isolates host discovery and guest replicas inside installInMemoryRelay's temp home and removes it on uninstall", async () => {
		const agentOverrideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-agent-override-"));
		cleanupPaths.push(agentOverrideRoot);
		const customAgentDir = path.join(agentOverrideRoot, "agent");
		setAgentDir(customAgentDir);

		installInMemoryRelay();
		const isolatedHome = os.homedir();
		expect(isolatedHome).not.toBe(REAL_HOMEDIR);
		expect(pathIsWithin(os.tmpdir(), isolatedHome)).toBe(true);
		expect(getAgentDir()).toBe(customAgentDir);
		expect(getConfigRootDir()).toBe(path.join(isolatedHome, getConfigDirName()));

		// Repeated install within one test reuses the same temp home instead of leaking directories.
		installInMemoryRelay();
		expect(os.homedir()).toBe(isolatedHome);

		const host = new CollabHost(makeHostContext("sess-isolated-relay"));
		let switchedReplicaPath = "";
		const guest = new CollabGuestLink(
			makeGuestContext(replicaPath => {
				switchedReplicaPath = replicaPath;
			}),
		);
		try {
			await host.start("ws://localhost:8788");
			await guest.join(host.link);

			expect(pathIsWithin(path.join(isolatedHome, getConfigDirName(), "collab"), switchedReplicaPath)).toBe(true);
			expect(pathIsWithin(realConfigDir(), switchedReplicaPath, { throughMissing: true })).toBe(false);
			expect(await Bun.file(switchedReplicaPath).exists()).toBe(true);

			const runtimeDir = collabHostsRuntimeDir();
			expect(runtimeDir).toBe(path.join(isolatedHome, getConfigDirName(), "run", "collab-hosts"));
			expect(pathIsWithin(realConfigDir(), runtimeDir, { throughMissing: true })).toBe(false);
			const hosts = await listCollabHosts();
			expect(hosts.map(entry => entry.instanceId)).toContain(host.instanceId);
		} finally {
			await guest.leave("test done").catch(() => {});
			await host.stop("test done");
		}

		uninstallInMemoryRelay();
		expect(os.homedir()).toBe(REAL_HOMEDIR);
		expect(getConfigRootDir()).toBe(realConfigDir());
		expect(await directoryExists(isolatedHome)).toBe(false);
	});

	it("preserves a caller-owned os.homedir() spy across installInMemoryRelay and uninstallInMemoryRelay", async () => {
		const callerHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-caller-home-"));
		cleanupPaths.push(callerHome);
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(callerHome);
		refreshDirsFromEnv();

		installInMemoryRelay();
		expect(os.homedir()).toBe(callerHome);
		expect(getConfigRootDir()).toBe(path.join(callerHome, getConfigDirName()));

		uninstallInMemoryRelay();
		expect(os.homedir()).toBe(callerHome);
		expect(await directoryExists(callerHome)).toBe(true);

		homedirSpy.mockRestore();
		refreshDirsFromEnv();
	});

	it("throws CollabTestIsolationError on unisolated real ~/.omp paths while honoring explicit overrides", async () => {
		const configDir = realConfigDir();
		const realCollabDir = path.join(configDir, "collab");
		const realHostsDir = path.join(configDir, "run", "collab-hosts");
		const beforeCollabEntries = await snapshotDirEntries(realCollabDir);
		const beforeHostsEntries = await snapshotDirEntries(realHostsDir);

		installInMemoryRelay({ isolateHome: false });
		expect(os.homedir()).toBe(REAL_HOMEDIR);
		expect(getConfigRootDir()).toBe(configDir);

		expect(() => collabHostsRuntimeDir()).toThrow(CollabTestIsolationError);
		await expect(listCollabHosts()).rejects.toBeInstanceOf(CollabTestIsolationError);

		const unisolatedHost = new CollabHost(makeHostContext("sess-unisolated-host"));
		await expect(unisolatedHost.start("ws://localhost:8788")).rejects.toBeInstanceOf(CollabTestIsolationError);

		const customHostsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-hosts-dir-"));
		cleanupPaths.push(customHostsDir);
		const customConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-config-root-"));
		cleanupPaths.push(customConfigRoot);
		const explicitReplicaDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-explicit-replica-dir-"));
		cleanupPaths.push(explicitReplicaDir);

		const realPublish = registry.publishCollabHost;
		const publishSpy = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
			realPublish(source, { ...options, dir: customHostsDir }),
		);

		const host = new CollabHost(makeHostContext("sess-isolated-overrides"));
		let unisolatedSwitched = false;
		const unisolatedGuest = new CollabGuestLink(
			makeGuestContext(() => {
				unisolatedSwitched = true;
			}),
		);
		let configOverriddenReplica = "";
		const configOverriddenGuest = new CollabGuestLink(
			makeGuestContext(replicaPath => {
				configOverriddenReplica = replicaPath;
			}),
		);
		let explicitReplica = "";
		const explicitDirGuest = new CollabGuestLink(
			makeGuestContext(replicaPath => {
				explicitReplica = replicaPath;
			}),
			{ replicaDir: explicitReplicaDir },
		);

		try {
			await host.start("ws://localhost:8788");

			await expect(unisolatedGuest.join(host.link)).rejects.toBeInstanceOf(CollabTestIsolationError);
			expect(unisolatedSwitched).toBe(false);

			const configRootSpy = spyOn(utils, "getConfigRootDir").mockReturnValue(customConfigRoot);
			try {
				await configOverriddenGuest.join(host.link);
				expect(path.dirname(configOverriddenReplica)).toBe(path.join(customConfigRoot, "collab"));
				expect(pathIsWithin(configDir, configOverriddenReplica, { throughMissing: true })).toBe(false);
				expect(await Bun.file(configOverriddenReplica).exists()).toBe(true);
			} finally {
				configRootSpy.mockRestore();
			}

			await explicitDirGuest.join(host.link);
			expect(path.dirname(explicitReplica)).toBe(explicitReplicaDir);
			expect(pathIsWithin(configDir, explicitReplica, { throughMissing: true })).toBe(false);
			expect(await Bun.file(explicitReplica).exists()).toBe(true);
		} finally {
			publishSpy.mockRestore();
			await explicitDirGuest.leave("test done").catch(() => {});
			await configOverriddenGuest.leave("test done").catch(() => {});
			await unisolatedGuest.leave("test done").catch(() => {});
			await host.stop("test done");
		}

		expect(await snapshotDirEntries(realCollabDir)).toEqual(beforeCollabEntries);
		expect(await snapshotDirEntries(realHostsDir)).toEqual(beforeHostsEntries);
	});

	it("allows temp directories inside REAL_HOMEDIR outside the real config root", () => {
		const tempInsideHome = path.join(
			REAL_HOMEDIR,
			"AppData",
			"Local",
			"Temp",
			"omp-relay-home-win",
			".omp",
			"collab",
		);
		expect(assertIsolatedTestCollabDir(tempInsideHome)).toBe(tempInsideHome);

		const realProfileCollab = path.join(realConfigDir(), "profiles", "work", "collab");
		expect(() => assertIsolatedTestCollabDir(realProfileCollab)).toThrow(CollabTestIsolationError);
	});
});
