import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { postmortem } from "@oh-my-pi/pi-utils";

interface SuspendCtx {
	ctx: InteractiveModeContext;
	ui: {
		start: Mock<() => void>;
		stop: Mock<() => void>;
		requestRender: Mock<(force?: boolean) => void>;
	};
	showStatus: Mock<(message: string) => void>;
	showError: Mock<(message: string) => void>;
	shutdown: Mock<(exitCode?: number) => Promise<void>>;
	saveDraft: Mock<(text: string) => Promise<void>>;
}

function createCtx(isShuttingDown = false): SuspendCtx {
	const ui = {
		start: vi.fn(),
		stop: vi.fn(),
		requestRender: vi.fn(),
	};
	const showStatus = vi.fn();
	const showError = vi.fn();
	const shutdown = vi.fn(async (_exitCode?: number) => {});
	const saveDraft = vi.fn(async (_text: string) => {});
	const ctx = {
		ui: ui as unknown as InteractiveModeContext["ui"],
		showStatus,
		showError,
		shutdown,
		isShuttingDown,
		editor: { getText: () => "unsent draft" } as unknown as InteractiveModeContext["editor"],
		sessionManager: { saveDraft } as unknown as InteractiveModeContext["sessionManager"],
		keybindings: KeybindingsManager.inMemory(),
	} as unknown as InteractiveModeContext;
	return { ctx, ui, showStatus, showError, shutdown, saveDraft };
}

