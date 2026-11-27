import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";

interface SuspendCtx {
	ctx: InteractiveModeContext;
	/** The terminal hand-offs `suspend` made, in order. */
	terminal: string[];
	suspend: Mock<(run: () => Promise<unknown>) => Promise<unknown>>;
	showStatus: Mock<(message: string) => void>;
	showError: Mock<(message: string) => void>;
}

function createCtx(): SuspendCtx {
	const terminal: string[] = [];
	const suspend = vi.fn(async (run: () => Promise<unknown>) => {
		terminal.push("stop");
		try {
			return await run();
		} finally {
			terminal.push("start");
		}
	});
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		suspend,
		showStatus,
		showError,
		keybindings: KeybindingsManager.inMemory(),
	} as unknown as InteractiveModeContext;
	return { ctx, terminal, suspend, showStatus, showError };
}

/** Let the suspend promise chain settle. */
async function settle(): Promise<void> {
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
		const { ctx, suspend, showStatus, showError } = createCtx();

		const controller = new InputController(ctx);
		expect(() => controller.handleCtrlZ()).not.toThrow();

		expect(killSpy).not.toHaveBeenCalled();
		expect(onceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.anything());
		expect(suspend).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus.mock.calls[0]?.[0]).toMatch(/not supported/i);
		expect(showError).not.toHaveBeenCalled();
	});

	it("SIGSTOPs the foreground process group with the terminal handed back, resuming on SIGCONT (#3461)", async () => {
		setPlatform("linux");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { ctx, terminal, showError } = createCtx();

		const controller = new InputController(ctx);
		controller.handleCtrlZ();

		// The terminal is handed back first, and the resume hook is registered
		// before the signal so a same-tick SIGCONT delivery can't race past it.
		expect(terminal).toEqual(["stop"]);
		expect(onceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		const sigcontOrder = onceSpy.mock.invocationCallOrder[0] ?? Infinity;
		const killOrder = killSpy.mock.invocationCallOrder[0] ?? Infinity;
		expect(sigcontOrder).toBeLessThan(killOrder);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(0, "SIGSTOP");
		await settle();
		expect(terminal).toEqual(["stop"]);
		expect(showError).not.toHaveBeenCalled();

		// The kernel-delivered SIGCONT takes the terminal back and releases the
		// referenced keepalive handle.
		expect(intervalSpy).toHaveBeenCalledTimes(1);
		const suspendKeepalive = intervalSpy.mock.results[0]?.value;
		expect(clearIntervalSpy).not.toHaveBeenCalled();
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		sigcontListener?.();
		await settle();
		expect(terminal).toEqual(["stop", "start"]);
		expect(clearIntervalSpy).toHaveBeenCalledWith(suspendKeepalive);
	});

	it("takes the terminal back and drops the SIGCONT listener when process.kill rejects the signal", async () => {
		setPlatform("linux");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("Unknown signal: SIGSTOP");
		});
		const onceSpy = spyOnProcessOnce();
		const removeSpy = vi.spyOn(process, "removeListener");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { ctx, terminal, showError, showStatus } = createCtx();

		const controller = new InputController(ctx);
		// The failure must not bubble up to the key dispatch that invoked us.
		expect(() => controller.handleCtrlZ()).not.toThrow();
		await settle();

		// The exact listener registered for SIGCONT is the one removed; a leaked
		// handler would fire on the next unrelated continue.
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		expect(removeSpy).toHaveBeenCalledWith("SIGCONT", sigcontListener);
		expect(intervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(intervalSpy.mock.results[0]?.value);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(terminal).toEqual(["stop", "start"]);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]?.[0]).toMatch(/Failed to suspend/);
		expect(showStatus).not.toHaveBeenCalled();
	});
});
