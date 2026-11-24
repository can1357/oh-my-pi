import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSetupVersion } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	runProviderSetupWizard,
	runSetupWizard,
	runStartupSplash,
} from "@oh-my-pi/pi-coding-agent/modes/setup";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Shell } from "../src/ui/shell/shell";
import { type NativePage, nativeShell } from "./helpers/native-shell";

const ESCAPE = "\x1b[27u";
const ENTER = "\r";
const SPACE = " ";
const CTRL_C = "\x03";

interface Shape {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly Shape[];
}

/** A region of `page` (the page on top), as Tern holds it. */
function region(page: NativePage | undefined, id: "main" | "dock" | "layer"): readonly Shape[] {
	if (!page) throw new Error("No page is open");
	return page.region(id) as readonly Shape[];
}

/** The first node under `nodes` with `role`. */
function byRole(nodes: readonly Shape[], role: string): Shape | undefined {
	for (const node of nodes) {
		if (node.p?.role === role) return node;
		const hit = node.c && byRole(node.c, role);
		if (hit) return hit;
	}
	return undefined;
}

/** `kind` or `kind:role` of each node. */
function names(nodes: readonly Shape[] | undefined): string[] {
	return (nodes ?? []).map(node => (node.p?.role ? `${node.k}:${String(node.p.role)}` : node.k));
}

/** Which wizard screen `page` shows: what stands under `omp.setup`. */
function screen(page: NativePage | undefined): string[] {
	return names(byRole(region(page, "main"), "omp.setup")?.c);
}