/** Drain the microtask queue so promise chains queued by timer callbacks settle. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const originalPlatform = process.platform;
let sigcontListener: (() => void) | undefined;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
}

function spyOnProcessOnce(): Mock<(event: NodeJS.Signals | string, listener: () => void) => NodeJS.Process> {
	return vi.spyOn(process, "once") as unknown as Mock<
		(event: NodeJS.Signals | string, listener: () => void) => NodeJS.Process
	>;
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
	if (sigcontListener) process.removeListener("SIGCONT", sigcontListener);
	sigcontListener = undefined;
	vi.restoreAllMocks();
});

describe("InputController.handleCtrlZ", () => {
	it("no-ops on Windows so the unsupported SIGSTOP signal can't crash the process (#2036)", () => {
		setPlatform("win32");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("process.kill must not be called on win32");
		});
		const onceSpy = spyOnProcessOnce();
		const { ctx, ui, showStatus, showError } = createCtx();

		const controller = new InputController(ctx);
		expect(() => controller.handleCtrlZ()).not.toThrow();

		expect(killSpy).not.toHaveBeenCalled();
		expect(onceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.anything());
		expect(ui.stop).not.toHaveBeenCalled();
		expect(ui.start).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus.mock.calls[0]?.[0]).toMatch(/not supported/i);
		expect(showError).not.toHaveBeenCalled();
	});

	it("SIGSTOPs the foreground process group and registers a SIGCONT resume hook on POSIX (#3461)", () => {
		setPlatform("linux");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { ctx, ui, showError } = createCtx();

		const controller = new InputController(ctx);
		controller.handleCtrlZ();

		// Resume hook registered BEFORE the signal is sent so a same-tick
		// SIGCONT delivery can't race past us.
		expect(onceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		const sigcontOrder = onceSpy.mock.invocationCallOrder[0] ?? Infinity;
		const stopOrder = ui.stop.mock.invocationCallOrder[0] ?? Infinity;
		const killOrder = killSpy.mock.invocationCallOrder[0] ?? Infinity;
		expect(sigcontOrder).toBeLessThan(stopOrder);
		expect(stopOrder).toBeLessThan(killOrder);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(0, "SIGSTOP");
		expect(ui.start).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();

		// Simulating the kernel-delivered SIGCONT releases the referenced
		// suspend handle before bringing the TUI back up.
		expect(intervalSpy).toHaveBeenCalledTimes(1);
		const suspendKeepalive = intervalSpy.mock.results[0]?.value;
		expect(clearIntervalSpy).not.toHaveBeenCalled();
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		sigcontListener?.();
		expect(clearIntervalSpy).toHaveBeenCalledWith(suspendKeepalive);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	it("restores the TUI and drops the SIGCONT listener when process.kill rejects the signal", () => {
		setPlatform("linux");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("Unknown signal: SIGSTOP");
		});
		const onceSpy = spyOnProcessOnce();
		const removeSpy = vi.spyOn(process, "removeListener");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { ctx, ui, showError, showStatus } = createCtx();

		const controller = new InputController(ctx);
		// Critical contract: the failure must not bubble up to the caller —
		// otherwise the TUI's stdin reader (which invoked us) crashes the
		// whole process via `[Uncaught Exception]`.
		expect(() => controller.handleCtrlZ()).not.toThrow();

		// The exact listener we registered for SIGCONT is the one we
		// remove; otherwise a leaked handler would fire on the next
		// unrelated continue and re-`start()` an already-running TUI.
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		expect(removeSpy).toHaveBeenCalledWith("SIGCONT", sigcontListener);
		expect(intervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(intervalSpy.mock.results[0]?.value);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]?.[0]).toMatch(/Failed to suspend/);
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("writes the restart error to stderr and shuts the host down when the SIGCONT TUI restart throws", async () => {
		setPlatform("linux");
		vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		const stderrWrites: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		const { ctx, ui, showError, shutdown, saveDraft } = createCtx();
		const draftGate = Promise.withResolvers<void>();
		saveDraft.mockImplementation(() => draftGate.promise);
		// Park the race's deadline arm so the exit provably waits on the draft.
		vi.spyOn(Bun, "sleep").mockImplementation(() => Promise.withResolvers<void>().promise);
		ui.start.mockImplementation(() => {
			throw new Error("kitty keyboard push failed");
		});

		const controller = new InputController(ctx);
		controller.handleCtrlZ();

		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		sigcontListener?.();

		// The failed restart consumed the SIGCONT hook, so without a host
		// shutdown the process would sit alive with a dead TUI and paused
		// stdin. The error must reach stderr (the TUI is gone) and the host
		// must shut down instead of wedging.
		expect(clearIntervalSpy).toHaveBeenCalledWith(intervalSpy.mock.results[0]?.value);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(stderrWrites.join("")).toContain("Failed to resume after suspend: kitty keyboard push failed");
		expect(showError).not.toHaveBeenCalled();
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(shutdown).toHaveBeenCalledWith(1);
		// The unsent editor text must survive the recovery: shutdown() only saves
		// it later in the teardown, which the hard exit may never reach.
		await flush();
		expect(saveDraft).toHaveBeenCalledWith("unsent draft");
		// A shutdown that returns instead of exiting must still end the process,
		// but only after the draft write settles.
		expect(exitSpy).not.toHaveBeenCalled();
		draftGate.resolve();
		await flush();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("hard-exits when shutdown never settles after a failed TUI restart", async () => {
		setPlatform("linux");
		vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.useFakeTimers();
		try {
			const { ctx, ui, shutdown, saveDraft } = createCtx();
			shutdown.mockImplementation(() => Promise.withResolvers<void>().promise);
			saveDraft.mockImplementation(() => Promise.withResolvers<void>().promise);
			// Drive the deadline arm by hand: whether Bun.sleep honors fake timers
			// is a runtime detail the test must not depend on (macos-spelling.test.ts).
			const deadlineGate = Promise.withResolvers<void>();
			vi.spyOn(Bun, "sleep").mockImplementation(() => deadlineGate.promise);
			ui.start.mockImplementation(() => {
				throw new Error("restart failed");
			});

			const controller = new InputController(ctx);
			controller.handleCtrlZ();

			sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
			expect(sigcontListener).toBeDefined();
			sigcontListener?.();
			expect(shutdown).toHaveBeenCalledWith(1);
			expect(exitSpy).not.toHaveBeenCalled();

			// A hung shutdown must not leave the wedged process alive forever.
			vi.advanceTimersByTime(5_000);
			await flush();
			// The hard exit waits for the draft write, but not forever.
			expect(exitSpy).not.toHaveBeenCalled();
			deadlineGate.resolve();
			await flush();
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the watchdog as the bound when a shutdown is already in flight", async () => {
		setPlatform("linux");
		vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.useFakeTimers();
		try {
			const { ctx, ui, shutdown } = createCtx(true);
			ui.start.mockImplementation(() => {
				throw new Error("restart failed");
			});

			const controller = new InputController(ctx);
			controller.handleCtrlZ();

			sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
			expect(sigcontListener).toBeDefined();
			sigcontListener?.();

			// An in-flight teardown must not be cut short: hardExit is not chained
			// on the guarded no-op. The call still escalates its exit code to 1.
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(shutdown).toHaveBeenCalledWith(1);
			expect(exitSpy).not.toHaveBeenCalled();

			// The watchdog still bounds a hung in-flight teardown.
			vi.advanceTimersByTime(5_000);
			await flush();
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
