import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteResult,
	KernelShutdownResult,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

type FakeKernelShutdownOptions = { timeoutMs?: number };

class FakeKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(async (_options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => ({
		confirmed: true,
	}));
	ping = vi.fn(async () => true);
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}
}

async function flushMicrotasks(turns = 6): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await Promise.resolve();
	}
}

afterEach(async () => {
	await disposeAllKernelSessions();
	vi.restoreAllMocks();
});

describe("python executor owner cleanup", () => {
	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("2 + 2", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("3 + 3", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-b");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		const kernelOne = new FakeKernel();
		const kernelTwo = new FakeKernel();
		const unrelatedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(kernelOne as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(kernelTwo as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await executePython("print('one')", {
			cwd: "/tmp/owner-a-one",
			sessionId: "session-one",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('two')", {
			cwd: "/tmp/owner-a-two",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('other')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernelOne.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelTwo.shutdown).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		await executePython("print('still alive')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("falls back to the retained session id when no explicit owner id is provided during execution", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/fallback-owner-session",
			sessionId: "fallback-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("fallback-session");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		const disposingKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		const shutdownDeferred = Promise.withResolvers<KernelShutdownResult>();
		disposingKernel.shutdown = vi.fn(() => shutdownDeferred.promise);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(disposingKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		const disposal = disposeKernelSessionsByOwner("owner-a");
		await executePython("2 + 2", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(disposingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(disposingKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.shutdown).not.toHaveBeenCalled();

		shutdownDeferred.resolve({ confirmed: true });
		await disposal;

		await disposeKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("returns a cancelled result when a dead session restart shutdown times out", async () => {
		const kernel = new FakeKernel();
		kernel.alive = false;
		let shutdownCallCount = 0;
		kernel.shutdown = vi.fn(async (options?: FakeKernelShutdownOptions): Promise<KernelShutdownResult> => {
			shutdownCallCount += 1;
			if (shutdownCallCount > 1) {
				return { confirmed: true };
			}
			const { promise, reject } = Promise.withResolvers<KernelShutdownResult>();
			const timer = setTimeout(
				() => reject(new DOMException("Python kernel shutdown timed out", "TimeoutError")),
				options?.timeoutMs ?? 0,
			);
			timer.unref?.();
			return await promise;
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);

		const result = await executePython("1 + 1", {
			cwd: "/tmp/restart-timeout-session",
			sessionId: "restart-timeout-session",
			kernelMode: "session",
			timeoutMs: 100,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(kernel.shutdown).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
		expect(startSpy).toHaveBeenCalledTimes(1);
	});

	it("does not let stuck retained executions block owner or global cleanup", async () => {
		const ownerKernel = new FakeKernel();
		const globalKernel = new FakeKernel();
		const ownerExecutionStarted = Promise.withResolvers<void>();
		const globalExecutionStarted = Promise.withResolvers<void>();
		const ownerExecutionHang = Promise.withResolvers<KernelExecuteResult>();
		const globalExecutionHang = Promise.withResolvers<KernelExecuteResult>();
		ownerKernel.execute = vi.fn(async () => {
			ownerExecutionStarted.resolve();
			return await ownerExecutionHang.promise;
		});
		globalKernel.execute = vi.fn(async () => {
			globalExecutionStarted.resolve();
			return await globalExecutionHang.promise;
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(ownerKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(globalKernel as unknown as PythonKernelInstance);

		void executePython("print('owner hangs')", {
			cwd: "/tmp/stuck-owner-cleanup",
			sessionId: "stuck-owner-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await ownerExecutionStarted.promise;

		void executePython("print('global hangs')", {
			cwd: "/tmp/stuck-global-cleanup",
			sessionId: "stuck-global-session",
			kernelMode: "session",
		});
		await globalExecutionStarted.promise;

		const ownerCleanup = disposeKernelSessionsByOwner("owner-a");
		await flushMicrotasks();
		expect(ownerKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(globalKernel.shutdown).not.toHaveBeenCalled();
		await ownerCleanup;

		const globalCleanup = disposeAllKernelSessions();
		await flushMicrotasks();
		expect(globalKernel.shutdown).toHaveBeenCalledTimes(1);
		await globalCleanup;

		ownerExecutionHang.resolve(OK_RESULT);
		globalExecutionHang.resolve(OK_RESULT);
	});

	it("leaves per-call kernels out of owner-scoped retained cleanup and keeps global cleanup intact", async () => {
		const perCallKernel = new FakeKernel();
		const retainedKernel = new FakeKernel();
		const unownedRetainedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(perCallKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(retainedKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unownedRetainedKernel as unknown as PythonKernelInstance);

		await executePython("print('per-call')", {
			cwd: "/tmp/per-call-owner",
			kernelMode: "per-call",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('retained')", {
			cwd: "/tmp/retained-owner",
			sessionId: "retained-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('unowned')", {
			cwd: "/tmp/unowned-retained",
			sessionId: "unowned-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");

		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(retainedKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(unownedRetainedKernel.shutdown).not.toHaveBeenCalled();

		await disposeAllKernelSessions();

		expect(unownedRetainedKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("retains sessions whose kernel shutdown is not confirmed so a later dispose retries", async () => {
		const kernel = new FakeKernel();
		const unconfirmedShutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: false }));
		kernel.shutdown = unconfirmedShutdown;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1", {
			cwd: "/tmp/unconfirmed-shutdown",
			sessionId: "unconfirmed-shutdown-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);

		await disposeAllKernelSessions();
		expect(unconfirmedShutdown).toHaveBeenCalledTimes(1);

		// Re-executing the same session must reuse the retained kernel (no new start).
		await executePython("2", {
			cwd: "/tmp/unconfirmed-shutdown",
			sessionId: "unconfirmed-shutdown-session",
			kernelMode: "session",
		});
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		// Swap to a confirmed shutdown so afterEach can drain the retained session.
		const confirmedShutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true }));
		kernel.shutdown = confirmedShutdown;
		await disposeAllKernelSessions();
		expect(confirmedShutdown).toHaveBeenCalledTimes(1);
	});

	it("retains owner mapping when owner-scoped shutdown is not confirmed", async () => {
		const kernel = new FakeKernel();
		const unconfirmedShutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: false }));
		kernel.shutdown = unconfirmedShutdown;
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1", {
			cwd: "/tmp/unconfirmed-owner-shutdown",
			sessionId: "unconfirmed-owner-shutdown-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		await disposeKernelSessionsByOwner("owner-a");
		expect(unconfirmedShutdown).toHaveBeenCalledTimes(1);

		const confirmedShutdown = vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true }));
		kernel.shutdown = confirmedShutdown;
		await disposeKernelSessionsByOwner("owner-a");
		expect(confirmedShutdown).toHaveBeenCalledTimes(1);
	});
});
