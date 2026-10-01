/**
 * `omp predict`: type a prompt and watch every word-completion engine's ghost
 * text side by side.
 *
 * Each lane runs the composer's own {@link WordCompletionProvider} (prose
 * gates, single-letter queries, projection) against the shared text-prediction
 * daemon, so what a lane shows is what the composer would show with that
 * `spelling.autocomplete` setting. Comparison typing never teaches the
 * engines: lanes send no feedback and nothing is synced into history.
 */
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	ProcessTerminal,
	replaceTabs,
	truncateToWidth,
	TUI,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { col, compact, keyed, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { Memo } from "@oh-my-pi/pi-tui/native/memo";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import {
	type WordCompletionEngine,
	WordCompletionProvider,
	type WordPredictionBackend,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { closeDaemonClients } from "../launch/client";
import type { TextPredictMethod } from "../predict/protocol";
import { closeTextPrediction, requestTextPrediction } from "../predict/client";

/** Settings compared on this platform, in display order (`apple` needs macOS). */
const ENGINES: readonly WordCompletionEngine[] =
	process.platform === "darwin" ? ["auto", "ngram", "smollm", "apple"] : ["auto", "ngram", "smollm"];
const LABEL_WIDTH = 14;
const STATS_WIDTH = 24;

/** The latest daemon answer a lane received. */
interface Answer {
	ms: number;
	/** Engine that answered (what `auto` resolved to). */
	engine?: TextPredictMethod;
	confidence?: number;
	error?: string;
}

/** One setting's row: its provider and the stats of its latest answer. */
class Lane {
	readonly #setting: WordCompletionEngine;
	readonly provider: WordCompletionProvider;
	answer: Answer | undefined;
	pending = 0;

	constructor(setting: WordCompletionEngine, repaint: () => void) {
		this.#setting = setting;
		const backend: WordPredictionBackend = {
			complete: async (before, prefix) => {
				const started = performance.now();
				this.pending++;
				repaint();
				try {
					const { engine, suggestion } = await requestTextPrediction(setting, before, prefix);
					this.answer = { ms: performance.now() - started, engine, confidence: suggestion?.confidence };
					return suggestion?.suffix ?? null;
				} catch (error) {
					this.answer = {
						ms: performance.now() - started,
						error: error instanceof Error ? error.message : String(error),
					};
					return null;
				} finally {
					this.pending--;
					repaint();
				}
			},
			// Comparison typing must not teach the engines.
			feedback() {},
		};
		this.provider = new WordCompletionProvider(() => backend);
		this.provider.setMethod(setting);
		this.provider.onUpdate = repaint;
	}

	/** Setting name, plus the engine that answered when it differs (`auto → ngram`). */
	get label(): string {
		const engine = this.answer?.engine;
		return engine && engine !== this.#setting ? `${this.#setting} → ${engine}` : this.#setting;
	}

	stats(): string {
		const summary = this.#summary();
		if (!summary) return "";
		return summary.error ? chalk.red(summary.text) : chalk.dim(summary.text);
	}

	/** {@link stats} as spans for the native table cell. */
	statsSpans(): TspSpan[] {
		const summary = this.#summary();
		if (!summary) return [];
		return [span(summary.text, summary.error ? "error" : "dim")];
	}

	/** Loading, the error, or confidence and latency of the latest answer. */
	#summary(): { text: string; error: boolean } | undefined {
		if (this.pending > 0 && !this.answer) return { text: "loading…", error: false };
		const answer = this.answer;
		if (!answer) return undefined;
		if (answer.error) return { text: answer.error, error: true };
		const ms = answer.ms < 10 ? answer.ms.toFixed(1) : Math.round(answer.ms).toString();
		const confidence = answer.confidence === undefined ? "—" : answer.confidence.toFixed(2);
		return { text: `p ${confidence} · ${ms} ms${this.pending > 0 ? " …" : ""}`, error: false };
	}
}

/** Keep the end of `text` (where the cursor and ghost are) within `width` cells. */
function tail(text: string, width: number): string {
	if (width <= 1) return "";
	if (Bun.stringWidth(text) <= width) return text;
	let start = 0;
	while (start < text.length && Bun.stringWidth(text.slice(start)) > width - 1) start++;
	return `…${text.slice(start)}`;
}

class PredictCompareComponent implements Component, Focusable {
	readonly #ui: TUI;
	readonly #input = new Input();
	readonly #lanes: Lane[];
	readonly #done = Promise.withResolvers<void>();
	readonly #native = new Memo();
	#focused = false;

	constructor(ui: TUI) {
		this.#ui = ui;
		this.#input.prompt = "> ";
		this.#input.onSubmit = () => this.#input.setValue("");
		const repaint = (): void => ui.requestRender();
		this.#lanes = ENGINES.map(engine => new Lane(engine, repaint));
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		this.#input.focused = focused;
	}

	get debugChildren(): readonly Component[] {
		return [this.#input];
	}

	run(): Promise<void> {
		return this.#done.promise;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#done.resolve();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#accept();
		} else {
			this.#input.handleInput(data);
		}
		this.#ui.requestRender();
	}

	/** Accept the first lane's ghost word (Tab). */
	#accept(): void {
		const value = this.#input.getValue();
		const ghost = this.#lanes[0]?.provider.getWordCompletion([value], 0, value.length);
		if (ghost) this.#input.setValue(`${value}${ghost} `);
	}

	/**
	 * Pointer paths: the action bar accepts (Tab), clears (Enter) or quits
	 * (Esc) through the key code; terminal-side edits on the field apply to
	 * the input.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "edit") {
			this.#input.applyHostEdit(event);
			return;
		}
		if (event.type !== "action") return;
		switch (event.act) {
			case "accept":
				this.#accept();
				break;
			case "clear":
				this.#input.submit();
				break;
			case "quit":
				this.#done.resolve();
				return;
			default:
				return;
		}
		this.#ui.requestRender();
	}

	/**
	 * The comparison as a native page: a head (title, engine count, activity,
	 * close), the prompt field showing the first lane's ghost, a table with
	 * one row per engine (its ghost after the typed text, confidence and
	 * latency), and an action bar mirroring the keys.
	 */
	describe(): NativeNode {
		const value = this.#input.getValue();
		const cursor = this.#input.getCursor();
		const ghosts = this.#lanes.map(lane => lane.provider.getWordCompletion([value], 0, value.length) ?? "");
		return this.#native.get(
			[value, cursor, ...ghosts, ...this.#lanes.flatMap(lane => [lane.answer, lane.pending])],
			() =>
				col(
					[
						this.#describeHead(),
						keyed(
							node("input", {
								text: value,
								cursor,
								prompt: this.#input.prompt,
								placeholder: "Type to compare engines",
								ghost: ghosts[0] || undefined,
							}),
							"input",
						),
						this.#describeLanes(value, ghosts),
						actionBar([
							actionButton(`Accept ${ENGINES[0]}`, "accept", { keys: "tab", tone: "accent" }),
							actionButton("Clear", "clear", { keys: "enter" }),
							null,
							actionButton("Quit", "quit", { keys: "escape" }),
						]),
					],
					{ role: "omp.app.predict", gap: "md", grow: 1 },
				),
		);
	}

	#describeHead(): NativeNode {
		const pending = this.#lanes.some(lane => lane.pending > 0);
		return keyed(
			row(
				[
					row(
						[
							text("omp predict", { role: "omp.app.title" }),
							text([span(`${this.#lanes.length} engines · comparison typing never teaches them`, "muted")], {
								truncate: "end",
							}),
						],
						{ gap: "sm", align: "center", role: "omp.app.where" },
					),
					row(
						compact([
							pending &&
								row([node("spinner", { style: "dots" }), text([span("predicting", "dim")])], {
									gap: "xs",
									align: "center",
									role: "omp.app.fresh",
								}),
							node("icon", {
								name: "x",
								role: "omp.app.ibtn",
								title: "Quit  esc",
								aria: "Quit",
								actions: { click: "quit" },
							}),
						]),
						{ gap: "md", align: "center", role: "omp.app.tools" },
					),
				],
				{ justify: "between", align: "center", role: "omp.app.head" },
			),
			"head",
		);
	}

	/** One table row per engine: setting (and what `auto` resolved to), typed text plus ghost, stats. */
	#describeLanes(value: string, ghosts: readonly string[]): NativeNode {
		const typed = replaceTabs(value);
		return keyed(
			node("table", {
				cols: [
					{ id: "engine", head: "Engine", truncate: "end" },
					{ id: "completion", head: "Completion", truncate: "start", grow: 1 },
					{ id: "stats", head: "Confidence · latency", align: "end", priority: 1 },
				],
				rows: this.#lanes.map((lane, index) => {
					const ghost = ghosts[index] ?? "";
					return {
						id: ENGINES[index] ?? lane.label,
						cells: {
							engine: [span(lane.label, "accent")],
							completion: compact([typed !== "" && span(typed, "muted"), ghost !== "" && span(ghost, "strong")]),
							stats: lane.statsSpans(),
						},
					};
				}),
			}),
			"lanes",
		);
	}

	render(width: number): readonly string[] {
		const value = this.#input.getValue();
		const header = `${chalk.bold("omp predict")} ${chalk.dim(
			`· type to compare engines · ${formatKeyHint("tab")} accepts ${ENGINES[0]} · ${formatKeyHint("enter")} clears · ${formatKeyHint("escape")} quits`,
		)}`;
		const textWidth = Math.max(8, width - LABEL_WIDTH - STATS_WIDTH - 2);
		const rows = this.#lanes.map(lane => {
			const ghost = lane.provider.getWordCompletion([value], 0, value.length) ?? "";
			const typed = tail(replaceTabs(value), Math.max(1, textWidth - Bun.stringWidth(ghost)));
			const text = `${typed}${chalk.dim.underline(ghost)}`;
			const pad = " ".repeat(Math.max(1, textWidth - Bun.stringWidth(typed) - Bun.stringWidth(ghost) + 1));
			return truncateToWidth(`${chalk.cyan(lane.label.padEnd(LABEL_WIDTH))}${text}${pad}${lane.stats()}`, width);
		});
		return [
			truncateToWidth(header, width),
			"",
			...this.#input.render(width).map(line => truncateToWidth(line, width)),
			"",
			...rows,
		];
	}
}

/** Run the fullscreen engine comparison until the user quits. */
export async function runPredictCompare(): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new PredictCompareComponent(ui);
	const overlay = ui.showOverlay(component, {
		fullscreen: true,
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		overlay.hide();
		ui.stop();
		// The daemon socket and the global broker lease would keep the process alive.
		closeTextPrediction();
		await closeDaemonClients();
	}
}
