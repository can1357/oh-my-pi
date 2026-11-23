/**
 * The contained Python kernel's read roots: a workspace `.venv` that links outside the workspace is
 * never granted, while one inside it is. The container is a stub (`SandboxRuntime.prototype.spawn` is
 * spied), so no backend is needed; the stub exits at once and the start fails after the spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { SandboxRuntime, type SandboxSpawnRequest } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import type { SandboxChild } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import {
	beginContainedSandboxTest,
	type ContainedSandboxTest,
	endContainedSandboxTest,
	failure,
	SANDBOX_SUPPORTED,
} from "../../helpers/sandbox-test-state";

let contained: ContainedSandboxTest;
let workspace: string;
/** `<scratch>/interp/bin`: the real interpreter's directory, no install markers around it. */
let interpBin: string;

function exitedChild(): SandboxChild {
	const closed = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	return {
		pid: 1,
		stdin: { write: () => undefined, flush: () => undefined, end: () => undefined },
		stdout: closed(),
		stderr: closed(),
		exited: Promise.resolve(1),
		exitCode: 1,
		kill: () => undefined,
	};
}

/** Makes `venv` a virtual environment whose `bin/python` links to the real interpreter. */
function makeVenv(venv: string): void {
	fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
	fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "");
	fs.symlinkSync(path.join(interpBin, "python3"), path.join(venv, "bin", "python"));
}

/** The kernel's contained spawn request for `interpreter` (relative to the workspace). */
async function kernelRequest(interpreter: string): Promise<SandboxSpawnRequest> {
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	const spawn = vi.spyOn(SandboxRuntime.prototype, "spawn").mockImplementation(async () => exitedChild());
	await failure(PythonKernel.start({ cwd: workspace, interpreter }));
	expect(spawn).toHaveBeenCalledTimes(1);
	return spawn.mock.calls[0][0];
}

beforeEach(async () => {
	contained = await beginContainedSandboxTest("contained-kernel-roots");
	workspace = contained.workspace;
	interpBin = path.join(path.dirname(workspace), "interp", "bin");
	fs.mkdirSync(interpBin, { recursive: true });
	fs.writeFileSync(path.join(interpBin, "python3"), "", { mode: 0o755 });
});

afterEach(async () => {
	await endContainedSandboxTest(contained);
});

describe.skipIf(process.platform === "win32")("the contained Python kernel's read roots", () => {
	it("does not grant a workspace .venv symlink that points outside the workspace", async () => {
		const outsideVenv = path.join(path.dirname(workspace), "outside-venv");
		makeVenv(outsideVenv);
		fs.symlinkSync(outsideVenv, path.join(workspace, ".venv"));

		const request = await kernelRequest(".venv/bin/python");

		expect(request.argv[0]).toBe(path.join(workspace, ".venv", "bin", "python"));
		expect(request.extraRead).toEqual([path.dirname(request.argv[2]), interpBin]);
	});

	it("grants a workspace .venv that is a real directory inside the workspace", async () => {
		const venv = path.join(workspace, ".venv");
		makeVenv(venv);

		const request = await kernelRequest(".venv/bin/python");

		expect(request.extraRead).toEqual([path.dirname(request.argv[2]), venv, interpBin]);
	});
});
