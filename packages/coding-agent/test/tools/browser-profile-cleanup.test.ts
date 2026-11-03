/**
 * Regression test for issue #7058: on Windows, puppeteer-core deletes its temp
 * Chrome profile with an unretried `rm()` from an eager process-exit hook, so an
 * EBUSY on the still-locked profile surfaces as an unhandled rejection that
 * crashes OMP. OMP now owns the profile directory and removes it itself with a
 * lock-tolerant, warn-and-leave cleanup.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonBrokerClient, DaemonBrokerRejectedError } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { DaemonOperation, DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import * as browserAttach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { removeUserDataDir, seedOwnedProfilePreferences } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	ensureSharedBrowser,
	restartSharedBrowser,
	sharedBrowserDaemonName,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { DaemonSnapshot, DaemonState } from "@oh-my-pi/pi-tui/tools/daemon";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

/**
 * Route `ensureSharedBrowser` to one fake daemon broker shared by every client
 * in a test. Like the real broker, `describe` and `list` answer from its state
 * on receipt, `describe` rejects an unknown name, `start` is rejected once the
 * daemon exists, and `restart` relaunches it. `onDescribe` runs after the reply
 * is fixed (to delay it, or to fail it in transit or with a rejection);
 * `onStop` runs when a stop is requested and returns the state the daemon ends
 * in (default `exited`); `onStart` runs once a launch is recorded, where
 * Chrome starts.
 */
function fakeSharedBroker(
	projectDir: string,
	wsEndpoint: string,
	hooks: {
		onDescribe?: () => Promise<void>;
		onStop?: () => Promise<DaemonState | undefined>;
		onStart?: () => Promise<void>;
	} = {},
): { client: DaemonBrokerClient; starts: number; restore(): void } {
	let daemon: DaemonSnapshot | undefined;
	const spies: Array<{ mockRestore(): void }> = [];
	const launch = async (name: string): Promise<DaemonSnapshot> => {
		broker.starts++;
		const now = Date.now();
		const launched: DaemonSnapshot = {
			name,
			id: "fake",
			state: "ready",
			createdAt: now,
			startedAt: now,
			readyAt: now,
			readyMatch: `DevTools listening on ${wsEndpoint}`,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		daemon = launched;
		await hooks.onStart?.();
		return launched;
	};
	const unknown = (name: string) => new DaemonBrokerRejectedError(`Unknown daemon ${name}`);
	const client = {
		projectDir,
		onCompletion: () => () => {},
		close() {},
		async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
			switch (operation.op) {
				case "describe": {
					const snapshot = daemon;
					await hooks.onDescribe?.();
					if (!snapshot) throw unknown(operation.name);
					return { op: "describe", daemon: snapshot } as DaemonRpcResult;
				}
				case "list":
					return { op: "list", daemons: daemon ? [daemon] : [] };
				case "start":
					if (daemon) {
						throw new DaemonBrokerRejectedError(`Daemon ${operation.spec.name} is already ${daemon.state}`);
					}
					return { op: "start", daemon: await launch(operation.spec.name), readyTimedOut: false };
				case "stop": {
					if (!daemon) throw unknown(operation.name);
					daemon = { ...daemon, state: (await hooks.onStop?.()) ?? "exited" };
					return { op: "stop", daemon };
				}
				case "restart":
					if (!daemon) throw unknown(operation.name);
					return { op: "restart", daemon: await launch(operation.name) };
				default:
					throw new Error(`Unexpected broker op ${operation.op}`);
			}
		},
	} as unknown as DaemonBrokerClient;
	const broker = {
		client,
		starts: 0,
		restore() {
			for (const spy of spies) spy.mockRestore();
		},
	};
	spies.push(
		spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client),
		spyOn(browserLaunch, "resolveSharedBrowserLaunchSpec").mockResolvedValue({
			executablePath: "/fake/chrome",
			args: [],
		}),
		spyOn(browserAttach, "probeCdpStatus").mockResolvedValue(200),
	);
	return broker;
}

