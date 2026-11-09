import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Settings } from "../src/config/settings";
import { cfgTerminalShowImages, cfgTuiRenderMath } from "../src/modes/settings";
import {
	ImageBudget,
	getMathImageRenderer,
	Markdown,
	releaseMathImages,
	setMathImageRenderer,
	setMarkdownMathRendering,
	withImageRenderContext,
	withMathImageOwner,
} from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { setThemeInstance } from "@oh-my-pi/pi-tui/theme/theme";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { createTestSession, type TestSessionContext } from "./utilities";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

withoutTerminalMultiplexer();
const protocol = TERMINAL.imageProtocol;
const cell = getCellDimensions();
let state: SettingsTestState;
const kitty = getKittyGraphics();
let temp: TempDir;
let settings: Settings;
let budget: ImageBudget;
let markdown: Markdown;
let completion = Promise.withResolvers<void>();
let conversions = 0;
let mode: InteractiveMode;
let testSession: TestSessionContext;
let previousRenderer = getMathImageRenderer();

function render(): string {
	budget.beginPass();
	try {
		return withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
			withMathImageOwner(
				markdown,
				() => completion.resolve(),
				() => markdown.render(60).join("\n"),
			),
		);
	} finally {
		budget.endPass();
	}
}
async function ready(): Promise<string> {
	await Promise.resolve();
	render();
	await completion.promise;
	completion = Promise.withResolvers<void>();
	return render();
}

beforeEach(async () => {
	state = beginSettingsTest();
	temp = TempDir.createSync("@pi-math-setting-");
	settings = await Settings.init({ cwd: temp.path(), agentDir: temp.join("agent"), inMemory: true, configFiles: [] });
	setThemeInstance(await loadTheme("dark"));
	testSession = await createTestSession({
		settingsOverrides: {
			"startup.checkUpdate": false,
			"startup.setupWizard": false,
			"startup.changelogMode": "hidden",
			"marketplace.autoUpdate": "off",
		},
	});
	settings = testSession.session.settings;
	mode = new InteractiveMode(testSession.session, "test");
	spyOn(mode.composer, "start").mockImplementation(() => {});
	spyOn(mode.ui, "requestRender").mockImplementation(() => {});
	spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});
	spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
	TERMINAL.imageProtocol = ImageProtocol.Kitty;
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	completion = Promise.withResolvers<void>();
	conversions = 0;
	budget = new ImageBudget(8);
	markdown = new Markdown("Before\n\n$$x+y=1$$\n\nAfter", 0, 0, getMarkdownTheme());
	previousRenderer = getMathImageRenderer();
	setMathImageRenderer({
		id: "setting-contract",
		render: () => {
			conversions++;
			return {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="1ex" height="1ex"><rect width="10" height="10" fill="white"/></svg>',
				widthEx: 1,
				heightEx: 1,
			};
		},
	});
});
afterEach(async () => {
	releaseMathImages();
	setMathImageRenderer(previousRenderer);
	mode.stop();
	await testSession.cleanup();
	setMarkdownMathRendering(false);
	TERMINAL.imageProtocol = protocol;
	setCellDimensions(cell);
	setKittyGraphics(kitty);
	settings.cancelPendingSaves();
	restoreSettingsTestState(state);
	await temp.remove();
});

it("keeps visible math Unicode by default and renders the same retained document after live enable", async () => {
	const unicode = render();
	expect(unicode).not.toContain("\x1b_G");
	expect(conversions).toBe(0);
	cfgTuiRenderMath.override(settings, true);
	expect(chatTranscriptDisplayPreferences.showImages).toBe(true);
	const graphic = await ready();
	expect(graphic).toContain("\x1b_G");
	expect(graphic).toContain("Before");
	expect(graphic).toContain("After");
	const release = spyOn(budget, "releaseId");
	try {
		cfgTuiRenderMath.override(settings, false);
		await Promise.resolve();
		expect(render()).toBe(unicode);
		expect(release).toHaveBeenCalled();
	} finally {
		release.mockRestore();
	}
});

