import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as nativesModule from "@oh-my-pi/pi-natives";
import { type MacAppearanceObserver, MacOSAppearance } from "@oh-my-pi/pi-natives";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";

const originalPlatform = process.platform;
const originalColorfgbg = Bun.env.COLORFGBG;
const originalZellij = Bun.env.ZELLIJ;

type ThemeTestGlobals = {
	platform?: NodeJS.Platform;
	colorfgbg?: string;
	zellij?: string;
};

const withThemeTestGlobals = (globals: ThemeTestGlobals = {}) => {
	Object.defineProperty(process, "platform", {
		value: globals.platform ?? "darwin",
		configurable: true,
		writable: true,
	});

	if (globals.colorfgbg === undefined) delete Bun.env.COLORFGBG;
	else Bun.env.COLORFGBG = globals.colorfgbg;

	if (globals.zellij === undefined) delete Bun.env.ZELLIJ;
	else Bun.env.ZELLIJ = globals.zellij;

	return {
		[Symbol.dispose]() {
			themeModule.stopThemeWatcher();
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
				writable: true,
			});
			if (originalColorfgbg === undefined) delete Bun.env.COLORFGBG;
			else Bun.env.COLORFGBG = originalColorfgbg;
			if (originalZellij === undefined) delete Bun.env.ZELLIJ;
			else Bun.env.ZELLIJ = originalZellij;
			vi.restoreAllMocks();
		},
	};
};

type AppearanceTerminal = Pick<
	Terminal,
	"appearance" | "onAppearanceChange" | "onAppearanceReport" | "onPrivateModeReport" | "refreshAppearance"
>;
type AppearanceChangeCallback = (appearance: TerminalAppearance) => void;
type AppearanceReportCallback = (appearance: TerminalAppearance) => void;
type PrivateModeReportCallback = (mode: number, supported: boolean, confirmed?: boolean) => void;

class FakeAppearanceTerminal implements AppearanceTerminal {
	appearance: TerminalAppearance | undefined;
	readonly refreshAppearance = vi.fn(() => {});
	#appearanceChangeCallbacks: AppearanceChangeCallback[] = [];
	#appearanceReportCallbacks: AppearanceReportCallback[] = [];
	#privateModeReportCallbacks: PrivateModeReportCallback[] = [];

	constructor(appearance?: TerminalAppearance) {
		this.appearance = appearance;
	}

	onAppearanceChange(callback: AppearanceChangeCallback): void {
		this.#appearanceChangeCallbacks.push(callback);
		if (this.appearance) callback(this.appearance);
	}

