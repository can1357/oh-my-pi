import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCliEntryCmd, resolveWorkerSpawnCmd } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import * as utils from "@oh-my-pi/pi-utils";

const BROKER = "__omp_worker_daemon_broker";

// Regression for issue #11407: in a compiled binary the daemon broker and every
// worker are re-spawned through `process.execPath`, which is symlink-resolved to
// the versioned Homebrew Cellar path. `brew upgrade` deletes that directory, so a
// still-running session's spawn fails with `ENOENT ... posix_spawn` and every hub
// process op breaks for the session's lifetime. The launcher must resolve to a
// path that still exists.
describe("compiled-binary launcher resolution survives a vanished execPath", () => {
	const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
	let root = "";

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-"));
		spyOn(utils, "isCompiledBinary").mockReturnValue(true);
	});

	afterEach(() => {
		if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
		delete process.env.OMP_BIN;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("keeps using execPath when it still exists (the common, un-upgraded case)", () => {
		const exe = path.join(root, "cellar-18.1.15-omp");
		fs.writeFileSync(exe, "");
		const which = spyOn(utils, "$which");
		Object.defineProperty(process, "execPath", { value: exe, configurable: true, writable: true });

		expect(resolveWorkerSpawnCmd(BROKER)).toEqual({ cmd: [exe, BROKER] });
		expect(resolveCliEntryCmd()).toEqual([exe]);
		expect(which).not.toHaveBeenCalled();
	});

	it("falls back to the omp launcher on PATH when execPath has been deleted by an upgrade", () => {
		const stable = path.join(root, "prefix-bin-omp");
		fs.writeFileSync(stable, "");
		spyOn(utils, "$which").mockReturnValue(stable);
		// A versioned path the process was launched from, now gone after `brew upgrade`.
		Object.defineProperty(process, "execPath", {
			value: path.join(root, "cellar-18.1.14-omp"),
			configurable: true,
			writable: true,
		});

		expect(resolveWorkerSpawnCmd(BROKER)).toEqual({ cmd: [stable, BROKER] });
		expect(resolveCliEntryCmd()).toEqual([stable]);
	});

	it("prefers an existing OMP_BIN override over execPath", () => {
		const override = path.join(root, "omp-bin-override");
		const exe = path.join(root, "cellar-18.1.15-omp");
		fs.writeFileSync(override, "");
		fs.writeFileSync(exe, "");
		spyOn(utils, "$which");
		Object.defineProperty(process, "execPath", { value: exe, configurable: true, writable: true });
		process.env.OMP_BIN = override;

		expect(resolveWorkerSpawnCmd(BROKER).cmd[0]).toBe(override);
	});

	it("ignores a stale OMP_BIN that no longer exists", () => {
		const exe = path.join(root, "cellar-18.1.15-omp");
		fs.writeFileSync(exe, "");
		spyOn(utils, "$which");
		Object.defineProperty(process, "execPath", { value: exe, configurable: true, writable: true });
		process.env.OMP_BIN = path.join(root, "removed-omp");

		expect(resolveWorkerSpawnCmd(BROKER).cmd[0]).toBe(exe);
	});
});
