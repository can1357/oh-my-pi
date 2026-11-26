/**
 * The whole interactive app on an in-memory terminal, as the app corpus
 * (`packages/tui/test/corpus/app`) was captured: the real `InteractiveMode`
 * rendering through the pi-tui terminal driver into kitty's VT engine, an
 * `AgentSession` with the real built-in tools and a scripted model as its only
 * model, and the input loop of `main.ts` (`getUserInput` →
 * `submitInteractiveInput`). Import `./env` before this module.
 */
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import { memoryTerminal, type MemoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { CELL_U32, type Color, decodeCell, KittyTerminal, loadModuleSync } from "kitty-vt-wasm";
import { APP_HOME, APP_PROJECT, APP_ROOT, resetAppRoot } from "./support/env";
import { ScriptedModel, type Turn } from "./support/model";
import { PINNED_NOW, reseedRandom, setPinnedNow } from "./support/pin-env";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { submitInteractiveInput } from "../../../src/main";
import { AppFrame } from "../../../src/modes/interactive/frame";
import { InteractiveMode } from "../../../src/modes/interactive-mode";
import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgShowHardwareCursor,
	cfgStartupQuiet,
	cfgTuiVimMode,
} from "../../../src/modes/settings";
import { AgentSession } from "../../../src/session/agent-session";
import { AuthStorage } from "../../../src/session/auth-storage";
import { convertToLlm } from "../../../src/session/messages";
import { SessionManager } from "../../../src/session/session-manager";
import { createTools, type ToolSession } from "../../../src/tools";
import { initTheme } from "../../../src/ui/theme/service";
import { EventBus } from "../../../src/utils/event-bus";

export interface AppOptions {
	readonly cols: number;
	readonly rows: number;
	readonly theme: "dark" | "light";
	/** Setting overrides (by id) on top of {@link BASE_SETTINGS}. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** Play the animated welcome intro (default: settled welcome, no intro). */
	readonly welcomeIntro?: boolean;
}

/** Settings every scenario runs under (network, side models and machine-dependent features off). */
export const BASE_SETTINGS: Readonly<Record<string, unknown>> = {
	"compaction.enabled": false,
	"startup.checkUpdate": false,
	"retry.enabled": false,
	"display.smoothStreaming": false,
	// Ghost words come from an n-gram model of the machine's prompt history (served by the user's daemon).
	"spelling.autocomplete": "off",
};

/** Built-in tools every scenario mounts. */
const TOOLS = ["bash", "read", "edit", "write", "todo"];

/** The app's display version (welcome card, status line). */
export const APP_VERSION = "14.0.0";

/** History lines the terminal keeps (the capture terminal's cap). */
const SCROLLBACK_LINES = 1000;

const kittyModule = loadModuleSync(Bun.resolveSync("kitty-vt-wasm/kitty-vt.wasm", import.meta.dir));

/** Deferred tool runs, released by the scenario. */
class ToolGates {
	readonly #held = new Map<string, PromiseWithResolvers<void>>();
	readonly holdIds = new Set<string>();
	/** Tool runs waiting at their gate (scripted as still running). */
	held = 0;
	/** Tool executions the session has started and not yet ended. */
	executions = 0;

	/** A released tool is still working (its end event has not arrived): the grid is not settled. */
	get busy(): boolean {
		return this.executions > this.held;
	}

	wait(id: string): Promise<void> | undefined {
		if (!this.holdIds.has(id)) return undefined;
		let gate = this.#held.get(id);
		if (!gate) {
			gate = Promise.withResolvers<void>();
			this.#held.set(id, gate);
		}
		return gate.promise;
	}

	release(id: string): void {
		this.holdIds.delete(id);
		let gate = this.#held.get(id);
		if (!gate) {
			gate = Promise.withResolvers<void>();
			this.#held.set(id, gate);
		}
		gate.resolve();
	}
}