describe("headless Chromium profile cleanup (issue #7058)", () => {
	afterEach(() => {
		spyOn(piUtils, "removeWithRetries").mockRestore();
		spyOn(piUtils.logger, "warn").mockRestore();
	});

	it("removes an owned profile directory", async () => {
		const dir = await makeProfileDir();
		await removeUserDataDir(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("warns and leaves the directory instead of throwing when it stays locked (EBUSY)", async () => {
		const dir = await makeProfileDir();
		const ebusy = Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: "EBUSY" });
		const removeSpy = spyOn(piUtils, "removeWithRetries").mockRejectedValue(ebusy);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			// Must resolve — a cleanup failure never propagates as a crash.
			await expect(removeUserDataDir(dir)).resolves.toBeUndefined();
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			removeSpy.mockRestore();
			// Real removal so the fixture does not leak.
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes the handle's profile directory when the headless browser is disposed", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			browser: {
				connected: true,
				process: () => ({ pid: 4242 }),
				close: () => Promise.resolve(),
			},
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;

		await releaseBrowser(handle, { kill: false });

		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("owned Chromium profile preferences", () => {
	it("disables password leak detection while keeping a reused profile's other preferences", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
		const file = path.join(dir, "Default", "Preferences");
		try {
			await Bun.write(
				file,
				JSON.stringify({ intl: { accept_languages: "en-US" }, profile: { exit_type: "Normal" } }),
			);
			await seedOwnedProfilePreferences(dir);
			expect(JSON.parse(await Bun.file(file).text())).toEqual({
				intl: { accept_languages: "en-US" },
				profile: { exit_type: "Normal", password_manager_leak_detection: false },
			});

			await fs.promises.rm(path.join(dir, "Default"), { recursive: true });
			await seedOwnedProfilePreferences(dir);
			expect(JSON.parse(await Bun.file(file).text())).toEqual({
				profile: { password_manager_leak_detection: false },
			});
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("warns instead of failing the launch and leaves no staged file when the write fails", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
		const renameSpy = spyOn(fs.promises, "rename").mockRejectedValue(
			Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
		);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			await expect(seedOwnedProfilePreferences(dir)).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(await fs.promises.readdir(path.join(dir, "Default"))).toEqual([]);
		} finally {
			renameSpy.mockRestore();
			warnSpy.mockRestore();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("lets only the client that launches the shared Chrome write its Preferences when two cold starts race", async () => {
		const seed = browserLaunch.seedOwnedProfilePreferences;
		const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-race-"));
		const name = sharedBrowserDaemonName(true);
		const prefsFile = path.join(daemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Preferences");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/race";
		let chromeRunning = false;
		let launchPrefs: unknown;
		let describes = 0;
		const chromeLive = Promise.withResolvers<void>();
		const seedsWhileChromeRunning: boolean[] = [];
		// One broker shared by both racing clients. Only the first `describe`
		// reply is delivered at once, so a client that asked while the profile
		// was still cold hears "no daemon" after the winner's Chrome is already
		// live on the profile.
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onDescribe() {
				if (describes++ > 0) await chromeLive.promise;
			},
			async onStart() {
				// Chromium reads Preferences once, at startup.
				launchPrefs = JSON.parse(await Bun.file(prefsFile).text());
				chromeRunning = true;
				chromeLive.resolve();
			},
		});
		const seedSpy = spyOn(browserLaunch, "seedOwnedProfilePreferences").mockImplementation(async userDataDir => {
			seedsWhileChromeRunning.push(chromeRunning);
			await seed(userDataDir);
		});
		try {
			const [winner, loser] = await Promise.all([
				ensureSharedBrowser({ projectDir, headless: true }),
				ensureSharedBrowser({ projectDir, headless: true }),
			]);
			expect(winner?.wsEndpoint).toBe(wsEndpoint);
			expect(loser?.wsEndpoint).toBe(wsEndpoint);
			expect(broker.starts).toBe(1);
			expect(launchPrefs).toEqual({ profile: { password_manager_leak_detection: false } });
			// One seed, by the client that launched Chrome, before the launch. A
			// seed after the launch can rename a snapshot it read before Chrome
			// started over the live profile's Preferences.
			expect(seedsWhileChromeRunning).toEqual([false]);
		} finally {
			seedSpy.mockRestore();
			broker.restore();
			await fs.promises.rm(daemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});

describe("shared Chromium session-restore state", () => {
	it("discards the previous Chrome's sessions before a cold start and never touches a live Chrome's", async () => {
		const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-sessions-"));
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(daemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/sessions";
		let sessionsAtLaunch: string[] | undefined;
		let failNextDescribe: Error | undefined;
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onDescribe() {
				const failure = failNextDescribe;
				failNextDescribe = undefined;
				if (failure) throw failure;
			},
			async onStart() {
				// Chromium reopens these pages when its first window opens.
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		try {
			// A predecessor Chrome that was killed (or stopped) with pages open. The
			// first describe is lost in transit, which settles nothing: Chrome must
			// not launch until a later describe confirms the profile is free and the
			// stale session is gone.
			await Bun.write(path.join(sessionsDir, "Session_13435785841408923"), "previous chrome");
			await Bun.write(path.join(sessionsDir, "Tabs_13435784948833957"), "previous chrome");
			failNextDescribe = new Error("broker socket closed");
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(sessionsAtLaunch).toEqual([]);

			// The running Chrome records its own session; attaching to it must leave that alone.
			await Bun.write(path.join(sessionsDir, "Session_13436291949708538"), "live chrome");
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436291949708538"]);

			// A describe lost in transit, or rejected for a reason other than an
			// unknown name, proves nothing about the live Chrome, so neither may discard.
			for (const failure of [
				new Error("broker socket closed"),
				new DaemonBrokerRejectedError("Daemon broker authentication failed"),
			]) {
				failNextDescribe = failure;
				expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
				expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436291949708538"]);
			}
			expect(broker.starts).toBe(1);
		} finally {
			broker.restore();
			await fs.promises.rm(daemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});

	it("starts Chrome only while holding the profile claim, though an unclaimed client may adopt it", async () => {
		const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-claim-"));
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(daemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/claim";
		let sessionsAtLaunch: string[] | undefined;
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onStart() {
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		const warnSpy = spyOn(piUtils.logger, "warn").mockImplementation(() => {});
		let lockSpy: { mockRestore(): void } | undefined;
		const holdClaimElsewhere = () => {
			lockSpy = spyOn(piUtils, "acquireFileLock").mockRejectedValue(new Error("lock held by another omp process"));
		};
		const releaseClaim = () => {
			lockSpy?.mockRestore();
			lockSpy = undefined;
		};
		try {
			// Another omp process holds the claim past the wait, so this client
			// cannot prepare the profile and must not launch Chrome on it.
			await Bun.write(path.join(sessionsDir, "Session_13435785841408923"), "previous chrome");
			holdClaimElsewhere();
			expect(await ensureSharedBrowser({ projectDir, headless: true })).toBeNull();
			expect(broker.starts).toBe(0);
			releaseClaim();

			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(sessionsAtLaunch).toEqual([]);
			holdClaimElsewhere();
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(broker.starts).toBe(1);
		} finally {
			releaseClaim();
			warnSpy.mockRestore();
			broker.restore();
			await fs.promises.rm(daemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});

	it("restarts the shared browser without restoring the stopped Chrome's pages", async () => {
		const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-restart-"));
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(daemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/restart";
		let sessionsAtStop: string[] | undefined;
		let sessionsAtLaunch: string[] | undefined;
		let stopLeaves: DaemonState = "exited";
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onStop() {
				sessionsAtStop = await fs.promises.readdir(sessionsDir).catch(() => []);
				return stopLeaves;
			},
			async onStart() {
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		try {
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);

			// The running Chrome records the pages it has open. They stay until the
			// stop is confirmed and are gone when Chrome relaunches.
			await Bun.write(path.join(sessionsDir, "Session_13436291949708538"), "live chrome");
			expect((await restartSharedBrowser(broker.client, name)).state).toBe("ready");
			expect(sessionsAtStop).toEqual(["Session_13436291949708538"]);
			expect(sessionsAtLaunch).toEqual([]);
			expect(broker.starts).toBe(2);

			// A stop that leaves Chrome running must neither touch its profile nor relaunch it.
			await Bun.write(path.join(sessionsDir, "Session_13436325114290429"), "live chrome");
			stopLeaves = "stopping";
			await expect(restartSharedBrowser(broker.client, name)).rejects.toThrow("still stopping");
			expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436325114290429"]);
			expect(broker.starts).toBe(2);
		} finally {
			broker.restore();
			await fs.promises.rm(daemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});
