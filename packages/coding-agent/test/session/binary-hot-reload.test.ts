import { afterEach, describe, expect, it, vi } from "bun:test";
import * as utils from "@oh-my-pi/pi-utils";
import {
	createBinaryHotReloadSubsystem,
	decideBinaryReload,
	executableWhichWouldLaunch,
	readMiseLatestSiblingOmp,
} from "../../src/session/binary-hot-reload";
import { HotReloadCoordinator } from "../../src/session/hot-reload";
import { resolveRestartEntryCmd, resolveWorkerSpawnCmd } from "../../src/subprocess/worker-client";

const running = "/installs/build-old/omp";
const newer = "/installs/build-new/omp";

describe("hot-reload-omp-binary", () => {
	it("relaunches when the shim path differs from the running binary", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
	});

	it("stays when the shim path matches the running binary", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: running,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("stays when the session is not in herdr or tmux", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: false,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("stays when hot reload is off, even inside herdr or tmux", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: true,
				inMultiplexer: true,
				enabled: false,
			}),
		).toBe("stay");
	});

	it("stays when the new path is not executable", () => {
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: newer,
				launchExecutable: false,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("does not treat a mise shim's realpath as the omp binary it would launch", () => {
		const shim = "/Users/me/.local/share/mise/shims/omp";
		const mise = "/opt/homebrew/bin/mise";
		expect(executableWhichWouldLaunch(shim, mise)).toBeUndefined();
		expect(executableWhichWouldLaunch("/usr/local/bin/omp", running)).toBe(running);
	});

	it("resolves latest inside a mise install directory even when PATH pins an old version", () => {
		const oldBin = "/Users/me/.local/share/mise/installs/oh-my-pi/build-old/omp";
		const newBin = "/Users/me/.local/share/mise/installs/oh-my-pi/build-new/omp";
		const seen: string[] = [];
		expect(
			readMiseLatestSiblingOmp(
				oldBin,
				filePath => {
					seen.push(filePath);
					return newBin;
				},
				() => true,
			),
		).toBe(newBin);
		expect(seen).toEqual(["/Users/me/.local/share/mise/installs/oh-my-pi/latest/omp"]);
		expect(
			readMiseLatestSiblingOmp(
				"/usr/local/bin/omp",
				() => newBin,
				() => true,
			),
		).toBeUndefined();
	});

	it("relaunches when a mise shim's install path differs from the running binary", () => {
		const shim = "/Users/me/.local/share/mise/shims/omp";
		const mise = "/opt/homebrew/bin/mise";
		const install = "/Users/me/.local/share/mise/installs/oh-my-pi/build-new/omp";
		expect(executableWhichWouldLaunch(shim, mise, install)).toBe(install);
		expect(
			decideBinaryReload({
				runningPath: running,
				launchPath: executableWhichWouldLaunch(shim, mise, install),
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("relaunch");
		expect(
			decideBinaryReload({
				runningPath: install,
				launchPath: executableWhichWouldLaunch(shim, mise, install),
				launchExecutable: true,
				inMultiplexer: true,
				enabled: true,
			}),
		).toBe("stay");
	});

	it("defers a mid-turn change until the turn ends", async () => {
		let busy = true;
		let restarts = 0;
		const notices: string[] = [];
		const idle: Array<() => void> = [];
		const watcher = new HotReloadCoordinator({
			subsystems: [
				createBinaryHotReloadSubsystem({
					observe: () => ({
						runningPath: running,
						launchPath: newer,
						launchExecutable: true,
						inMultiplexer: true,
						enabled: true,
					}),
					restart: async () => {
						restarts++;
					},
				}),
			],
			isBusy: () => busy,
			onIdle: listener => {
				idle.push(listener);
				return () => {
					idle.splice(idle.indexOf(listener), 1);
				};
			},
			notify: (_level, message) => {
				notices.push(message);
			},
			pollIntervalMs: 3_600_000,
		});
		await watcher.start();
		await watcher.poll();
		expect(restarts).toBe(0);
		expect(notices).toEqual(["a newer omp is on PATH; restart deferred until the current turn ends"]);

		busy = false;
		for (const listener of idle) listener();
		await watcher.poll();
		watcher.stop();

		expect(restarts).toBe(1);
	});

	it("restarts a compiled session onto the live binary and leaves workers on the running one", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);

		expect(resolveRestartEntryCmd(newer)).toEqual([newer]);
		expect(resolveWorkerSpawnCmd("__omp_worker")).toEqual({
			cmd: [process.execPath, "__omp_worker"],
		});
	});

	it("does not point a bun dev restart at the installed binary", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);

		expect(resolveRestartEntryCmd(newer)[0]).toBe(process.execPath);
		expect(resolveRestartEntryCmd(newer)).not.toContain(newer);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
