import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "bun:test";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { formatEvalStateContext, getEvalState } from "@oh-my-pi/pi-coding-agent/eval/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	readonly pythonPath = "/managed/bin/python";
	readonly #death = Promise.withResolvers<void>();
	alive = true;
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(async (): Promise<KernelShutdownResult> => {
		this.die();
		return { confirmed: true };
	});

	constructor(readonly id: string) {}

	isAlive(): boolean {
		return this.alive;
	}

	hasPendingWork(): boolean {
		return false;
	}

	whenDead(): Promise<void> {
		return this.#death.promise;
	}

	die(): void {
		this.alive = false;
		this.#death.resolve();
	}
}

function toolSession(sessionId: string, cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getEvalSessionId: () => sessionId,
		getEvalKernelOwnerId: () => null,
	} as ToolSession;
}

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("python eval state reporting", () => {
	it("lists a retained Python kernel in the host registry across load, death, and replacement", async () => {
		const cwd = path.resolve("/tmp/python-eval-state");
		const session = toolSession("python-eval-state", cwd);
		const first = new FakeKernel("py-first");
		const second = new FakeKernel("py-second");
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(first as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(second as unknown as PythonKernelInstance);
		const options = {
			cwd,
			sessionId: "python:python-eval-state",
			kernelMode: "session" as const,
			toolSession: session,
			bridge: { url: "http://127.0.0.1:1", token: "test" },
		};
		const script = path.join(cwd, "setup.py");

		await executePython("receipt = 42", { ...options, filename: script });

		expect(getEvalState(session)?.runtimes).toEqual([
			expect.objectContaining({
				language: "python",
				kernelId: "py-first",
				generation: 1,
				alive: true,
				interpreter: "/managed/bin/python",
				loadedPaths: [script],
			}),
		]);
		expect(formatEvalStateContext(session)).toContain("- Python: alive; generation=1; kernel=py-first");

		first.die();
		await first.whenDead();
		expect(formatEvalStateContext(session)).toContain("- Python: dead; state is unavailable; generation=1");

		await executePython("print(1)", options);
		expect(getEvalState(session)?.runtimes).toEqual([
			expect.objectContaining({ kernelId: "py-second", generation: 2, alive: true, loadedPaths: [] }),
		]);

		await disposeAllKernelSessions();
		expect(getEvalState(session)?.runtimes).toEqual([
			expect.objectContaining({ kernelId: "py-second", alive: false }),
		]);
	});

	it("does not record a file-backed cell that failed as a loaded script", async () => {
		const cwd = path.resolve("/tmp/python-eval-state-failed-load");
		const session = toolSession("python-eval-state-failed-load", cwd);
		const kernel = new FakeKernel("py-failed-load");
		kernel.execute.mockResolvedValue({ ...OK_RESULT, status: "error" });
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("raise SystemError", {
			cwd,
			sessionId: "python:python-eval-state-failed-load",
			kernelMode: "session",
			toolSession: session,
			bridge: { url: "http://127.0.0.1:1", token: "test" },
			filename: path.join(cwd, "broken.py"),
		});

		expect(getEvalState(session)?.runtimes).toEqual([
			expect.objectContaining({ kernelId: "py-failed-load", alive: true, loadedPaths: [] }),
		]);
	});
});
