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
import { TempDir, postmortem } from "@oh-my-pi/pi-utils";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { setThemeInstance } from "@oh-my-pi/pi-tui/theme/theme";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { createTestSession, type TestSessionContext } from "./utilities";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { codingAgentMathImageRenderer } from "../src/modes/math-image-renderer";
import { MATH_RENDERER_ID, type MathWorkerInbound } from "../src/modes/math-worker-protocol";
import { getMathImageWorkState, waitForMathImageWork } from "@oh-my-pi/pi-tui/components/math-image";
import { renderMathImage } from "@oh-my-pi/pi-tui";
import { registerCodingAgentMathImageRenderer } from "../src/modes/math-image-renderer";

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
const previousRenderer = getMathImageRenderer();
const nativeWorker = globalThis.Worker;
class PolicyWorker extends EventTarget {
	static instances: PolicyWorker[] = [];
	messages: MathWorkerInbound[] = [];
	terminated = false;
	constructor() {
		super();
		PolicyWorker.instances.push(this);
	}
	postMessage(message: MathWorkerInbound): void {
		this.messages.push(message);
	}
	terminate(): void {
		this.terminated = true;
	}
	reply(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	handshake(): void {
		this.reply({ type: "ready", rendererId: MATH_RENDERER_ID });
		this.reply({ ...this.messages[0], type: "pong" });
	}
}
const request = {
	tex: "x",
	display: true,
	inkHex: "#ffffff",
	cellWidthPx: 10,
	cellHeightPx: 20,
	pixelsPerEx: 10,
	maxWidthPx: 600,
};
async function useProductionMode(): Promise<void> {
	mode.stop();
	mode = new InteractiveMode(testSession.session, "test");
	spyOn(mode.composer, "start").mockImplementation(() => {});
	spyOn(mode.ui, "requestRender").mockImplementation(() => {});
	spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});
	spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
}

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
	PolicyWorker.instances = [];
	globalThis.Worker = PolicyWorker as unknown as typeof Worker;
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
	setMathImageRenderer({
		id: "setting-contract",
		render: async () => {
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
	globalThis.Worker = nativeWorker;
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
		const renderer = getMathImageRenderer();
		mode = new InteractiveMode(testSession.session, "test");
		spyOn(mode.composer, "start").mockImplementation(() => {});
		spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		spyOn(mode.ui, "resetDisplay").mockImplementation(() => {});
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		setMathImageRenderer(renderer);
		if (showImages) expect(await ready()).toContain("\x1b_G");
		else {
			expect(render()).not.toContain("\x1b_G");
			expect(conversions).toBe(0);
		}
	});
}

it("keeps default-off, image-off, unsupported and math-free enabled sessions worker-free", async () => {
	await useProductionMode();
	await expect(codingAgentMathImageRenderer.render(request)).rejects.toThrow("unavailable");
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	markdown = new Markdown("No formula here", 0, 0, getMarkdownTheme());
	render();
	cfgTerminalShowImages.override(settings, false);
	await Promise.resolve();
	await expect(codingAgentMathImageRenderer.render(request)).rejects.toThrow("unavailable");
	cfgTerminalShowImages.override(settings, true);
	await Promise.resolve();
	TERMINAL.imageProtocol = null;
	await expect(codingAgentMathImageRenderer.render(request)).rejects.toThrow("unavailable");
	expect(PolicyWorker.instances).toHaveLength(0);
});

