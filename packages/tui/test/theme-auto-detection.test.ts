import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import * as nativesModule from "@oh-my-pi/pi-natives";
import { type MacAppearanceObserver, MacOSAppearance } from "@oh-my-pi/pi-natives";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";
import { getTerminalBackgroundColor, setTerminalBackgroundColor } from "@oh-my-pi/pi-tui/terminal-capabilities";

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
		setTerminalBackgroundColor(undefined);
		const darkTheme = await themeModule.getThemeByName("dark");
		if (!darkTheme) {
			throw new Error("Failed to load dark theme for tests");
		}
		themeModule.setThemeInstance(darkTheme);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		themeModule.stopThemeWatcher();
		setTerminalBackgroundColor(undefined);
		vi.restoreAllMocks();
	});

	it("uses detected black or white only when OSC 11 has not reported actual RGB", () => {
		using _globals = withThemeTestGlobals({ platform: "linux", colorfgbg: "0;15" });
		expect(getTerminalBackgroundColor()).toBe(0xffffff);
		setTerminalBackgroundColor(0x102030);
		expect(getTerminalBackgroundColor()).toBe(0x102030);
		Bun.env.COLORFGBG = "15;0";
		expect(getTerminalBackgroundColor()).toBe(0x102030);
		setTerminalBackgroundColor(undefined);
		expect(getTerminalBackgroundColor()).toBe(0x000000);
	});

	it("shares terminal-reported appearance fallback rather than the active theme palette", () => {
		using _globals = withThemeTestGlobals({ platform: "linux", colorfgbg: "15;0" });
		themeModule.onTerminalAppearanceChange("light");
		expect(getTerminalBackgroundColor()).toBe(0xffffff);
	});

	it("ignores cached OSC 11 RGB in favor of COLORFGBG on Darwin inside Zellij", () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		setTerminalBackgroundColor(0x102030);
		themeModule.onTerminalAppearanceChange("light");

		expect(themeModule.detectTerminalBackground()).toBe("dark");
		expect(getTerminalBackgroundColor()).toBe(0x000000);

		Bun.env.COLORFGBG = "0;15";
		themeModule.onTerminalAppearanceChange("dark");
		expect(themeModule.detectTerminalBackground()).toBe("light");
		expect(getTerminalBackgroundColor()).toBe(0xffffff);
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("prefers COLORFGBG before macOS fallback inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1", colorfgbg: "15;0" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("keeps honoring terminal-reported appearance and RGB on direct Darwin", async () => {
		using _globals = withThemeTestGlobals({ colorfgbg: "0;15" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		const observerSpy = vi.spyOn(nativesModule.MacAppearanceObserver, "start");

		setTerminalBackgroundColor(0x102030);
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(getTerminalBackgroundColor()).toBe(0x102030);
		expect(detectSpy).not.toHaveBeenCalled();
		expect(observerSpy).not.toHaveBeenCalled();
	});

	it("updates auto theme and fallback compositing RGB from the native observer despite cached RGB in Zellij", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const observer = mockMacAppearanceObserver();
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		setTerminalBackgroundColor(0x102030);
		themeModule.onTerminalAppearanceChange("dark");

		await themeModule.initTheme(true, undefined, undefined, "dark", "light");

		expect(observer.start).toHaveBeenCalledTimes(1);
		expect(themeModule.getCurrentThemeName()).toBe("light");
		expect(getTerminalBackgroundColor()).toBe(0xffffff);

		observer.emit(MacOSAppearance.Dark);
		expect(getTerminalBackgroundColor()).toBe(0x000000);
		await Bun.sleep(0);

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		themeModule.stopThemeWatcher();
		expect(observer.stop).toHaveBeenCalledTimes(1);
	});

	it("publishes fallback RGB changes after a missing startup theme falls back to dark", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const observer = mockMacAppearanceObserver();
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Dark);
		const missingTheme = `missing-background-${crypto.randomUUID()}`;
		await themeModule.initTheme(true, undefined, undefined, missingTheme, missingTheme);

		const backgrounds: number[] = [];
		const unsubscribe = themeModule.onTerminalBackgroundFallbackChange(() =>
			backgrounds.push(getTerminalBackgroundColor()),
		);
		try {
			expect(getTerminalBackgroundColor()).toBe(0x000000);
			observer.emit(MacOSAppearance.Light);
			expect(backgrounds).toEqual([0xffffff]);
			expect(getTerminalBackgroundColor()).toBe(0xffffff);
		} finally {
			unsubscribe();
		}
	});

	it("re-arms the macOS fallback observer after a runtime theme change", async () => {
		using _globals = withThemeTestGlobals({ zellij: "1" });
		const observer = mockMacAppearanceObserver();
		vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);

		await themeModule.initTheme(true, undefined, undefined, "dark", "light");
		expect(observer.start).toHaveBeenCalledTimes(1);

		const changes: string[] = [];
		const unsubscribe = themeModule.onTerminalBackgroundFallbackChange(() => changes.push("changed"));
		try {
			// ExtensionUIContext.setTheme drives setTheme(name, true); its watcher
			// restart calls stopThemeWatcher(), which tears down the SIGWINCH handler
			// and the macOS appearance observer that feeds the SIXEL background
			// fallback. It must restart that pair, or later host appearance changes
			// never reach the fallback repaint subscription.
			const result = await themeModule.setTheme("dark", true);
			expect(result.success).toBe(true);
			expect(observer.start).toHaveBeenCalledTimes(2);

			observer.emit(MacOSAppearance.Dark);
			expect(changes).toEqual(["changed"]);
		} finally {
			unsubscribe();
		}
	});

	it("keeps trusting terminal-reported appearance and RGB on Linux inside Zellij", async () => {
		using _globals = withThemeTestGlobals({ platform: "linux", zellij: "1", colorfgbg: "0;15" });
		const detectSpy = vi.spyOn(nativesModule, "detectMacOSAppearance").mockReturnValue(MacOSAppearance.Light);
		setTerminalBackgroundColor(0x102030);

		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");

		expect(themeModule.getCurrentThemeName()).toBe("dark");
		expect(getTerminalBackgroundColor()).toBe(0x102030);
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
