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
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { DaemonOperation, DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import * as browserAttach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { removeUserDataDir, seedOwnedProfilePreferences } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { ensureSharedBrowser, sharedBrowserDaemonName } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
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
		let daemon: DaemonSnapshot | undefined;
		let chromeRunning = false;
		let launchPrefs: unknown;
		let starts = 0;
		let describes = 0;
		const chromeLive = Promise.withResolvers<void>();
		const seedsWhileChromeRunning: boolean[] = [];
		// One broker shared by both racing clients. It answers `describe` from
		// its state on receipt; only the first reply is delivered at once, so a
		// client that asked while the profile was still cold hears "no daemon"
		// after the winner's Chrome is already live on the profile.
		const client = {
			projectDir,
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "describe") {
					const snapshot = daemon;
					if (describes++ > 0) await chromeLive.promise;
					if (!snapshot) throw new Error(`Unknown daemon ${operation.name}`);
					return { op: "describe", daemon: snapshot } as DaemonRpcResult;
				}
				if (operation.op === "start") {
					if (daemon) throw new Error(`Daemon ${operation.spec.name} is already ${daemon.state}`);
					starts++;
					const now = Date.now();
					daemon = {
						name: operation.spec.name,
						id: "race",
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
					// Chromium reads Preferences once, at startup.
					launchPrefs = JSON.parse(await Bun.file(prefsFile).text());
					chromeRunning = true;
					chromeLive.resolve();
					return { op: "start", daemon, readyTimedOut: false };
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spies = [
			spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client),
			spyOn(browserLaunch, "resolveSharedBrowserLaunchSpec").mockResolvedValue({
				executablePath: "/fake/chrome",
				args: [],
			}),
			spyOn(browserAttach, "probeCdpStatus").mockResolvedValue(200),
			spyOn(browserLaunch, "seedOwnedProfilePreferences").mockImplementation(async userDataDir => {
				seedsWhileChromeRunning.push(chromeRunning);
				await seed(userDataDir);
			}),
		];
		try {
			const [winner, loser] = await Promise.all([
				ensureSharedBrowser({ projectDir, headless: true }),
				ensureSharedBrowser({ projectDir, headless: true }),
			]);
			expect(winner?.wsEndpoint).toBe(wsEndpoint);
			expect(loser?.wsEndpoint).toBe(wsEndpoint);
			expect(starts).toBe(1);
			expect(launchPrefs).toEqual({ profile: { password_manager_leak_detection: false } });
			// One seed, by the client that launched Chrome, before the launch. A
			// seed after the launch can rename a snapshot it read before Chrome
			// started over the live profile's Preferences.
			expect(seedsWhileChromeRunning).toEqual([false]);
		} finally {
			for (const spy of spies) spy.mockRestore();
			await fs.promises.rm(daemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});
