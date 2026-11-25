/**
 * The `/settings` window over the real settings host on an in-memory terminal,
 * focused the way the fullscreen menu focuses it (its root takes the keys).
 */
import { afterEach, beforeEach } from "bun:test";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { createSettingsHost } from "../../src/config/settings-ui";
import { createPluginSettingsHost } from "../../src/extensibility/plugins/settings-host";
import { type SettingsCallbacks, type SettingsContext, SettingsWindow } from "../../src/ui/overlays/settings/settings";
import { mountOverlay } from "./overlay-terminal";

function mountSettingsWindow(
	options: { context?: Partial<SettingsContext>; callbacks?: Partial<SettingsCallbacks> } = {},
	size: { columns?: number; rows?: number } = {},
): TestTerminal {
	return mountOverlay(
		() =>
			SettingsWindow({
				context: {
					availableThinkingLevels: [],
					availableThemes: ["dark", "light"],
					providers: [],
					settings: createSettingsHost(),
					plugins: createPluginSettingsHost(process.cwd()),
					...options.context,
				},
				callbacks: { onChange: () => {}, onCancel: () => {}, ...options.callbacks },
			}),
		{ columns: size.columns ?? 120, rows: size.rows ?? 40, focusKind: "__root__" },
	);
}

/** Set up in-memory settings and dispose mounted windows before resetting settings after each test. */
export function setupSettingsWindow(): typeof mountSettingsWindow {
	let cleanup: DisposableStack;
	beforeEach(async () => {
		cleanup = new DisposableStack();
		cleanup.defer(resetSettingsForTest);
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});
	afterEach(() => cleanup.dispose());
	return (options, size) => cleanup.adopt(mountSettingsWindow(options, size), term => term.dispose());
}

/** The window's plain screen after a paint. */
export function settingsScreen(term: TestTerminal): string {
	term.render();
	return (term.fullscreen() ?? term.screen()).map(row => Bun.stripANSI(row)).join("\n");
}