function gateTool(tool: AgentTool, gates: ToolGates): AgentTool {
	const execute = tool.execute.bind(tool);
	tool.execute = async (toolCallId, params, signal, ...rest) => {
		const gate = gates.wait(toolCallId);
		// A held run still honours an interrupt: the real tool then sees the aborted signal.
		if (gate && !signal?.aborted) {
			const { promise: aborted, resolve } = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => resolve(), { once: true });
			gates.held++;
			try {
				await Promise.race([gate, aborted]);
			} finally {
				gates.held--;
			}
		}
		return execute(toolCallId, params, signal, ...rest);
	};
	return tool;
}

/** Real elapsed time (pin-env freezes `performance.now`). */
const realNow = (): number => Bun.nanoseconds() / 1e6;

/**
 * Timers at most this long count as pending app work: the input tokenizer holding a lone ESC for
 * its grace period (150 ms) before it becomes the Escape key, the subagent observer's 100 ms
 * coalescing, frame scheduling. A stage is read only once none is pending, since on a loaded
 * machine one can fire after the grid already held still for {@link STABLE_MS}. Longer timers are
 * not waited for: the perpetual heartbeats (the loop watchdog's and the driver's stall poll, 250 ms)
 * and background delays (usage refresh, polls).
 */
const SHORT_TIMER_MS = 200;
/** Pending short timers by id (a timer clears by its object or its numeric id, through either clear function). */
const shortTimers = new Set<number>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
globalThis.setTimeout = Object.assign((handler: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
	if (!((delay ?? 0) <= SHORT_TIMER_MS)) return realSetTimeout(handler, delay, ...args);
	const timer = realSetTimeout(
		(...values: unknown[]) => {
			shortTimers.delete(Number(timer));
			handler(...values);
		},
		delay,
		...args,
	);
	shortTimers.add(Number(timer));
	return timer;
}, realSetTimeout) as typeof setTimeout;
globalThis.clearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
	if (timer !== undefined && timer !== null) shortTimers.delete(Number(timer));
	realClearTimeout(timer);
}) as typeof clearTimeout;
globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
	if (timer !== undefined && timer !== null) shortTimers.delete(Number(timer));
	realClearInterval(timer);
}) as typeof clearInterval;
/** How long the grid must hold still before a stage is read (beyond the app's real-time coalescing windows). */
const STABLE_MS = 150;
/** Polls (10 ms apart) {@link App.settle} makes before it reports the app as never settling. */
const SETTLE_ROUNDS = 1_000;

export interface GridSnapshot {
	readonly viewport: string[];
	readonly scrollback: string[];
	readonly cursor: { row: number; col: number; visible: boolean };
	readonly alt: boolean;
}

function colorCode(color: Color, base: 38 | 48): string | undefined {
	if (color === null) return undefined;
	if ("rgb" in color) return `${base};2;${(color.rgb >> 16) & 0xff};${(color.rgb >> 8) & 0xff};${color.rgb & 0xff}`;
	return `${base};5;${color.index}`;
}

/** A grid row in the corpus' canonical cell encoding (the capture encoded each cell this way). */
function rowToAnsi(words: Uint32Array | null): string {
	if (!words) return "";
	const cells = words.length / CELL_U32;
	let end = 0;
	for (let x = 0; x < cells; x++) {
		const cell = decodeCell(words, x * CELL_U32);
		if (cell.wideTrail) continue;
		const blank = cell.ch === "" || cell.ch === " ";
		if (!blank || cell.bg !== null || cell.reverse || cell.underline !== 0 || cell.strikethrough) end = x + 1;
	}
	let out = "";
	let current = "";
	for (let x = 0; x < end; x++) {
		const cell = decodeCell(words, x * CELL_U32);
		if (cell.wideTrail) continue;
		const codes: string[] = [];
		if (cell.bold) codes.push("1");
		if (cell.dim) codes.push("2");
		if (cell.italic) codes.push("3");
		if (cell.underline === 1) codes.push("4");
		else if (cell.underline > 1) codes.push(`4:${cell.underline}`);
		if (cell.reverse) codes.push("7");
		if (cell.strikethrough) codes.push("9");
		const fg = colorCode(cell.fg, 38);
		if (fg) codes.push(fg);
		const bg = colorCode(cell.bg, 48);
		if (bg) codes.push(bg);
		const style = codes.join(";");
		if (style !== current) {
			out += style === "" ? "\x1b[0m" : `\x1b[0;${style}m`;
			current = style;
		}
		out += (cell.ch === "" ? " " : cell.ch) + cell.combining.join("");
	}
	if (current !== "") out += "\x1b[0m";
	return out;
}

