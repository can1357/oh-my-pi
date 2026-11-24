/**
 * The `/settings` window over the real settings host on an in-memory terminal,
 * focused the way the fullscreen menu focuses it (its root takes the keys).
 */
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { createSettingsHost } from "../../src/config/settings-ui";
import { createPluginSettingsHost } from "../../src/extensibility/plugins/settings-host";
import { type SettingsCallbacks, type SettingsContext, SettingsWindow } from "../../src/ui/overlays/settings/settings";
import { mountOverlay } from "./overlay-terminal";

export function mountSettingsWindow(
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

/** The window's plain screen after a paint. */
export function settingsScreen(term: TestTerminal): string {
	term.render();
	return (term.fullscreen() ?? term.screen()).map(row => Bun.stripANSI(row)).join("\n");
}
