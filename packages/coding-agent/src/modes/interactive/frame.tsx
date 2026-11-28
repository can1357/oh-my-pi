/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The interactive app's screen before and after a session exists: the
 * {@link Shell}, the {@link Composer} in the `composer` slot (with the status
 * line in its chrome once a session binds one), the welcome card at the top
 * of the transcript, and every dock HUD's view mounted in its slot over its
 * model.
 *
 * The CLI may build and start one early (prepaint), so the first frame shows
 * while the session loads; the interactive mode adopts it. Otherwise the mode
 * builds its own.
 */
import {
	type Accessor,
	computed,
	type JSXNode,
	nativeRendering,
	type Signal,
	signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import type { ResizeScrollback, TerminalDriverOptions } from "@oh-my-pi/pi-tui/driver/index";
import { DEFAULT_SPINNER_INTERVAL_MS, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import type { ScreenMode, SelectionMotion, TranscriptScroll } from "@oh-my-pi/pi-tui/term/backend";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { setSymbolPreset } from "../../ui/theme/service";
import type { Keybinding } from "../../config/keybindings/app-keybindings";
import { getKeybindings } from "../../config/keybindings/keybindings";
import { Composer, ComposerChips } from "../../ui/composer";
import {
	DeferredCommand,
	DeferredCommandModel,
	EditorGap,
	HookWidgets,
	HookWidgetsModel,
	HudPills,
	HudPillsModel,
	ModelCycleModel,
	ModelCycleTrack,
	PendingShellRuns,
	ProgressHud,
	ProgressHudModel,
	QueuedMessages,
	QueueModel,
	StatusHud,
	StatusHudModel,
	SubagentHud,
	SubagentHudModel,
	TodoHud,
	TodoHudModel,
	Tray,
	TrayModel,
} from "../../ui/dock";
import { actionKey, activeKeyStyle, formatTooltipKey } from "../../ui/keys/hints";
import { holdSettle, type Shell, Shell as ShellClass, type TranscriptBlock, ViewList } from "../../ui/shell";
import { type ComposerBarAction, type ComposerBarRoutes, composerFacts } from "../../ui/status/composer-facts";
import { createStatusLine, shapePlacement } from "../../ui/status/status-line";
import { composerShape, type StatusAttachment } from "../../ui/styles/composer/shapes";
import { welcomeTip } from "../../ui/welcome/tips";
import { Welcome, WelcomeModel } from "../../ui/welcome/welcome";
import type { DockModels, StatusLineView } from "../types";

/** Fullscreen transcript scroll actions and the scroll each asks for. */
const TRANSCRIPT_SCROLL_KEYS: readonly (readonly [Keybinding, TranscriptScroll])[] = [
	["app.transcript.pageUp", "page-up"],
	["app.transcript.pageDown", "page-down"],
	["app.transcript.halfPageUp", "half-up"],
	["app.transcript.halfPageDown", "half-down"],
	["app.transcript.previousPrompt", "previous-prompt"],
	["app.transcript.nextPrompt", "next-prompt"],
	["app.transcript.lineUp", "line-up"],
	["app.transcript.lineDown", "line-down"],
	["app.transcript.top", "start"],
	["app.transcript.bottom", "end"],
];

const TRANSCRIPT_SELECTION_KEYS: readonly (readonly [Keybinding, SelectionMotion])[] = [
	["app.transcript.selectLeft", "left"],
	["app.transcript.selectRight", "right"],
	["app.transcript.selectUp", "up"],
	["app.transcript.selectDown", "down"],
	["app.transcript.selectLineStart", "line-start"],
	["app.transcript.selectLineEnd", "line-end"],
	["app.transcript.clearSelection", "clear"],
];

/** How the frame starts. */
export interface AppFrameOptions {
	readonly version: string;
	/** Composer shape id (`composer.shape`). */
	readonly shape: string;
	/** `startup.quiet`: no welcome card. */
	readonly quiet?: boolean;
	/**
	 * The welcome intro is due: the interactive mode plays it ({@link AppFrame.playWelcomeIntro})
	 * or skips it, and the card stays live until then.
	 */
	readonly intro?: boolean;
	readonly vim?: boolean;
	readonly autocompleteMaxVisible?: number;
	/** `showHardwareCursor`: the terminal's cursor marks the caret (else the composer draws one). */
	readonly hardwareCursor?: boolean;
	/** `tui.imeSafeCursor`: move the box bottom border to its own row at the end of input. */
	readonly imeSafeCursor?: boolean;
	/**
	 * The terminal the frame starts on, whoever starts it (headless hosts and tests hand the
	 * interactive mode an unstarted frame on in-memory streams); {@link AppFrameStartOptions} add to it.
	 */
	readonly terminal?: {
		readonly driver?: TerminalDriverOptions;
		readonly native?: boolean;
		/** The terminal clock painters read (scripted replays); default the wall clock. */
		readonly clock?: Accessor<number>;
	};
}

/** How {@link AppFrame.start} starts the shell. */
export interface AppFrameStartOptions {
	/** The native surface's title (Tern). */
	readonly title?: string;
	readonly clearHistory?: boolean;
	/** `tui.resizeScrollback`. */
	readonly resizeScrollback: ResizeScrollback;
	/** Driver options (test streams). */
	readonly driver?: TerminalDriverOptions;
	/** Render natively when the terminal speaks TSP (default true; headless renders pass false). */
	readonly native?: boolean;
}

/** See the module docs. */
export class AppFrame {
	readonly shell: Shell = new ShellClass();
	readonly composer: Composer;
	readonly welcome: WelcomeModel;
	readonly hud: DockModels;
	/** `!`/`$` runs waiting for the turn to end (the `pendingShell` slot's stack). */
	readonly pendingShellRuns = new ViewList();
	/** The welcome card's block, while shown. */
	welcomeBlock: TranscriptBlock | undefined;
	/** A dialog shown in the composer's place (extension prompts, approvals); the composer while undefined. */
	readonly editorArea: Signal<UiNode | undefined> = signal(undefined);
	readonly #statusLine: Signal<StatusLineView | undefined> = signal(undefined);
	#barRoutes: ReadonlyMap<string, (value?: string) => void> | undefined;
	/** Shortest gap between terminal frames, ms (`1000 / tui.maxFps`). */
	readonly frameInterval: Signal<number> = signal(16);
	/** Milliseconds per terminal spinner frame (`tui.motion` / `tui.spinnerInterval`); 0 draws them still. */
	readonly spinnerInterval: Signal<number> = signal(DEFAULT_SPINNER_INTERVAL_MS);
	/** Decorative motion off in the terminal renderer (`tui.motion` reduced or none). */
	readonly reduceMotion: Signal<boolean> = signal(false);
	/** `tui.hyperlinks` as an override of the terminal's capability (`undefined` under `auto`). */
	readonly hyperlinks: Signal<boolean | undefined> = signal(undefined);
	/** `tui.textSizing`: sized headings where the terminal supports them. */
	readonly textSizing: Signal<boolean> = signal(false);
	/** `tui.screen`: where the terminal renderer draws the session. */
	readonly screen: Signal<ScreenMode> = signal<ScreenMode>("inline");
	readonly copyOnSelect: Signal<boolean> = signal(true);
	readonly wheelLines: Signal<number> = signal(0);
	readonly scrollbar: Signal<boolean> = signal(true);
	readonly exitTranscript: Signal<boolean> = signal(true);
	readonly fullscreenMouse: Signal<boolean> = signal(true);
	readonly #shape: Signal<string>;
	readonly #quiet: Signal<boolean>;
	/** Tip rolls, latched when the frame is built so the tip stays put for the session. */
	readonly #rolls: { readonly nag: number; readonly tip: number };

	readonly #terminal: AppFrameOptions["terminal"];

	constructor(options: AppFrameOptions) {
		this.#terminal = options.terminal;
		this.#rolls = { nag: Math.random(), tip: Math.random() };
		this.#shape = signal(options.shape);
		this.#quiet = signal(options.quiet === true);
		this.composer = new Composer({
			shape: options.shape,
			vim: options.vim === true,
			caret: options.hardwareCursor === false ? "drawn" : "terminal",
			imeSafeCursor: options.imeSafeCursor === true,
			dictating: () => {
				const state = this.dictation();
				return state === "recording" || state === "transcribing";
			},
			...(options.autocompleteMaxVisible !== undefined
				? { autocompleteMaxVisible: options.autocompleteMaxVisible }
				: {}),
			symbol: key => currentTheme().symbols.symbol(key),
		});
		this.composer.addActionHandler((act, value) => {
			const route = this.#barRoutes?.get(act);
			if (!route) return false;
			route(value);
			return true;
		});
		// The fullscreen transcript's scroll keys go ahead of the editor's page keys (the completion
		// popup keeps its paging; inline no transcript window takes them), and a submitted prompt
		// brings the transcript back to its live end.
		this.composer.addKeyHandler(key => {
			if (key.kind === "release" || this.composer.completing()) return false;
			if (this.screen.peek() !== "fullscreen" || !this.shell.host || this.shell.host.native) return false;
			const bindings = getKeybindings();
			if (bindings.matches(key, "tui.input.submit")) {
				this.shell.scrollTranscript("end");
				return false;
			}
			if (bindings.matches(key, "app.transcript.search")) return this.shell.host?.openSearch() ?? false;
			if (bindings.matches(key, "app.transcript.copySelection")) return this.shell.host?.copySelection() ?? false;
			const by = TRANSCRIPT_SCROLL_KEYS.find(([action]) => bindings.matches(key, action))?.[1];
			if (by !== undefined) return this.shell.scrollTranscript(by);
			const motion = TRANSCRIPT_SELECTION_KEYS.find(([action]) => bindings.matches(key, action))?.[1];
			return motion !== undefined && (this.shell.host?.extendSelection(motion) ?? false);
		});
		this.welcome = new WelcomeModel(options.version, { intro: options.intro === true });
		const todo = new TodoHudModel();
		const status = new StatusHudModel(todo);
		this.hud = {
			status,
			todo,
			subagents: new SubagentHudModel(),
			queue: new QueueModel(),
			modelCycle: new ModelCycleModel(),
			widgets: new HookWidgetsModel(),
			progress: new ProgressHudModel(status.background, () => status.row() !== undefined),
			deferred: new DeferredCommandModel(),
			pills: new HudPillsModel(),
			tray: new TrayModel(),
		};
		this.#mountDock();
		if (!options.quiet) this.showWelcome();
	}

	/**
	 * Start rendering on the process terminal, focus resting on the composer; `clearHistory`
	 * clears the terminal's scrollback first (a fresh screen for an inline session).
	 */
	async start(options: AppFrameStartOptions): Promise<void> {
		// Before the host starts: keys typed while it probes the terminal are delivered to the focused node.
		this.shell.setHome(this.composer.field);
		await this.shell.start({
			theme: currentTheme,
			// Tern draws omp's session (its composer, omp roles) for this role.
			role: "omp.session",
			...(options.title ? { title: options.title } : {}),
			version: this.welcome.version.peek(),
			driver: { resizeScrollback: options.resizeScrollback, ...this.#terminal?.driver, ...options.driver },
			...((options.native ?? this.#terminal?.native) === undefined
				? {}
				: { native: options.native ?? this.#terminal?.native }),
			frameInterval: this.frameInterval,
			spinnerInterval: this.spinnerInterval,
			reduceMotion: this.reduceMotion,
			hyperlinks: this.hyperlinks,
			textSizing: this.textSizing,
			screen: this.screen,
			copyOnSelect: this.copyOnSelect,
			wheelLines: this.wheelLines,
			scrollbar: this.scrollbar,
			exitTranscript: this.exitTranscript,
			fullscreenMouse: this.fullscreenMouse,
			...(this.#terminal?.clock ? { clock: this.#terminal.clock } : {}),
		});
		// A fresh screen is an inline concern: the fullscreen session leaves the shell's scrollback alone.
		if (options.clearHistory && this.screen.peek() === "inline") this.shell.host?.replayHistory();
		// Tern draws omp's icons with its own Nerd Font: a native surface always uses those symbols.
		if (this.shell.native()) await setSymbolPreset("nerd");
	}

	/** The composer shape (`composer.shape`, or an extension's). */
	setShape(id: string): void {
		this.#shape.set(id);
		this.composer.setShape(id);
	}

	/** `tui.imeSafeCursor`: move the box bottom border to its own row at the end of input. */
	setImeSafeCursor(enabled: boolean): void {
		this.composer.setImeSafeCursor(enabled);
	}

	/** `tui.resizeScrollback` changed: resizes that settle from now on follow `mode` (start takes the initial one). */
	setResizeScrollback(mode: ResizeScrollback): void {
		this.shell.host?.driver.setResizeScrollback(mode);
	}

	/** Draw the bar. A startup prediction has no session routes, so it advertises no click actions. */
	setStatusLine(
		statusLine: StatusLineView | undefined,
		live: { readonly actions: ComposerBarRoutes; readonly rate?: Accessor<number | undefined> } | null,
	): void {
		this.#barRoutes = statusLine && live ? new Map(Object.entries(live.actions)) : undefined;
		this.#statusLine.set(statusLine);
		if (!statusLine) {
			this.composer.setStatus(undefined);
			this.composer.setSlots({});
			return;
		}
		const placement = computed(() => shapePlacement(composerShape(this.#shape()), this.composer.completing()));
		const line = createStatusLine({ settings: statusLine.settings, facts: statusLine.facts, placement });
		this.composer.setStatus(line.chrome.composerStatus);
		this.#statusPreview = line.preview;
		this.#statusPanel.set(line.panel);
		const click = (action: ComposerBarAction) => (live ? { click: action } : undefined);
		const facts = composerFacts({ settings: statusLine.settings, facts: statusLine.facts, click });
		this.composer.setSlots({
			context: facts.context,
			chips: (
				<ComposerChips
					composer={this.composer}
					annotate={() => this.shell.native() && this.shell.host?.feature("annotate") === true}
				/>
			),
			// The model chip. With `statusLine.compactThinkingLevel` the effort ring stands in for its icon
			// (it keeps its own tooltip and click); otherwise the level gets a chip of its own.
			model: (
				<row
					key="model"
					role="omp.composer.model"
					align="center"
					gap="xs"
					tone={facts.modelTone}
					title={live ? () => keyedTitle("Switch model", "app.model.selectTemporary") : undefined}
					actions={click("status.model")}
				>
					{() => {
						const level = facts.effort();
						return level !== undefined && statusLine.settings().compactThinkingLevel ? (
							<effort
								key="effort"
								level={level}
								role="omp.composer.model.effort"
								title={keyedTitle(`Thinking effort: ${level}`, "app.thinking.cycle")}
								actions={click("thinking.cycle")}
							/>
						) : (
							<icon key="icon" name="model" />
						);
					}}
					<text key="name" spans={facts.model} wrap="none" />
					{live && <icon key="chev" name="chev" />}
				</row>
			),
			effort: () => {
				const level = facts.effort();
				if (level === undefined || statusLine.settings().compactThinkingLevel) return undefined;
				return (
					<row
						key="effort"
						role="omp.composer.effort"
						align="center"
						gap="xs"
						title={keyedTitle("Thinking effort", "app.thinking.cycle")}
						actions={click("thinking.cycle")}
					>
						<effort key="glyph" level={level} />
						<text key="level" text={level} wrap="none" />
					</row>
				);
			},
			rate: () => {
				const value = live?.rate?.();
				return value === undefined ? undefined : (
					<rate key="rate" role="omp.composer.rate" value={value} unit="tok/s" title="Generation rate" />
				);
			},
			extras: facts.extras,
			usage: facts.usage,
			dictation: () => {
				const state = this.dictation();
				if (state === undefined) return undefined;
				const busy = state === "starting" || state === "transcribing";
				return (
					<row
						key="dictation"
						role="omp.composer.dictation"
						align="center"
						gap="xs"
						tone={state === "recording" ? "error" : busy ? "pending" : undefined}
						title={DICTATION_TITLES[state]}
						// A start stays cancellable: the model can take a while to load on first use.
						actions={state === "transcribing" ? undefined : click("dictation.toggle")}
					>
						{busy ? (
							<spinner
								key="pending"
								style="orbit"
								label={state === "starting" ? "Starting…" : "Transcribing…"}
							/>
						) : (
							[
								<icon key="icon" name={state === "recording" ? "stop" : "mic"} />,
								state === "recording" &&
									(nativeRendering() ? (
										// Natively the voice as a wave and the time recorded say "recording".
										[
											<meter
												key="wave"
												role="omp.composer.dictation.wave"
												value={() => this.dictationLevel()}
												style="wave"
												size="sm"
												tone="error"
											/>,
											<elapsed key="time" age={0} format="clock" />,
										]
									) : (
										<text key="label" text="Recording · Stop" wrap="none" />
									)),
							]
						)}
					</row>
				);
			},
		});
	}

	readonly #statusPanel = signal<JSXNode>(undefined);
	/**
	 * The composer's dictation control while speech-to-text is on; undefined when it is off (no
	 * control). The interactive mode follows its speech-to-text state here.
	 */
	readonly dictation: Signal<DictationState | undefined> = signal(undefined);
	/** The microphone's loudness while dictation records, as the wave meter's value (0–1, in its steps). */
	readonly dictationLevel: Signal<number> = signal(0);
	/** The prepaint's emergency key handler, held from adoption until the mode's own keys exist. */
	#startupKeys: (() => void) | undefined;

	/** Keep the prepaint's emergency keys (Ctrl+C / Ctrl+D exit) until {@link releaseStartupKeys}. */
	holdStartupKeys(release: () => void): void {
		this.#startupKeys = release;
	}

	/** Drop the prepaint's emergency keys (the interactive mode's key handlers took over). */
	releaseStartupKeys(): void {
		this.#startupKeys?.();
		this.#startupKeys = undefined;
	}
	#statusPreview: ((attachment: StatusAttachment | undefined) => UiNode) | undefined;

	/**
	 * The status line as the composer's shape draws it on a `columns`-wide terminal (its top chrome's
	 * status at the cells inside the side chrome, or the standalone bar): the settings screen's preview row.
	 */
	statusPreviewRow(columns: number): string | undefined {
		const preview = this.#statusPreview;
		if (!preview) return undefined;
		const shape = composerShape(this.#shape.peek());
		const width = shape.statusAttachment ? Math.max(0, columns - 2 * shape.sideWidth(shape.paddingX)) : columns;
		return renderBlock(preview(shape.statusAttachment), width, { env: staticEnvironment(currentTheme()) }).rows[0];
	}

	/** The welcome card at the top of the transcript (no-op when shown or quiet). */
	showWelcome(): void {
		if (this.welcomeBlock || this.#quiet()) return;
		// The card sits between blank rows, apart from the screen's top and from what follows.
		this.welcomeBlock = this.shell.transcript.append(
			() => {
				// The intro repaints the card on the terminal clock: it settles once the intro is over.
				holdSettle(this.welcome.live);
				return (
					<col role="omp.welcome.block">
						<spacer size="sm" />
						<Welcome
							version={this.welcome.version}
							update={this.welcome.update}
							tip={() => {
								return welcomeTip({
									nagRoll: this.#rolls.nag,
									tipRoll: this.#rolls.tip,
									preset: currentTheme().symbols.preset,
									tern: this.shell.native(),
								});
							}}
							keys={() => ({
								...activeKeyStyle(),
								action: (action: string) => actionKey(action as Keybinding) || undefined,
							})}
							introStart={this.welcome.introStart}
						/>
						<spacer size="sm" />
					</col>
				);
			},
			{ spacedBelow: true, head: true, inline: true },
		);
		// Final once its intro is over: it may retire into scrollback once the transcript outgrows the screen.
		this.shell.transcript.settle(this.welcomeBlock);
	}

	/** Play the welcome intro: the logo's gradient sweep in a terminal; Tern animates its own mark. */
	playWelcomeIntro(): void {
		if (this.shell.native()) this.welcome.skipIntro();
		else this.welcome.playIntro();
	}

	/** `startup.quiet` resolved: the welcome card goes, or comes back when it was never shown. */
	setQuiet(quiet: boolean): void {
		this.#quiet.set(quiet);
		if (quiet) this.hideWelcome();
		else this.showWelcome();
	}

	/** Remove the welcome card (a `/clear`, a session switch with a quiet startup). */
	hideWelcome(): void {
		if (!this.welcomeBlock) return;
		this.shell.transcript.remove(this.welcomeBlock);
		this.welcomeBlock = undefined;
	}

	#mountDock(): void {
		const { dock } = this.shell;
		const hud = this.hud;
		dock.slot("pendingShell").set(() => <PendingShellRuns runs={this.pendingShellRuns} />);
		dock.slot("pendingMessages").set(() => <QueuedMessages model={hud.queue} />);
		dock.slot("todo").set(() => <TodoHud model={hud.todo} />);
		dock.slot("subagents").set(() => <SubagentHud model={hud.subagents} />);
		dock.slot("modelCycle").set(() => <ModelCycleTrack model={hud.modelCycle} />);
		dock.slot("deferredCommand").set(() => <DeferredCommand model={hud.deferred} />);
		dock.slot("progress").set(() => <ProgressHud model={hud.progress} />);
		dock.slot("status").set(() => <StatusHud model={hud.status} />);
		dock
			.slot("attachments")
			.set(() => (this.shell.native() ? undefined : <ComposerChips composer={this.composer} />));
		dock
			.slot("editorGap")
			.set(() => (
				<EditorGap
					widgets={hud.widgets}
					statusOccupied={hud.status.occupied}
					band={() => composerShape(this.#shape()).id === "band"}
				/>
			));
		dock.slot("widgetsAbove").set(() => <HookWidgets model={hud.widgets} placement="aboveEditor" />);
		dock.slot("widgetsBelow").set(() => <HookWidgets model={hud.widgets} placement="belowEditor" />);
		dock.slot("composer").set(() => (
			<col key="composer">
				{/* A waiting tool approval shares the composer's column, over the editor that takes its typing. */}
				{dock.slot("approval").view}
				{() => this.editorArea() ?? this.composer.node}
				{/* Tern draws omp's composer with its own bar: the terminal status bar is the terminal's. */}
				{() => (this.shell.native() ? undefined : this.#statusPanel())}
			</col>
		));
		dock.slot("pills").set(() => <HudPills model={hud.pills} />);
		dock.slot("tray").set(() => <Tray model={hud.tray} />);
	}
}

/** `label`, then the key bound to `action` after two spaces (the hover title of a control). */
function keyedTitle(label: string, action: Keybinding): string {
	const [key] = getKeybindings().keysFor(action);
	return key === undefined ? label : `${label}  ${formatTooltipKey(key)}`;
}

/** Where speech-to-text dictation into the composer stands. */
export type DictationState = "idle" | "starting" | "recording" | "transcribing";

/** The dictation control's tooltip per state. */
const DICTATION_TITLES: Record<DictationState, string> = {
	idle: "Start dictation",
	starting: "Cancel dictation",
	recording: "Stop recording and transcribe",
	transcribing: "Transcribing dictation",
};
