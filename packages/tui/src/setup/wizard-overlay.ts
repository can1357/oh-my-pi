import { type Component, type OverlayFocusOwner } from "../tui";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { matchesKey } from "../keys";
import { centerLine, padding } from "../utils";
import { padToWidth } from "../render/utils";
import { routeSgrMouseInput, type SgrMouseEvent } from "../mouse";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { gradientLogo, PI_LOGO } from "../prompt/welcome";
import { theme } from "../theme/theme";
import { col, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeScreen, NativeUiEvent } from "../native/node";
import { Memo } from "../native/memo";
import { actionButton } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import type { SetupHost } from "./scenes/types";
import { describeSetupOutro, renderSetupOutro, SETUP_OUTRO_MS } from "./scenes/outro";
import { describeSetupSplash, renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "./scenes/splash";
import {
	SETUP_SURFACE_ROLE,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
	type SetupSceneResult,
} from "./scenes/types";

type WizardPhase = "splash" | "transition" | "scene" | "outro" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;
/** Cross-dissolve duration from the splash into the first scene. */
const SCENE_TRANSITION_MS = 420;

/** How long each timed phase lasts before the wizard advances on its own. */
const PHASE_LIMIT_MS: Partial<Record<WizardPhase, number>> = {
	splash: SETUP_SPLASH_MS,
	transition: SCENE_TRANSITION_MS,
	outro: SETUP_OUTRO_MS,
};

/** Nothing left to show once the wizard completed. */
const DONE_NODE = col([]);

/** Whether `scene` is asked under the current renderer: a TSP surface draws `ansiOnly` settings itself. */
export function setupSceneApplies(scene: SetupScene): boolean {
	return !scene.ansiOnly || !isNativeRendering();
}

/** Stepper state of one step: before, at, or after the active scene. */
type StepState = "done" | "current" | "next";

const STEP_TONE = { done: "success", current: "accent", next: "muted" } as const;

/** One stepper entry: a disc (check once done, else the step number) and the label. */
function stepNode(label: string, position: number, state: StepState): NativeNode {
	const disc =
		state === "done"
			? node("icon", { name: "check", role: "omp.setup.step.disc" })
			: text(String(position + 1), { wrap: "none", role: "omp.setup.step.disc" });
	return node(
		"row",
		{ align: "center", gap: "xs", role: "omp.setup.step", tone: STEP_TONE[state] },
		[disc, text(label, { wrap: "none", role: "omp.setup.step.label" })],
		`step:${position}`,
	);
}

function sceneFooterHint(): string {
	const navKeys = editorKeys("tui.select.up", "tui.select.down");
	return `${navKeys} select · ${editorKey("tui.select.confirm")} confirm · ${editorKey("tui.select.cancel")} skip · ${formatKeyHint("ctrl+c")} exit setup`;
}

function indentLine(line: string, width: number, indent: number): string {
	const prefix = padding(Math.min(indent, Math.max(0, width - 1)));
	return width > 0 ? padToWidth(prefix + line, width) : "";
}
/** Stable per-row jitter in [0,1) for the dissolve reveal order. */
function rowNoise(y: number): number {
	const h = Math.imul(y ^ 0x9e3779b9, 2654435761);
	return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Top-biased cross-dissolve between two equal-height frames. As `progress`
 * (0..1) advances, each row flips from `from` to `to` once it crosses a per-row
 * threshold — top rows reveal first (so the scene's mark/header materializes
 * before the splash water below it), with a little jitter for an organic edge.
 */
function dissolveFrames(from: string[], to: string[], progress: number, height: number): string[] {
	const eased = progress * progress * (3 - 2 * progress);
	const denom = Math.max(1, height - 1);
	const out: string[] = [];
	for (let y = 0; y < height; y++) {
		const threshold = 0.78 * (y / denom) + 0.22 * rowNoise(y);
		out.push((eased >= threshold ? to[y] : from[y]) ?? "");
	}
	return out;
}

/** Fullscreen onboarding presentation with scene focus and mouse routing. */
export class SetupWizardComponent implements Component, OverlayFocusOwner {
	#phase: WizardPhase = "splash";
	#phaseStartedAt = performance.now();
	#sceneIndex = 0;
	#activeScene: SetupSceneController | undefined;
	#timer: NodeJS.Timeout | undefined;
	/** Native path: one-shot at the end of a timed phase; the terminal clocks the motion. */
	#deadline: NodeJS.Timeout | undefined;
	#nativeHead = new Memo();
	#nativeScene = new Memo();
	#nativeRoot = new Memo();
	/** Display name of the default model the outro reports; `null` once looked up and absent. */
	#outroModel: string | null | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	/** Screen row where the active scene's body began in the last rendered frame. */
	#bodyRowStart = 0;
	#sceneFocusTarget: Component | undefined;

	constructor(
		readonly ctx: SetupHost,
		readonly scenes: readonly SetupScene[],
	) {}

	run(): Promise<void> {
		if (!this.scenes.some(setupSceneApplies)) {
			this.#complete();
			return this.#done.promise;
		}
		this.#phase = "splash";
		this.#phaseStartedAt = performance.now();
		this.#startTimer();
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTimer();
		this.#unmountActiveScene();
	}

	invalidate(): void {
		this.#nativeHead.clear();
		this.#nativeScene.clear();
		this.#activeScene?.invalidate?.();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		if (this.#sceneFocusTarget !== component) return false;
		return true;
	}

	handleInput(data: string): void {
		if (this.#phase === "done") return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#routeMouseEvent(event);
			});
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#beginOutro();
			return;
		}
		if (this.#phase === "splash") {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "space") ||
				matchesKey(data, "escape")
			) {
				this.#beginScene();
			}
			return;
		}
		if (this.#phase === "outro") {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "space") ||
				matchesKey(data, "escape")
			) {
				this.#complete();
			}
			return;
		}
		this.#activeScene?.handleInput?.(data);
	}

	/**
	 * Mouse handling for the fullscreen wizard (SGR tracking is on while the
	 * overlay holds the alternate screen). The frame paints from screen row 0,
	 * so report coordinates index directly into the last rendered lines: scene
	 * body rows start at #bodyRowStart, indented by SCENE_MARGIN_X. Scenes
	 * that implement routeMouse get hit-tested events (wheel, hover, click);
	 * for the rest a wheel notch falls back to an arrow key. A left click
	 * advances the splash/outro like Enter. Raw reports never reach scene
	 * keyboard input.
	 */
	#routeMouseEvent(event: SgrMouseEvent): void {
		if (this.#phase === "splash" || this.#phase === "outro") {
			if (!event.leftClick) return;
			if (this.#phase === "splash") this.#beginScene();
			else this.#complete();
			return;
		}
		const scene = this.#activeScene;
		if (!scene) return;
		if (scene.routeMouse) {
			scene.routeMouse(event, event.row - this.#bodyRowStart, event.col - SCENE_MARGIN_X);
			return;
		}
		if (event.wheel !== null) {
			scene.handleInput?.(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ctx.ui.terminal.rows);
		let lines: string[];
		switch (this.#phase) {
			case "splash":
				lines = renderSetupSplash(safeWidth, height, performance.now() - this.#phaseStartedAt);
				break;
			case "transition": {
				const elapsed = performance.now() - this.#phaseStartedAt;
				const progress = Math.min(1, elapsed / SCENE_TRANSITION_MS);
				const splash = renderSetupSplash(safeWidth, height, SETUP_SPLASH_MS + elapsed);
				const scene = this.#renderScene(safeWidth, height);
				lines = dissolveFrames(splash, scene, progress, height);
				break;
			}
			case "outro":
				lines = renderSetupOutro(safeWidth, height, performance.now() - this.#phaseStartedAt);
				break;
			case "scene":
				lines = this.#renderScene(safeWidth, height);
				break;
			case "done":
				lines = [];
				break;
		}
		return this.#fitToScreen(lines, safeWidth, height);
	}

	/** The wizard is a page of its own: a screen surface styled by {@link SETUP_SURFACE_ROLE}. */
	describeScreen(_cx: DescribeContext): NativeScreen {
		return { role: SETUP_SURFACE_ROLE, main: [this], dock: [] };
	}

	/**
	 * Fullscreen description: splash, the active scene under the setup
	 * header (brand, stepper, Exit setup), or the outro. The splash→scene
	 * dissolve is a row effect with no native counterpart, so a transition
	 * describes as the scene.
	 */
	describe(cx: DescribeContext): NativeNode {
		let content: NativeNode;
		switch (this.#phase) {
			case "splash":
				content = describeSetupSplash();
				break;
			case "transition":
			case "scene":
				content = this.#describeScene(cx.supports("picker"));
				break;
			case "outro":
				content = describeSetupOutro(this.#outroModelName());
				break;
			case "done":
				content = DONE_NODE;
				break;
		}
		return this.#nativeRoot.get([content], () =>
			col([{ ...content, key: this.#phase === "transition" ? "scene" : this.#phase }], {
				grow: 1,
				role: "omp.setup",
			}),
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "skip" && this.#phase === "splash") this.#beginScene();
		else if (event.act === "continue" && this.#phase === "outro") this.#complete();
		else if (event.act === "exit" && (this.#phase === "scene" || this.#phase === "transition")) this.#beginOutro();
	}

	/**
	 * The steps the stepper and the ANSI counter show: every scene that
	 * applies to the current renderer, plus the active one (so a renderer
	 * switch mid-scene never orphans it), and the active one's position.
	 */
	#steps(): { scenes: SetupScene[]; current: number } {
		const scenes: SetupScene[] = [];
		let current = 0;
		this.scenes.forEach((scene, index) => {
			if (index === this.#sceneIndex) current = scenes.length;
			if (index === this.#sceneIndex || setupSceneApplies(scene)) scenes.push(scene);
		});
		return { scenes, current };
	}

	/**
	 * The setup header, a fixed-height row: the compact brand lockup (the
	 * builtin `omp` mark and wordmark), the stepper of the applicable scenes
	 * (done = check in the success tone, current = accent, upcoming = muted,
	 * hairline connectors between), and a quiet Exit setup button (⌃C).
	 */
	#describeHead(): NativeNode {
		return this.#nativeHead.get([this.#sceneIndex], () => {
			const { scenes, current } = this.#steps();
			const steps: NativeChild[] = [];
			scenes.forEach((scene, position) => {
				if (position > 0) {
					steps.push(
						node(
							"rule",
							{ role: "omp.setup.step.line", tone: position <= current ? "success" : "muted" },
							undefined,
							`line:${position}`,
						),
					);
				}
				steps.push(
					stepNode(scene.step, position, position < current ? "done" : position === current ? "current" : "next"),
				);
			});
			return keyed(
				row(
					[
						keyed(
							row(
								[
									node(
										"image",
										{ builtin: "omp", alt: APP_NAME, w: 22, role: "omp.setup.mark" },
										undefined,
										"logo",
									),
									keyed(
										text([span(APP_NAME, "strong")], { wrap: "none", role: "omp.setup.brand.name" }),
										"name",
									),
									keyed(
										text([span("Setup", "muted")], { wrap: "none", role: "omp.setup.brand.label" }),
										"label",
									),
								],
								{ align: "center", role: "omp.setup.brand" },
							),
							"brand",
						),
						keyed(row(steps, { align: "center", role: "omp.setup.steps" }), "steps"),
						actionButton("Exit setup", "exit", { keys: "ctrl+c" }),
					],
					{ align: "center", role: "omp.setup.head" },
				),
				"head",
			);
		});
	}

	/**
	 * The scene page: the setup header over the body. A terminal that draws
	 * `picker` sheets gets the active scene alone (its sheet, titled with the
	 * scene, hoists into the layer and sits under the header); otherwise the
	 * scene title and subtitle head the scene's inline content.
	 */
	#describeScene(pickers: boolean): NativeNode {
		const scene = this.scenes[this.#sceneIndex];
		const active = this.#activeScene;
		const title = active?.title ?? scene?.title ?? "Setup";
		const subtitle = active?.subtitle;
		const head = this.#describeHead();
		return this.#nativeScene.get([head, active, title, subtitle, pickers], () => {
			const body: NativeChild[] = [];
			if (!pickers) {
				body.push(keyed(text([span(title, "strong")], { role: "omp.setup.title" }), "title"));
				if (subtitle) body.push(keyed(text([span(subtitle, "muted")], { role: "omp.setup.subtitle" }), "subtitle"));
			}
			if (active) body.push(active);
			return col(
				[
					head,
					// Keyed by scene so a new scene's nodes never reuse the previous one's ids.
					node("col", { grow: 1, role: "omp.setup.body" }, body, `body:${scene?.id ?? this.#sceneIndex}`),
				],
				{ grow: 1, role: "omp.setup.scene" },
			);
		});
	}

	/** The default model's display name for the outro, looked up once per outro. */
	#outroModelName(): string | undefined {
		if (this.#outroModel === undefined) this.#outroModel = this.ctx.getModels().current?.name ?? null;
		return this.#outroModel ?? undefined;
	}

	#renderScene(width: number, height: number): string[] {
		const scene = this.scenes[this.#sceneIndex];
		const title = this.#activeScene?.title ?? scene?.title ?? "Setup";
		const subtitle = this.#activeScene?.subtitle;
		const { scenes: steps, current } = this.#steps();
		const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - SCENE_MARGIN_X * 2);
		const logo = gradientLogo(PI_LOGO, 0);
		const header = [
			"",
			...logo.map(line => centerLine(line, width)),
			centerLine(theme.bold(theme.fg("accent", APP_NAME)), width),
			centerLine(theme.fg("muted", `Setup step ${current + 1} of ${steps.length}`), width),
			"",
			indentLine(theme.bold(title), width, SCENE_MARGIN_X),
		];
		if (subtitle) {
			header.push(indentLine(theme.fg("muted", subtitle), width, SCENE_MARGIN_X));
		}
		header.push("");
		this.#bodyRowStart = header.length;

		const footer = ["", centerLine(theme.fg("dim", sceneFooterHint()), width)];
		const maxBodyLines = Math.max(0, height - header.length - footer.length);
		const body = this.#activeScene?.render(contentWidth, maxBodyLines).slice(0, maxBodyLines) ?? [];
		const lines = [...header, ...body.map(line => indentLine(line, width, SCENE_MARGIN_X))];
		while (lines.length + footer.length < height) {
			lines.push("");
		}
		lines.push(...footer);
		return lines;
	}

	#fitToScreen(lines: string[], width: number, height: number): string[] {
		const fitted = lines.slice(0, height).map(line => (width > 0 ? padToWidth(line, width) : ""));
		while (fitted.length < height) {
			fitted.push(padding(width));
		}
		return fitted;
	}

	/**
	 * ANSI: repaint every tick and advance timed phases from it. Native: no
	 * repaint loop; a one-shot fires when the current timed phase ends (none
	 * while a scene is up). Call again whenever the phase changes.
	 */
	#startTimer(): void {
		if (isNativeRendering()) {
			if (this.#timer) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
			clearTimeout(this.#deadline);
			this.#deadline = undefined;
			const limit = PHASE_LIMIT_MS[this.#phase];
			if (limit === undefined) return;
			const remaining = limit - (performance.now() - this.#phaseStartedAt);
			this.#deadline = setTimeout(() => this.#tick(), Math.max(0, remaining));
			return;
		}
		if (this.#timer) return;
		this.#timer = setInterval(() => this.#tick(), SETUP_TICK_MS);
	}

	#tick(): void {
		if (this.#disposed) return;
		const elapsed = performance.now() - this.#phaseStartedAt;
		if (this.#phase === "splash" && elapsed >= SETUP_SPLASH_MS) {
			this.#beginScene();
		} else if (this.#phase === "transition" && elapsed >= SCENE_TRANSITION_MS) {
			this.#phase = "scene";
			this.#phaseStartedAt = performance.now();
			this.#startTimer();
			this.ctx.ui.requestRender();
		} else if (this.#phase === "outro" && elapsed >= SETUP_OUTRO_MS) {
			this.#complete();
		} else if (isNativeRendering() || !this.#timer) {
			// Re-arm the deadline, or switch loops when the native surface opened/closed.
			this.#startTimer();
		} else {
			this.ctx.ui.requestRender();
		}
	}

	#stopTimer(): void {
		clearTimeout(this.#deadline);
		this.#deadline = undefined;
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#mountSceneController(targetPhase: "scene" | "transition"): void {
		if (this.#disposed) return;
		this.#unmountActiveScene();
		// Decided at mount time, so a native surface opened or closed mid-wizard is honored.
		while (this.#sceneIndex < this.scenes.length && !setupSceneApplies(this.scenes[this.#sceneIndex])) {
			this.#sceneIndex += 1;
		}
		if (this.#sceneIndex >= this.scenes.length) {
			this.#beginOutro();
			return;
		}
		const scene = this.scenes[this.#sceneIndex];
		const host: SetupSceneHost = {
			ctx: this.ctx,
			requestRender: () => this.ctx.ui.requestRender(),
			finish: (_result: SetupSceneResult) => this.#finishScene(),
			setFocus: component => {
				this.#sceneFocusTarget = component ?? undefined;
				this.ctx.ui.setFocus(component);
			},
			restoreFocus: () => {
				this.#sceneFocusTarget = undefined;
				this.ctx.ui.setFocus(this);
			},
		};
		this.#activeScene = scene.mount(host);
		this.#phase = targetPhase;
		this.#phaseStartedAt = performance.now();
		this.#sceneFocusTarget = undefined;
		this.ctx.ui.setFocus(this);
		this.#startTimer();
		void this.#activeScene.onMount?.();
		this.ctx.ui.requestRender();
	}

	/** Enter the first scene through a dissolve from the splash (a row effect, so native cuts straight in). */
	#beginScene(): void {
		this.#mountSceneController(isNativeRendering() ? "scene" : "transition");
	}

	#mountCurrentScene(): void {
		this.#mountSceneController("scene");
	}

	#finishScene(): void {
		if (this.#phase !== "scene" && this.#phase !== "transition") return;
		this.#unmountActiveScene();
		this.#sceneIndex += 1;
		this.#mountCurrentScene();
	}

	#unmountActiveScene(): void {
		this.#sceneFocusTarget = undefined;
		this.#activeScene?.onUnmount?.();
		this.#activeScene?.dispose?.();
		this.#activeScene = undefined;
	}

	#beginOutro(): void {
		if (this.#phase === "done") return;
		this.#unmountActiveScene();
		this.#phase = "outro";
		this.#outroModel = undefined;
		this.#phaseStartedAt = performance.now();
		this.ctx.ui.setFocus(this);
		this.#startTimer();
		this.ctx.ui.requestRender();
	}

	#complete(): void {
		if (this.#phase === "done") return;
		this.#phase = "done";
		this.#stopTimer();
		this.#done.resolve();
	}
}