it("restores retained Unicode when show-images turns off without changing math opt-in", async () => {
	const unicode = render();
	cfgTuiRenderMath.override(settings, true);
	expect(await ready()).toContain("\x1b_G");
	cfgTerminalShowImages.override(settings, false);
	await Promise.resolve();
	expect(render()).toBe(unicode);
	expect(cfgTuiRenderMath.get(settings)).toBe(true);
	cfgTerminalShowImages.override(settings, true);
	expect(await ready()).toContain("\x1b_G");
});

it("does not schedule conversion when global images or protocol support are absent", async () => {
	cfgTerminalShowImages.override(settings, false);
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	expect(render()).not.toContain("\x1b_G");
	expect(conversions).toBe(0);
	cfgTerminalShowImages.override(settings, true);
	await Promise.resolve();
	TERMINAL.imageProtocol = null;
	expect(render()).not.toContain("\x1b_G");
	expect(conversions).toBe(0);
});

it("keeps inline math Unicode without proven placeholder support while display math renders", async () => {
	setKittyGraphics({ unicodePlaceholders: false });
	markdown = new Markdown("Before $x+y=1$, after\n\n$$x+y=1$$", 0, 0, getMarkdownTheme());
	const unicodeInline = render().split("\n")[0];
	cfgTuiRenderMath.override(settings, true);
	const graphic = await ready();
	expect(graphic.split("\n")[0]).toBe(unicodeInline);
	expect(graphic).toContain("\x1b_G");
});

it("releases math placements without releasing an ordinary image key", async () => {
	const ordinaryId = budget.acquireId("ordinary-image");
	cfgTuiRenderMath.override(settings, true);
	await ready();
	const release = spyOn(budget, "releaseId");
	try {
		cfgTuiRenderMath.override(settings, false);
		await Promise.resolve();
		render();
		expect(release).toHaveBeenCalled();
		expect(release.mock.calls.every(([id]) => id !== ordinaryId)).toBe(true);
		expect(budget.acquireId("ordinary-image")).toBe(ordinaryId);
	} finally {
		release.mockRestore();
	}
});

it("repaints ordinary image visibility without replacing retained documents when math is off", async () => {
	mode.chatContainer.addChild(markdown);
	const repaint = spyOn(mode.ui, "requestRender");
	cfgTerminalShowImages.override(settings, false);
	await Promise.resolve();
	expect(mode.chatContainer.children).toContain(markdown);
	expect(repaint).toHaveBeenCalledWith(true);
	cfgTerminalShowImages.override(settings, true);
	await Promise.resolve();
	expect(mode.chatContainer.children).toContain(markdown);
	expect(conversions).toBe(0);
});

it("rebuilds retained transcript documents for image visibility changes when math is on", async () => {
	cfgTuiRenderMath.override(settings, true);
	await ready();
	mode.chatContainer.addChild(markdown);
	cfgTerminalShowImages.override(settings, false);
	await Promise.resolve();
	expect(mode.chatContainer.children).not.toContain(markdown);
	expect(render()).not.toContain("\x1b_G");
});

for (const showImages of [true, false]) {
	it(`applies session math opt-in at startup with show-images=${showImages}`, async () => {
		mode.stop();
		cfgTuiRenderMath.override(settings, true);
		cfgTerminalShowImages.override(settings, showImages);
		// Overwrite the policy applied by the old mode: only startup can restore it.
		setMarkdownMathRendering(!showImages);
		mode = new InteractiveMode(testSession.session, "test");
		spyOn(mode.composer, "start").mockImplementation(() => {});
		spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		if (showImages) expect(await ready()).toContain("\x1b_G");
		else {
			expect(render()).not.toContain("\x1b_G");
			expect(conversions).toBe(0);
		}
	});
}