/** Let promise continuations and queued microtasks of the last input run. */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function model(id: string, name: string): Model {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "parity",
		baseUrl: "http://127.0.0.1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

interface Context {
	readonly ctx: InteractiveModeContext;
	readonly settings: Settings;
	/** What the app was told: `intro`, `setModel <selector>`. */
	readonly events: string[];
}

/** An interactive-mode context over `shell`; its sign-in asks one question and waits for the answer. */
function setupContext(shell: Shell, models: readonly Model[] = []): Context {
	const events: string[] = [];
	const settings = Settings.isolated();
	const authStorage = {
		credentials: { has: () => false },
		keys: { source: () => undefined },
		oauth: {
			login: async (_provider: string, callbacks: { onPrompt(prompt: { message: string }): Promise<string> }) => {
				await callbacks.onPrompt({ message: "Paste your API key" });
			},
		},
	};
	const ctx = {
		settings,
		shell,
		playWelcomeIntro: () => void events.push("intro"),
		openInBrowser: () => {},
		showError: (message: string) => void events.push(`error ${message}`),
		session: {
			model: models[0],
			effectiveServiceTier: () => undefined,
			refreshScopedModels: async () => {},
			setModel: async (_model: Model, _role: string, options: { selector: string }) => {
				events.push(`setModel ${options.selector}`);
			},
			modelRegistry: {
				authStorage,
				getAvailable: () => [...models],
				getAll: () => [...models],
				refresh: async () => {},
				refreshProvider: async () => {},
			},
		},
	} as unknown as InteractiveModeContext;
	return { ctx, settings, events };
}

describe("the setup page in Tern", () => {
	it("opens /setup as a page of the setup role whose content is all main", async () => {
		await using ui = await nativeShell();
		const done = runProviderSetupWizard(setupContext(ui.shell).ctx);

		expect(ui.page()?.role).toBe("omp.app.setup");
		expect(names(region(ui.page(), "main"))).toEqual(["col:omp.setup"]);
		expect(screen(ui.page())).toEqual(["col:omp.setup.splash"]);
		expect(region(ui.page(), "dock")).toEqual([]);
		expect(region(ui.page(), "layer")).toEqual([]);

		ui.type(ESCAPE);
		await settle();
		// The step is the scene under the setup header; its provider sheet sits in the page's layer.
		expect(screen(ui.page())).toEqual(["col:omp.setup.scene"]);
		expect(names(byRole(region(ui.page(), "main"), "omp.setup.scene")?.c)).toEqual([
			"row:omp.setup.head",
			"col:omp.setup.body",
		]);
		expect(names(region(ui.page(), "layer"))).toEqual(["picker:omp.setup.sheet"]);
		expect(region(ui.page(), "layer")[0]?.p?.title).toBe("Sign in to your providers");

		ui.type(CTRL_C);
		ui.type(ENTER);
		await done;
	});

	it("closes /setup with Escape alone: past the splash, the step and the outro, back to the session", async () => {
		await using ui = await nativeShell();
		const before = ui.shell.focused();
		const { ctx, settings, events } = setupContext(ui.shell);
		let closed = false;
		const done = runProviderSetupWizard(ctx).then(() => {
			closed = true;
		});

		ui.type(ESCAPE);
		await settle();
		expect(names(region(ui.page(), "layer"))).toEqual(["picker:omp.setup.sheet"]);

		ui.type(ESCAPE);
		await settle();
		expect(screen(ui.page())).toEqual(["col:omp.setup.outro"]);
		expect(region(ui.page(), "layer")).toEqual([]);
		expect(closed).toBe(false);

		ui.type(ESCAPE);
		await done;
		expect(ui.page()).toBeUndefined();
		expect(ui.shell.overlays.open()).toBe(false);
		expect(ui.shell.focused()).toBe(before);
		// `/setup` is the sign-in step alone: onboarding is neither recorded nor followed by the welcome intro.
		expect(cfgSetupVersion.get(settings)).toBe(0);
		expect(events).toEqual([]);
	});

	it("leaves setup with Ctrl+C from the splash and ends the outro with Space", async () => {
		await using ui = await nativeShell();
		const done = runProviderSetupWizard(setupContext(ui.shell).ctx);

		ui.type(CTRL_C);
		await settle();
		expect(screen(ui.page())).toEqual(["col:omp.setup.outro"]);

		ui.type(SPACE);
		await done;
		expect(ui.page()).toBeUndefined();
	});

	it("takes clicks on the splash and the outro", async () => {
		await using ui = await nativeShell();
		const done = runProviderSetupWizard(setupContext(ui.shell).ctx);

		ui.click("col", "splash");
		await settle();
		expect(screen(ui.page())).toEqual(["col:omp.setup.scene"]);

		ui.type(CTRL_C);
		await settle();
		ui.click("col", "outro");
		await done;
		expect(ui.page()).toBeUndefined();
	});

	it("shows a sign-in as a sheet over the page, typed into and left with Escape", async () => {
		await using ui = await nativeShell();
		const done = runProviderSetupWizard(setupContext(ui.shell).ctx);
		ui.type(ENTER);
		await settle();

		ui.type(ENTER);
		await settle();
		expect(names(region(ui.page(), "layer"))).toEqual(["overlay:omp.overlay.login"]);
		// Where the dialog is mounted the page keeps bare columns: the sheet is all Tern draws of it.
		expect(byRole(region(ui.page(), "main"), "omp.setup.body")?.c).toEqual([{ k: "col", c: [{ k: "col" }] }]);

		ui.type("sk");
		expect(ui.node("input").p.text).toBe("sk");

		ui.type(ESCAPE);
		await settle();
		expect(names(region(ui.page(), "layer"))).toEqual(["picker:omp.setup.sheet"]);
		expect(screen(ui.page())).toEqual(["col:omp.setup.scene"]);

		ui.type(ESCAPE);
		ui.type(ESCAPE);
		await done;
	});

	it("walks the first run: sign-in skipped, a chat model saved, the outro naming it, then the session", async () => {
		await using ui = await nativeShell();
		const { ctx, settings, events } = setupContext(ui.shell, [
			model("alpha", "Alpha Local"),
			model("beta", "Beta Local"),
		]);
		const scenes = ALL_SCENES.filter(scene => scene.id === "providers" || scene.id === "model");
		const done = runSetupWizard(ctx, scenes);

		ui.type(ENTER);
		await settle();
		ui.type(ESCAPE);
		await settle();
		const sheet = region(ui.page(), "layer")[0];
		expect(sheet?.k).toBe("picker");
		expect(sheet?.p).toMatchObject({
			role: "omp.setup.sheet",
			title: "Choose your default model",
			selected: "parity/alpha",
			total: 2,
		});
		// The stepper marks the finished step and the current one.
		expect(names(byRole(region(ui.page(), "main"), "omp.setup.steps")?.c)).toEqual([
			"row:omp.setup.step",
			"rule:omp.setup.step.line",
			"row:omp.setup.step",
		]);

		ui.type(ENTER);
		await settle();
		expect(events).toEqual(["setModel parity/alpha"]);
		expect(screen(ui.page())).toEqual(["col:omp.setup.outro"]);
		expect(byRole(region(ui.page(), "main"), "omp.setup.outro.model")?.p?.spans).toEqual([
			{ s: "muted", t: "Default model" },
			{ s: "dim", t: " · " },
			{ s: "muted", t: "Alpha Local" },
		]);

		ui.type(ENTER);
		await done;
		expect(ui.page()).toBeUndefined();
		expect(cfgSetupVersion.get(settings)).toBe(CURRENT_SETUP_VERSION);
		expect(events).toEqual(["setModel parity/alpha", "intro"]);
	});

	it("shows the startup splash on the setup page and ends it with a key", async () => {
		await using ui = await nativeShell();
		const done = runStartupSplash(setupContext(ui.shell).ctx);

		expect(ui.page()?.role).toBe("omp.app.setup");
		expect(names(region(ui.page(), "main"))).toEqual(["col:omp.setup.splash"]);
		expect(region(ui.page(), "dock")).toEqual([]);

		ui.type(ENTER);
		await done;
		expect(ui.page()).toBeUndefined();
	});
});