it.each(["math", "images"])(
	"retires scheduled formula work across %s off/on without negative poisoning",
	async policy => {
		const lifecycle = registerCodingAgentMathImageRenderer({ renderMath: true, showImages: true });
		const paint = () =>
			withImageRenderContext({ budget, requestRender: () => completion.resolve() }, () =>
				withMathImageOwner(
					markdown,
					() => {},
					() => renderMathImage(request, 200, 0, "policy-formula"),
				),
			);
		try {
			// Images-off cancels an unsent formula behind a transport request; math-off cancels the active formula.
			const blocker =
				policy === "images"
					? codingAgentMathImageRenderer.render({ ...request, tex: "blocker" }).catch(error => error)
					: undefined;
			expect(paint().pending).toBe(true);
			const started = Promise.withResolvers<void>();
			setImmediate(started.resolve);
			await started.promise;
			const old = PolicyWorker.instances[0];
			old.handshake();
			lifecycle.setPolicy({ renderMath: policy !== "math", showImages: policy !== "images" });
			await waitForMathImageWork();
			expect(getMathImageWorkState().negative).toBe(0);
			if (blocker) {
				old.reply({ ...old.messages.at(-1), type: "result", result: { svg: "<svg/>", widthEx: 1, heightEx: 1 } });
				await blocker;
			}
			lifecycle.setPolicy({ renderMath: true, showImages: true });
			expect(paint().pending).toBe(true);
			const restarted = Promise.withResolvers<void>();
			setImmediate(restarted.resolve);
			await restarted.promise;
			const worker = PolicyWorker.instances.at(-1)!;
			if (policy === "math") worker.handshake();
			expect(worker.messages.at(-1)).toHaveProperty("type", "render");
			expect(worker.messages.at(-1)).toHaveProperty("request.tex", "x");
			worker.reply({
				...worker.messages.at(-1),
				type: "result",
				result: {
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="1ex" height="1ex"><rect width="10" height="10" fill="white"/></svg>',
					widthEx: 1,
					heightEx: 1,
				},
			});
			await waitForMathImageWork();
			expect(paint().graphic).toBe(true);
			expect(getMathImageWorkState().negative).toBe(0);
		} finally {
			lifecycle.dispose();
		}
	},
);
it("retains active work with images hidden but terminates on math disable and lazily restarts", async () => {
	await useProductionMode();
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	const active = codingAgentMathImageRenderer.render(request);
	const queued = codingAgentMathImageRenderer.render(request).catch(error => error);
	const worker = PolicyWorker.instances[0];
	worker.handshake();
	cfgTerminalShowImages.override(settings, false);
	await Promise.resolve();
	expect(await queued).toBeInstanceOf(Error);
	expect(worker.terminated).toBe(false);
	worker.reply({ ...worker.messages.at(-1), type: "result", result: { svg: "<svg/>", widthEx: 1, heightEx: 1 } });
	await expect(active).resolves.toHaveProperty("widthEx", 1);
	cfgTerminalShowImages.override(settings, true);
	await Promise.resolve();
	expect(PolicyWorker.instances).toHaveLength(1);
	const pending = codingAgentMathImageRenderer.render(request).catch(error => error);
	cfgTuiRenderMath.override(settings, false);
	await Promise.resolve();
	expect(await pending).toBeInstanceOf(Error);
	expect(worker.terminated).toBe(true);
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	expect(PolicyWorker.instances).toHaveLength(1);
	const restarted = codingAgentMathImageRenderer.render(request).catch(error => error);
	expect(PolicyWorker.instances).toHaveLength(2);
	mode.stop();
	expect(await restarted).toBeInstanceOf(Error);
	expect(PolicyWorker.instances[1].terminated).toBe(true);
});

it("superseded mode stop cannot terminate the current mode's pending work", async () => {
	await useProductionMode();
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	const oldMode = mode;
	mode = new InteractiveMode(testSession.session, "test");
	const pending = codingAgentMathImageRenderer.render(request).catch(error => error);
	const worker = PolicyWorker.instances[0];
	oldMode.stop();
	expect(worker.terminated).toBe(false);
	mode.stop();
	expect(await pending).toBeInstanceOf(Error);
	expect(worker.terminated).toBe(true);
});

it("settles math at synchronous begin-disposal before session cleanup completes", async () => {
	mode.stop();
	let teardown: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
	const register = spyOn(postmortem, "register").mockImplementation((id, callback) => {
		if (id === "session-teardown") teardown = callback;
		return () => {};
	});
	try {
		await useProductionMode();
	} finally {
		register.mockRestore();
	}
	cfgTuiRenderMath.override(settings, true);
	await Promise.resolve();
	const pending = codingAgentMathImageRenderer.render(request).catch(error => error);
	const worker = PolicyWorker.instances[0];
	const cleanup = Promise.withResolvers<void>();
	const dispose = spyOn(testSession.session, "dispose").mockImplementation(() => cleanup.promise);
	const save = spyOn(testSession.session.sessionManager, "saveDraft").mockImplementation(async () => {});
	try {
		expect(teardown).toBeDefined();
		const ended = teardown!(postmortem.Reason.SIGTERM);
		expect(worker.terminated).toBe(true);
		expect(await pending).toBeInstanceOf(Error);
		cleanup.resolve();
		await ended;
	} finally {
		cleanup.resolve();
		dispose.mockRestore();
		save.mockRestore();
	}
});
