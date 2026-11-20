import { afterEach, describe, expect, it, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { DEV_LAUNCHER_ENV, resolveCliEntryCmd, resolveRestartCmd } from "../../src/subprocess/worker-client";

describe("resolveRestartCmd", () => {
	const priorLauncher = process.env[DEV_LAUNCHER_ENV];

	afterEach(() => {
		vi.restoreAllMocks();
		if (priorLauncher === undefined) delete process.env[DEV_LAUNCHER_ENV];
		else process.env[DEV_LAUNCHER_ENV] = priorLauncher;
	});

	it("relaunches through the dev launcher that declared itself", () => {
		vi.spyOn(piUtils, "isCompiledBinary").mockReturnValue(false);
		process.env[DEV_LAUNCHER_ENV] = import.meta.path;

		expect(resolveRestartCmd()).toEqual([import.meta.path]);
	});

	it("keeps a compiled binary as its own entry even when a launcher leaked into the environment", () => {
		vi.spyOn(piUtils, "isCompiledBinary").mockReturnValue(true);
		process.env[DEV_LAUNCHER_ENV] = import.meta.path;

		expect(resolveRestartCmd()).toEqual([process.execPath]);
	});

	it("falls back to the entry command when the launcher no longer exists", () => {
		vi.spyOn(piUtils, "isCompiledBinary").mockReturnValue(false);
		process.env[DEV_LAUNCHER_ENV] = `${import.meta.dir}/missing-launcher`;

		expect(resolveRestartCmd()).toEqual(resolveCliEntryCmd());
	});
});