	onAppearanceReport(callback: AppearanceReportCallback): () => void {
		this.#appearanceReportCallbacks.push(callback);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			const index = this.#appearanceReportCallbacks.indexOf(callback);
			if (index !== -1) this.#appearanceReportCallbacks.splice(index, 1);
		};
	}

	onPrivateModeReport(callback: PrivateModeReportCallback): void {
		this.#privateModeReportCallbacks.push(callback);
	}

	reportAppearance(appearance: TerminalAppearance): void {
		const changed = this.appearance !== appearance;
		this.appearance = appearance;
		for (const callback of this.#appearanceReportCallbacks) callback(appearance);
		if (changed) {
			for (const callback of this.#appearanceChangeCallbacks) callback(appearance);
		}
	}

	reportPrivateMode(mode: number, supported: boolean, confirmed?: boolean): void {
		for (const callback of this.#privateModeReportCallbacks) callback(mode, supported, confirmed);
	}
}

function mockMacAppearanceObserver() {
	const stop = vi.fn();
	const observer: MacAppearanceObserver = { stop };
	let callback: ((err: null | Error, appearance: MacOSAppearance) => void) | undefined;
	const start = vi.spyOn(nativesModule.MacAppearanceObserver, "start").mockImplementation(nextCallback => {
		callback = nextCallback;
		return observer;
	});

	return {
		start,
		stop,
		emit(appearance: MacOSAppearance): void {
			if (!callback) throw new Error("Mac appearance observer has not started");
			callback(null, appearance);
		},
	};
}

async function flushThemeLoad(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("theme auto-detection", () => {
	beforeEach(async () => {
		themeModule.stopThemeWatcher();
		const darkTheme = await themeModule.getThemeByName("dark");
		if (!darkTheme) {
			throw new Error("Failed to load dark theme for tests");
		}
		themeModule.setThemeInstance(darkTheme);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("prefers COLORFGBG before macOS fallback inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("keeps honoring terminal-reported appearance outside fallback mode", async () => {
		using _globals = withThemeTestGlobals();
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start");

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
		expect(observerSpy).not.toHaveBeenCalled();
	});

	it("updates auto theme from the native fallback observer in Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const observer = mockMacAppearanceObserver();
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(observer.start).toHaveBeenCalledTimes(1);
		expect(themeModule.getCurrentThemeName()).toBe("light");

		observer.emit(MacOSAppearance.Dark);
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		themeModule.stopThemeWatcher();
		expect(observer.stop).toHaveBeenCalledTimes(1);
	});
	it("Zellij fallback stays macOS-only (Linux + Zellij = honor terminal)", async () => {
		using _globals = withThemeTestGlobals({ platform: "linux", zellij: "1" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("terminal-reported appearance wins over conflicting COLORFGBG", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	describe("macOS appearance reprobe fallback", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});

		it("does not start for supported or unconfirmed Mode 2031 reports", () => {
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				terminal.reportPrivateMode(2031, true, true);
				terminal.reportPrivateMode(2031, false, false);
				terminal.reportPrivateMode(2031, false);
				terminal.reportPrivateMode(2026, false, true);

				expect(observer.start).not.toHaveBeenCalled();
			} finally {
				dispose();
			}
		});

		it("starts only after a confirmed unsupported Mode 2031 report", () => {
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				expect(observer.start).not.toHaveBeenCalled();

				terminal.reportPrivateMode(2031, false, true);

				expect(observer.start).toHaveBeenCalledTimes(1);
			} finally {
				dispose();
			}
		});

		it("switches provisionally, reprobes at every contracted delay, then reconciles unchanged terminal state", async () => {
			using _globals = withThemeTestGlobals();
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				await flushThemeLoad();

				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(7);

				let previousElapsed = 0;
				for (const [elapsed, expectedCount] of [
					[24, 1],
					[25, 2],
					[49, 2],
					[50, 3],
					[99, 3],
					[100, 4],
					[249, 4],
					[250, 5],
					[499, 5],
					[500, 6],
					[999, 6],
					[1000, 7],
					[1099, 7],
				] as const) {
					vi.advanceTimersByTime(elapsed - previousElapsed);
					previousElapsed = elapsed;
					expect(terminal.refreshAppearance).toHaveBeenCalledTimes(expectedCount);
				}
				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(vi.getTimerCount()).toBe(1);

				terminal.reportAppearance("dark");

				vi.advanceTimersByTime(1);
				await flushThemeLoad();

				expect(themeModule.getCurrentThemeName()).toBe("dark");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(7);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				dispose();
			}
		});

		it("keeps the provisional native theme when every OSC probe times out", async () => {
			using _globals = withThemeTestGlobals();
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				await flushThemeLoad();

				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);

				vi.advanceTimersByTime(1100);
				await flushThemeLoad();

				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(7);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				dispose();
			}
		});

		it("cancels the previous probes and reconciliation when a newer native event starts a fresh sequence", async () => {
			using _globals = withThemeTestGlobals();
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
				vi.advanceTimersByTime(50);
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(3);

				observer.emit(MacOSAppearance.Dark);
				await flushThemeLoad();
				expect(themeModule.getCurrentThemeName()).toBe("dark");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(4);
				expect(vi.getTimerCount()).toBe(7);

				for (const delay of [25, 25, 50, 150, 250, 500]) {
					vi.advanceTimersByTime(delay);
				}
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(10);
				expect(vi.getTimerCount()).toBe(1);

				vi.advanceTimersByTime(100);
				await flushThemeLoad();
				expect(themeModule.getCurrentThemeName()).toBe("dark");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(10);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				dispose();
			}
		});

		it("keeps a genuinely changed terminal appearance authoritative and cancels reconciliation", async () => {
			using _globals = withThemeTestGlobals();
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				await flushThemeLoad();
				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(7);

				terminal.reportAppearance("light");
				themeModule.onTerminalAppearanceChange("light");
				await flushThemeLoad();
				expect(vi.getTimerCount()).toBe(0);

				vi.advanceTimersByTime(10_000);
				await flushThemeLoad();
				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
			} finally {
				dispose();
			}
		});

		it("ignores native events while automatic theme selection is disabled", async () => {
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			const previousThemeName = themeModule.getCurrentThemeName();
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				await flushThemeLoad();

				expect(themeModule.getCurrentThemeName()).toBe(previousThemeName);
				expect(terminal.refreshAppearance).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				dispose();
			}
		});

		it("disposer stops the observer, cancels timers, and guards retained callbacks", async () => {
			using _globals = withThemeTestGlobals();
			await themeModule.initTheme(false, undefined, undefined, "dark", "light");
			const observer = mockMacAppearanceObserver();
			const terminal = new FakeAppearanceTerminal("dark");
			const dispose = themeModule.startMacOSAppearanceReprobeFallback(terminal);
			let needsCleanup = true;
			try {
				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Light);
				await flushThemeLoad();
				expect(themeModule.getCurrentThemeName()).toBe("light");
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(7);

				dispose();
				needsCleanup = false;
				expect(observer.stop).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);

				terminal.reportPrivateMode(2031, false, true);
				observer.emit(MacOSAppearance.Dark);
				terminal.reportAppearance("light");
				vi.advanceTimersByTime(10_000);
				await flushThemeLoad();

				expect(observer.start).toHaveBeenCalledTimes(1);
				expect(observer.stop).toHaveBeenCalledTimes(1);
				expect(terminal.refreshAppearance).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				if (needsCleanup) dispose();
			}
		});
	});
});
