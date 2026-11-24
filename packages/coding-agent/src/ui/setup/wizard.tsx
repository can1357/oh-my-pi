/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The setup wizard: the splash, then each scene under the brand, step strip,
 * title and key hints, then a short outro before handing off to the app.
 *
 * Keys: Enter/Space/Escape end the splash and the outro; in a scene keys go
 * to the scene (Escape skips it); Ctrl+C leaves setup for the outro from
 * anywhere. Natively: `skip` (splash), `exit` (scenes), `continue` (outro).
 * The terminal dissolves the splash into the first scene and animates the
 * outro (`../styles/setup/wizard.ts`).
 */
import {
	type Accessor,
	batch,
	computed,
	effect,
	For,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	signal,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import { bubbleKey, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { TspTone } from "@oh-my-pi/pi-wire";
import "../styles/setup";
import type { OutroTerm, SceneFrameTerm, WizardTerm } from "../styles/setup/wizard";
import { keyLabel } from "./scenes/choice";
import { composerScene } from "./scenes/composer";
import { glyphScene } from "./scenes/glyph";
import { modelScene } from "./scenes/model";
import { signInScene } from "./scenes/sign-in";
import { themeScene } from "./scenes/theme";
import { updatesScene } from "./scenes/updates";
import { isSkipKey, SPLASH_MS, SplashView } from "./splash";
import type { SceneResult, SceneView, SetupHost, SetupScene } from "./types";
import { actionKeyId } from "../keys/hints";
import { ActionButton } from "../overlays/panels/common";
import { keyTitle } from "../styles/panels/common";

/** Every onboarding scene, in order. */
export const ALL_SCENES: readonly SetupScene[] = [
	signInScene,
	modelScene,
	glyphScene,
	composerScene,
	themeScene,
	updatesScene,
];

/** How long the splash takes to dissolve into the first scene (terminal). */
export const DISSOLVE_MS = 420;
/** How long the outro plays before setup hands off. */
export const OUTRO_MS = 1200;

/** Rows above a scene body: blank, logo (5), brand, step counter, blank, title, [subtitle], blank. */
const HEAD_ROWS = 11;
/** Rows under a scene body: blank, key hints. */
const FOOT_ROWS = 2;

type Phase =
	| { readonly kind: "splash" }
	| { readonly kind: "scene"; readonly index: number }
	| { readonly kind: "outro"; readonly at: number }
	| { readonly kind: "done" };

export interface SetupWizardProps {
	readonly host: SetupHost;
	readonly scenes: readonly SetupScene[];
	readonly version: string;
	/** Clock (ms): phases and animations read it. */
	readonly now: Accessor<number>;
	/** Terminal rows (the wizard fills the screen). */
	readonly rows: Accessor<number>;
	/** Move keyboard focus (the shell's): the wizard keeps it on the current scene's target. */
	focus?(node: UiNode): void;
	/** Setup finished (outro over or dismissed). */
	onDone(): void;
}

/** The wizard's state machine. */
export class SetupWizardModel {
	readonly start: number;
	/** When the splash ended (a key, the native `skip`, or the time-out); undefined while it plays. */
	readonly splashEnd = signal<number | undefined>(undefined);
	readonly index = signal(0);
	/** When the outro began; undefined before it. */
	readonly outroAt = signal<number | undefined>(undefined);
	readonly done = signal(false);
	readonly #props: SetupWizardProps;

	constructor(props: SetupWizardProps) {
		this.#props = props;
		this.start = untrack(props.now);
	}

	get scenes(): readonly SetupScene[] {
		return this.#props.scenes;
	}

	/** Where the wizard is now. */
	readonly phase = computed((): Phase => {
		if (this.done()) return { kind: "done" };
		const outro = this.outroAt();
		if (outro !== undefined)
			return this.#props.now() - outro >= OUTRO_MS ? { kind: "done" } : { kind: "outro", at: outro };
		const end = this.splashEnd();
		if (end === undefined && this.#props.now() - this.start < SPLASH_MS) return { kind: "splash" };
		return { kind: "scene", index: this.index() };
	});

	/** When the dissolve into the first scene started. */
	dissolveFrom(): number {
		return this.splashEnd() ?? this.start + SPLASH_MS;
	}

	skipSplash(): void {
		if (untrack(this.phase).kind === "splash") this.splashEnd.set(untrack(this.#props.now));
	}

	/** A scene ended: the next one, or the outro after the last. */
	advance(_result: SceneResult): void {
		const next = untrack(this.index) + 1;
		if (next < this.#props.scenes.length) this.index.set(next);
		else this.exit();
	}

	/** Leave setup (Ctrl+C, native `exit`, last scene done): the outro, from its start even when it already plays. */
	exit(): void {
		batch(() => {
			if (untrack(this.splashEnd) === undefined) this.splashEnd.set(untrack(this.#props.now));
			this.outroAt.set(untrack(this.#props.now));
		});
	}

	finish(): void {
		this.done.set(true);
	}

	/** The mounted scene and its body node (set as each scene mounts). */
	current: { readonly view: SceneView; readonly body: UiNode } | undefined;

	/** The wheel over a scene: its own handling, else arrow keys to where its keys go. */
	wheel(delta: number): void {
		const current = this.current;
		if (!current || untrack(this.phase).kind !== "scene") return;
		if (current.view.wheel) return current.view.wheel(delta);
		const target = wizardFocus(current.body);
		const key: KeyEvent =
			delta < 0 ? { id: "up", kind: "press", raw: "\x1b[A" } : { id: "down", kind: "press", raw: "\x1b[B" };
		bubbleKey(pathTo([current.body], target), key);
	}

	/** Body rows a scene gets at `rows` terminal rows. */
	bodyRows(rows: number, subtitle: boolean): number {
		return Math.max(0, rows - HEAD_ROWS - (subtitle ? 1 : 0) - FOOT_ROWS);
	}
}

/** The wizard; its root fills the screen. */
export function SetupWizard(props: SetupWizardProps & { readonly ref?: (model: SetupWizardModel) => void }): JSXNode {
	const model = new SetupWizardModel(props);
	props.ref?.(model);
	effect(() => {
		if (model.phase().kind === "done") untrack(() => props.onDone());
	});
	const footer = (): string =>
		`${keyLabel(actionKeyId("tui.select.up", "up"))}/${keyLabel(actionKeyId("tui.select.down", "down"))} select · ${keyLabel(actionKeyId("tui.select.confirm", "enter"))} confirm · ${keyLabel(actionKeyId("tui.select.cancel", "escape"))} skip · ${keyLabel("ctrl+c")} exit setup`;
	const onKey = (key: KeyEvent): boolean => {
		const phase = untrack(model.phase);
		if (phase.kind === "done") return false;
		if (key.id === "ctrl+c") {
			model.exit();
			return true;
		}
		if (phase.kind === "scene" || !isSkipKey(key)) return false;
		if (phase.kind === "splash") model.skipSplash();
		else model.finish();
		return true;
	};
	const kind = computed(() => model.phase().kind);
	// Scenes mount as soon as they are current (not when first drawn): a scene's mount starts its work.
	const body = signal<UiNode | undefined>(undefined);
	effect(() => {
		if (kind() !== "scene") {
			body.set(undefined);
			return;
		}
		const index = model.index();
		const scene = model.scenes[index]!;
		body.set(untrack(() => mountScene(scene, index, model, props.host, props.rows)));
	});
	const term = (): WizardTerm => ({ rows: props.rows() });
	const root = (
		<col
			role="omp.setup"
			grow={1}
			term={term}
			onKey={onKey}
			onAction={act => {
				const phase = untrack(model.phase).kind;
				if (act === "skip") model.skipSplash();
				else if (act === "exit" && phase === "scene") model.exit();
				else if (act === "continue" && phase === "outro") model.finish();
				else if (act === "wheel-up") model.wheel(-1);
				else if (act === "wheel-down") model.wheel(1);
			}}
		>
			{() => {
				switch (kind()) {
					case "splash":
						return (
							<SplashView
								nodeKey="splash"
								version={props.version}
								start={model.start}
								onSkip={() => model.skipSplash()}
							/>
						);
					case "scene":
						return <SceneFrame model={model} body={body} footer={footer} />;
					case "outro":
						return <Outro model={model} host={props.host} />;
					default:
						return <col key="done" />;
				}
			}}
		</col>
	) as unknown as UiNode;
	const focus = props.focus;
	if (focus) {
		// Keys follow the scene: its target while one is mounted, the wizard again after it.
		const target = computed(() => wizardFocus(root));
		let inScene = false;
		effect(() => {
			const node = target();
			// Opening the wizard focuses it; only a scene moves focus from there.
			if (node === root && !inScene) return;
			inScene = node !== root;
			untrack(() => focus(node));
		});
	}
	return root;
}

/** The current scene under the brand and step strip; its body is mounted per scene. */
function SceneFrame(props: {
	readonly model: SetupWizardModel;
	readonly body: Accessor<UiNode | undefined>;
	readonly footer: Accessor<string>;
}): JSXNode {
	const model = props.model;
	const scene = computed(() => model.scenes[model.index()]!);
	const term = (): SceneFrameTerm => {
		const current = scene();
		return {
			title: current.title,
			subtitle: current.subtitle || undefined,
			step: `Setup step ${model.index() + 1} of ${model.scenes.length}`,
			footer: props.footer(),
			dissolve: { from: model.dissolveFrom(), ms: DISSOLVE_MS, splashStart: model.start },
		};
	};
	return (
		<col key="scene" role="omp.setup.scene" grow={1} term={term}>
			<row key="head" role="omp.setup.head" align="center">
				<row key="brand" role="omp.setup.brand" align="center">
					<image key="logo" role="omp.setup.mark" builtin="omp" alt="omp" w={22} />
					<text key="name" role="omp.setup.brand.name" wrap="none" spans={[{ s: "strong", t: "omp" }]} />
					<text key="label" role="omp.setup.brand.label" wrap="none" spans={[{ s: "muted", t: "Setup" }]} />
				</row>
				<row key="steps" role="omp.setup.steps" align="center">
					<For each={() => model.scenes.map((_, index) => index)}>
						{index => <StepMark index={index} model={model} />}
					</For>
				</row>
				<ActionButton
					id="exit"
					label="Exit setup"
					title={`Exit setup  ${keyTitle("ctrl+c")}`}
					keys={["ctrl", "c"]}
				/>
			</row>
			{() => props.body() ?? null}
		</col>
	);
}

/** One step of the strip (and the rule before it): done, current or upcoming. */
function StepMark(props: { readonly index: number; readonly model: SetupWizardModel }): JSXNode {
	const { index, model } = props;
	const tone = (): TspTone => (index < model.index() ? "success" : index === model.index() ? "accent" : "muted");
	const label = model.scenes[index]!.step;
	return [
		index > 0 ? (
			<rule
				key={`line:${index}`}
				role="omp.setup.step.line"
				tone={() => (index <= model.index() ? "success" : "muted")}
			/>
		) : null,
		<row key={`step:${index}`} role="omp.setup.step" align="center" gap="xs" tone={tone}>
			{() =>
				index < model.index() ? (
					<icon role="omp.setup.step.disc" name="check" />
				) : (
					<text role="omp.setup.step.disc" wrap="none" text={String(index + 1)} />
				)
			}
			<text role="omp.setup.step.label" wrap="none" text={label} />
		</row>,
	] as unknown as JSXNode;
}

/** Mount `scene` and wrap its body (`body:<id>`); the current owner disposes it. */
function mountScene(
	scene: SetupScene,
	index: number,
	model: SetupWizardModel,
	host: SetupHost,
	rows: Accessor<number>,
): BodyNode {
	let finished = false;
	const view: SceneView = scene.mount({
		host,
		maxLines: () => model.bodyRows(rows(), Boolean(scene.subtitle)),
		finish: result => {
			if (finished) return;
			finished = true;
			// Scenes finish from their own handlers: move on once they are done.
			queueMicrotask(() => {
				if (untrack(model.index) === index && untrack(model.outroAt) === undefined) model.advance(result);
			});
		},
	});
	onCleanup(() => view.dispose?.());
	queueMicrotask(() => view.onMount?.());
	const node = (
		<col key={`body:${scene.id}`} role="omp.setup.body" grow={1}>
			{view.body}
		</col>
	) as unknown as BodyNode;
	node[kSceneView] = view;
	model.current = { view, body: node };
	return node;
}

/** The mounted scene view a body node holds (where its keyboard focus goes). */
const kSceneView = Symbol("omp.setup.scene-view");

interface BodyNode extends UiNode {
	[kSceneView]?: SceneView;
}

/** The node in the wizard (or a scene body under it) that takes keyboard focus: the scene's target, else the wizard. */
export function wizardFocus(root: UiNode): UiNode {
	const frame = root.children()[0];
	const body = root.key()?.startsWith("body:")
		? root
		: frame?.children().find(child => child.key()?.startsWith("body:"));
	if (!body) return root;
	const view = (body as BodyNode)[kSceneView];
	const inner = body.children()[0];
	return (inner && view?.focusTarget?.(inner)) ?? inner ?? root;
}

/** "You're all set": the default model, a progress bar, then the hand-off. */
function Outro(props: { readonly model: SetupWizardModel; readonly host: SetupHost }): JSXNode {
	const current = props.host.getModels().current;
	const term = (): OutroTerm => ({ at: props.model.outroAt() ?? 0, ms: OUTRO_MS });
	return (
		<col key="outro" role="omp.setup.outro" grow={1} align="center" actions={{ click: "continue" }} term={term}>
			<spacer key="top" grow={1} />
			<image key="logo" role="omp.setup.outro.mark" builtin="omp" alt="omp" w={72} />
			<text key="title" role="omp.setup.outro.title" wrap="none" spans={[{ s: "strong", t: "You're all set" }]} />
			{current ? (
				<text
					key="model"
					role="omp.setup.outro.model"
					wrap="none"
					truncate="end"
					spans={[
						{ s: "muted", t: "Default model" },
						{ s: "dim", t: " · " },
						{ s: "muted", t: current.name },
					]}
				/>
			) : null}
			<text key="status" role="omp.setup.outro.status" wrap="none" spans={[{ s: "muted", t: "Starting omp…" }]} />
			<progress key="progress" role="omp.setup.outro.progress" value={null} />
			<spacer key="bottom" grow={1} />
		</col>
	);
}
