import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionColor from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	sessionManager: SessionManager;
	tempDir: TempDir;
};

let harness: Harness | undefined;

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}

async function createHarness(sessionName: string): Promise<Harness> {
	if (harness) {
		harness.mode.loadingAnimation?.stop();
		harness.mode.loadingAnimation = undefined;
		harness.mode.statusContainer.disposeChildren();
		await harness.sessionManager.setSessionName(sessionName, "user");
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-working-accent-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName(sessionName, "user");
	const session = {
		sessionManager,
		settings,
		agent: {
			state: { tools: [] },
			metadataForProvider: () => undefined,
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = { mode, sessionManager, tempDir };
	return harness;
}

function startStableLoader(mode: InteractiveMode): void {
	mode.ensureLoadingAnimation();
	mode.loadingAnimation?.stop();
}

function renderLoader(mode: InteractiveMode): string {
	return mode.statusContainer.render(120).join("\n");
}

function shadowAccentSurfaceLuminance(value: number | undefined): () => void {
	Object.defineProperty(theme, "accentSurfaceLuminance", {
		configurable: true,
		get: () => value,
	});
	return () => {
		delete (theme as unknown as { accentSurfaceLuminance?: number }).accentSurfaceLuminance;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode working-message session accent cache", () => {
	it("reuses one computed accent across loader spinner and message colorizers", async () => {
		const { mode } = await createHarness("Cached session");
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");
		const getAnsi = vi.spyOn(sessionColor, "getSessionAccentAnsi");

		// Colorizers run lazily at render time (loader layout cache); the accent
		// computation is observable only after a render.
		startStableLoader(mode);
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);

		mode.loadingAnimation?.setMessage("Still working");
		renderLoader(mode);
		expect(getHex).toHaveBeenCalledTimes(1);
		expect(getAnsi).toHaveBeenCalledTimes(2);
	});

	it("recomputes for session renames and keeps the main ANSI path status-line equivalent", async () => {
		const initialName = "Alpha session";
		const renamedName = "Beta session";
		const { mode, sessionManager } = await createHarness(initialName);
		const initialAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					initialName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const renamedAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					renamedName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(initialAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		await sessionManager.setSessionName(renamedName, "user");
		mode.loadingAnimation?.setMessage("Renamed session");
		expect(renderLoader(mode)).toContain(renamedAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});

	it("keys cached accents by theme accent-surface luminance", async () => {
		const sessionName = "Luminance session";
		const { mode } = await createHarness(sessionName);
		const restoreInitial = shadowAccentSurfaceLuminance(undefined);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		try {
			startStableLoader(mode);
			renderLoader(mode);
			expect(getHex).toHaveBeenCalledTimes(1);
			expect(getHex.mock.calls[0]).toEqual([sessionName, theme.getMajorThemeColorHexes(), undefined]);

			restoreInitial();
			const restoreLight = shadowAccentSurfaceLuminance(0.72);
			try {
				mode.loadingAnimation?.setMessage("Light theme");
				renderLoader(mode);
				expect(getHex).toHaveBeenCalledTimes(2);
				expect(getHex.mock.calls[1]).toEqual([sessionName, theme.getMajorThemeColorHexes(), 0.72]);
			} finally {
				restoreLight();
			}
		} finally {
			restoreInitial();
		}
	});

	it("caches disabled session accents and recomputes when the setting is enabled again", async () => {
		const sessionName = "Toggle session";
		const { mode } = await createHarness(sessionName);
		const accentAnsi = defined(
			sessionColor.getSessionAccentAnsi(
				sessionColor.getSessionAccentHex(
					sessionName,
					theme.getMajorThemeColorHexes(),
					theme.accentSurfaceLuminance,
				),
			),
		);
		const getHex = vi.spyOn(sessionColor, "getSessionAccentHex");

		startStableLoader(mode);
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", false);
		mode.loadingAnimation?.setMessage("Accent disabled");
		expect(renderLoader(mode)).not.toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(1);

		settings.set("statusLine.sessionAccent", true);
		mode.loadingAnimation?.setMessage("Accent enabled");
		expect(renderLoader(mode)).toContain(accentAnsi);
		expect(getHex).toHaveBeenCalledTimes(2);
	});
});