export class App {
	turn: Turn | undefined;
	#running = true;
	columns: number;
	rows: number;

	private constructor(
		readonly term: MemoryTerminal,
		readonly engine: KittyTerminal,
		readonly clock: Signal<number>,
		readonly mode: InteractiveMode,
		readonly session: AgentSession,
		readonly authStorage: AuthStorage,
		readonly model: ScriptedModel,
		readonly gates: ToolGates,
		readonly eventBus: EventBus,
		size: { columns: number; rows: number },
	) {
		this.columns = size.columns;
		this.rows = size.rows;
	}

	static async create(options: AppOptions): Promise<App> {
		setPinnedNow(PINNED_NOW);
		reseedRandom();
		resetAppRoot();
		resetSettingsForTest();
		const colorFgBg = options.theme === "light" ? "0;15" : "15;0";
		process.env.COLORFGBG = colorFgBg;
		initTheme();

		const settings = await Settings.init({
			inMemory: true,
			cwd: APP_PROJECT,
			agentDir: path.join(APP_HOME, ".omp", "agent"),
			overrides: { ...BASE_SETTINGS, ...options.settings },
		});
		const authStorage = await AuthStorage.create(path.join(APP_ROOT, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "corpus-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(APP_HOME, ".omp", "agent", "models.yml"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 missing from the registry");

		const gates = new ToolGates();
		// Late-bound to the session below, as the SDK wires its tool session.
		const late: { session?: AgentSession } = {};
		const toolSession: ToolSession = {
			cwd: APP_PROJECT,
			hasUI: true,
			getSessionFile: () => late.session?.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => late.session?.getTodoPhases() ?? [],
			setTodoPhases: phases => late.session?.setTodoPhases(phases),
			commitTodoPhases: phases => late.session?.commitTodoPhases(phases),
		};
		const tools = (await createTools(toolSession, TOOLS)).map(tool => gateTool(tool, gates));
		const scripted = new ScriptedModel();
		const agent = new Agent({
			getApiKey: () => "corpus-key",
			initialState: { model, systemPrompt: ["Corpus"], tools, messages: [] },
			convertToLlm,
			streamFn: scripted.streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(APP_PROJECT, path.join(APP_HOME, ".omp", "agent", "sessions")),
			settings,
			modelRegistry,
			toolRegistry: toolSession.toolRegistry,
			builtInToolNames: tools.map(tool => tool.name),
		});
		late.session = session;

		// The terminal clock follows the pinned wall clock, moved by the scenario's clock steps.
		const clock = signal(Date.now());
		const engine = KittyTerminal.createSync({
			columns: options.cols,
			rows: options.rows,
			scrollback: SCROLLBACK_LINES,
			wasm: kittyModule,
			onEvent: () => {},
		});
		const term = memoryTerminal({
			columns: options.cols,
			rows: options.rows,
			env: { ...process.env, COLORFGBG: colorFgBg },
			onWrite: data => engine.write(data),
		});
		const frame = new AppFrame({
			version: APP_VERSION,
			shape: cfgComposerShape.get(settings),
			quiet: cfgStartupQuiet.get(settings),
			vim: cfgTuiVimMode.get(settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
			hardwareCursor: cfgShowHardwareCursor.get(settings),
			terminal: { driver: term.options, native: false, clock },
		});
		session.subscribe(event => {
			if (event.type === "tool_execution_start") gates.executions++;
			else if (event.type === "tool_execution_end") gates.executions--;
		});
		const eventBus = new EventBus();
		const mode = new InteractiveMode(session, APP_VERSION, () => {}, undefined, undefined, eventBus, frame);
		const app = new App(term, engine, clock, mode, session, authStorage, scripted, gates, eventBus, {
			columns: options.cols,
			rows: options.rows,
		});
		await mode.init({ suppressWelcomeIntro: options.welcomeIntro !== true, clearInitialTerminalHistory: true });
		await mode.renderInitialMessages({ preserveExistingChat: true });
		mode.settleStartupRun();
		void app.#inputLoop();
		await app.settle();
		return app;
	}

	async #inputLoop(): Promise<void> {
		while (this.#running) {
			const input = await this.mode.getUserInput();
			if (!this.#running) return;
			await submitInteractiveInput(this.mode, this.session, input);
		}
	}

	/**
	 * Whether the agent is working on its own: a run is in progress, yet no model request waits on
	 * the script and no tool waits at its gate (an interrupt unwinding, a released tool running, the
	 * run finishing, the next request on its way). The grid can hold still for a while meanwhile on
	 * a loaded machine, so this is awaited rather than wall time.
	 */
	get working(): boolean {
		if (this.gates.busy) return true;
		if (!this.session.isStreaming) return false;
		const last = this.model.turns.at(-1);
		const awaitingScript = (last !== undefined && !last.ended) || this.gates.held > 0;
		return !awaitingScript;
	}

	/**
	 * Returns once the agent is not {@link working}, no short app timer is pending and the grid has
	 * not changed for {@link STABLE_MS} of real time.
	 */
	async settle(): Promise<void> {
		let previous = "";
		let stableSince = realNow();
		for (let round = 0; round < SETTLE_ROUNDS; round++) {
			await Bun.sleep(round === 0 ? 0 : 10);
			const key = JSON.stringify(this.snapshot());
			const now = realNow();
			if (key !== previous || this.working || shortTimers.size > 0) {
				previous = key;
				stableSince = now;
			} else if (now - stableSince >= STABLE_MS) {
				return;
			}
		}
		const reason = this.working
			? "the agent is still working"
			: shortTimers.size > 0
				? `${shortTimers.size} short timers stay pending`
				: "the screen keeps changing";
		throw new Error(`the app did not settle (${reason})`);
	}

	/** Advance the pinned wall clock (the terminal renderer's clock follows it). */
	advance(ms: number): void {
		setPinnedNow(Date.now() + ms);
		this.clock.set(Date.now());
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.engine.resize(columns, rows);
		this.term.resize(columns, rows);
	}

	snapshot(): GridSnapshot {
		const viewport: string[] = [];
		for (let y = 0; y < this.rows; y++) viewport.push(rowToAnsi(this.engine.lineCells(y)));
		const scrollback: string[] = [];
		for (let i = 0; i < this.engine.scrollbackLength; i++)
			scrollback.push(rowToAnsi(this.engine.scrollbackLineCells(i)));
		const cursor = this.engine.cursor;
		return {
			viewport,
			scrollback,
			cursor: { row: cursor.y, col: cursor.x, visible: cursor.visible },
			alt: !this.engine.isMainScreen,
		};
	}

	async nextTurn(): Promise<Turn> {
		this.turn = await this.model.next();
		return this.turn;
	}

	async dispose(): Promise<void> {
		this.#running = false;
		if (this.mode.onInputCallback) this.mode.onInputCallback({ text: "", cancelled: true, started: false });
		this.session.agent.abort();
		this.mode.stop();
		await this.mode.shell.stop();
		// Disposal waits on background work a scripted session never finishes.
		await Promise.race([this.session.dispose(), Bun.sleep(500)]);
		this.authStorage.close();
		this.engine.dispose();
	}
}
