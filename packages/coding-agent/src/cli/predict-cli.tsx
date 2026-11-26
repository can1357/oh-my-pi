/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `omp predict`: type a prompt and watch every word-completion engine's ghost
 * text side by side.
 *
 * Each lane runs the composer's {@link WordCompletionProvider} (prose gates,
 * single-letter queries, projection) against the shared text-prediction
 * daemon, so what a lane shows is what the composer would show with that
 * `spelling.autocomplete` setting. Comparison typing never teaches the
 * engines: lanes send no feedback and nothing is synced into history.
 *
 * The page: a head (title, engine count, activity, close), the prompt field
 * showing the first lane's ghost, a table with one row per engine (its ghost
 * after the typed text, confidence and latency), and the action bar (Tab
 * accepts the first lane's word, Enter clears, Esc quits).
 */
import {
	type Accessor,
	batch,
	type JSXNode,
	type KeyEvent,
	nativeSupports,
	signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { closeDaemonClient } from "../daemon/client";
import {
	type WordCompletionEngine,
	WordCompletionProvider,
	type WordPredictionBackend,
} from "../modes/view-model/prompt/word-completion";
import { closeTextPrediction, requestTextPrediction } from "../predict/client";
import type { TextPredictMethod } from "../predict/protocol";
import { runStandalone } from "../ui/apps/fullscreen";
import { applyEdit, IconButton, type LineValue } from "../ui/overlays/panels/common";
import { formatKeyHint, formatTooltipKey } from "../ui/keys/hints";
import { replaceTabs } from "../utils/text-width";

/** Settings compared on this platform, in display order (`apple` needs macOS). */
const ENGINES: readonly WordCompletionEngine[] =
	process.platform === "darwin" ? ["auto", "ngram", "smollm", "apple"] : ["auto", "ngram", "smollm"];

/** The latest daemon answer a lane received. */
interface Answer {
	readonly ms: number;
	/** Engine that answered (what `auto` resolved to). */
	readonly engine?: TextPredictMethod;
	readonly confidence?: number;
	readonly error?: string;
}

/** One setting's row: its provider and the stats of its latest answer. */
class Lane {
	readonly setting: WordCompletionEngine;
	readonly provider: WordCompletionProvider;
	readonly answer = signal<Answer | undefined>(undefined);
	readonly pending = signal(0);

	constructor(setting: WordCompletionEngine) {
		this.setting = setting;
		const backend: WordPredictionBackend = {
			complete: async (before, prefix) => {
				// Requests start while the page reads the ghost text: count them after that read.
				await Promise.resolve();
				const started = performance.now();
				this.pending.update(n => n + 1);
				try {
					const { engine, suggestion } = await requestTextPrediction(setting, before, prefix);
					this.answer.set({ ms: performance.now() - started, engine, confidence: suggestion?.confidence });
					return suggestion?.suffix ?? null;
				} catch (error) {
					this.answer.set({
						ms: performance.now() - started,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				} finally {
					this.pending.update(n => n - 1);
				}
			},
			// Comparison typing must not teach the engines.
			feedback() {},
		};
		this.provider = new WordCompletionProvider(() => backend);
		this.provider.setMethod(setting);
	}

	/** The ghost text after `text` (reactive: re-read when an answer arrives). */
	ghost(text: string): string {
		this.provider.revision();
		return this.provider.getWordCompletion([text], 0, text.length) ?? "";
	}

	/** Setting name, plus the engine that answered when it differs (`auto → ngram`). */
	label(): string {
		const engine = this.answer()?.engine;
		return engine && engine !== this.setting ? `${this.setting} → ${engine}` : this.setting;
	}

	/** Loading, the error, or confidence and latency of the latest answer. */
	stats(): TspSpan[] {
		const pending = this.pending() > 0;
		const answer = this.answer();
		if (!answer) return pending ? [{ s: "dim", t: "loading…" }] : [];
		if (answer.error) return [{ s: "error", t: answer.error }];
		const ms = answer.ms < 10 ? answer.ms.toFixed(1) : Math.round(answer.ms).toString();
		const confidence = answer.confidence === undefined ? "—" : answer.confidence.toFixed(2);
		return [{ s: "dim", t: `p ${confidence} · ${ms} ms${pending ? " …" : ""}` }];
	}
}

/** State of the comparison page. */
class PredictCompare {
	readonly line = signal<LineValue>({ text: "", cursor: 0 });
	readonly lanes = ENGINES.map(engine => new Lane(engine));
	readonly #done = Promise.withResolvers<void>();
	readonly done = this.#done.promise;

	/** The first lane's ghost: what Tab accepts. */
	readonly firstGhost: Accessor<string> = () => this.lanes[0]?.ghost(this.line().text) ?? "";

	readonly pending: Accessor<boolean> = () => this.lanes.some(lane => lane.pending() > 0);

	quit(): void {
		this.#done.resolve();
	}

	/** Accept the first lane's ghost word. */
	accept(): void {
		const ghost = this.firstGhost();
		if (!ghost) return;
		const text = `${this.line.peek().text}${ghost} `;
		this.line.set({ text, cursor: text.length });
	}

	clear(): void {
		this.line.set({ text: "", cursor: 0 });
	}

	key(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		switch (key.id) {
			case "ctrl+c":
			case "escape":
				this.quit();
				return true;
			case "tab":
				this.accept();
				return true;
			case "enter":
				this.clear();
				return true;
		}
		return false;
	}

	action(act: string): void {
		if (act === "accept") this.accept();
		else if (act === "clear") this.clear();
		else if (act === "quit") this.quit();
	}
}

function ActionButton(props: {
	act: string;
	label: string;
	keys: string;
	tone?: "accent";
	native: Accessor<boolean>;
}): JSXNode {
	return () =>
		nativeSupports("button") ? (
			<button
				key={props.act}
				role="omp.btn"
				text={props.label}
				actions={{ click: props.act }}
				title={`${props.label}  ${formatTooltipKey(props.keys)}`}
				keys={[props.keys]}
				variant={props.tone === "accent" ? "primary" : undefined}
				tone={props.tone}
			/>
		) : (
			<row key={props.act} role="omp.btn" align="center" gap="xs" actions={{ click: props.act }} title={props.label}>
				<text spans={[props.tone ? { s: props.tone, t: props.label } : { t: props.label }]} />
				{() =>
					props.native() ? (
						<kbd keys={[props.keys]} />
					) : (
						<text spans={[{ s: "dim", t: formatKeyHint(props.keys) }]} />
					)
				}
			</row>
		);
}

function PredictPage(props: {
	readonly page: PredictCompare;
	readonly native: Accessor<boolean>;
	readonly inputRef: (node: UiNode) => void;
}): JSXNode {
	const page = props.page;
	const native = props.native;
	const head = (
		<row key="head" role="omp.app.head" justify="between" align="center">
			<row role="omp.app.where" gap="sm" align="center">
				<text text="omp predict" role="omp.app.title" />
				<text
					spans={[{ s: "muted", t: `${page.lanes.length} engines · comparison typing never teaches them` }]}
					truncate="end"
				/>
			</row>
			<row role="omp.app.tools" gap="md" align="center">
				{() =>
					page.pending() && (
						<row key="fresh" role="omp.app.fresh" gap="xs" align="center">
							<spinner style="dots" />
							<text spans={[{ s: "dim", t: "predicting" }]} />
						</row>
					)
				}
				<IconButton nodeKey="quit" name="x" act="quit" title="Quit  esc" aria="Quit" />
			</row>
		</row>
	);
	const rows = (): { id: string; cells: Record<string, TspSpan[]> }[] => {
		const text = page.line().text;
		const typed = replaceTabs(text);
		return page.lanes.map(lane => {
			const ghost = lane.ghost(text);
			const completion: TspSpan[] = [];
			if (typed !== "") completion.push({ s: "muted", t: typed });
			if (ghost !== "") completion.push({ s: "strong", t: ghost });
			return {
				id: lane.setting,
				cells: { engine: [{ s: "accent", t: lane.label() }], completion, stats: lane.stats() },
			};
		});
	};
	return (
		<col role="omp.app.predict" gap="md" grow={1} onKey={key => page.key(key)} onAction={act => page.action(act)}>
			{head}
			<input
				key="input"
				ref={props.inputRef}
				prompt="> "
				placeholder="Type to compare engines"
				sendable={false}
				text={() => page.line().text}
				cursor={() => page.line().cursor}
				ghost={() => page.firstGhost() || undefined}
				onEdit={edit => {
					const next = applyEdit(page.line.peek(), edit);
					if (next) batch(() => page.line.set(next));
				}}
			/>
			<table
				key="lanes"
				cols={[
					{ id: "engine", head: "Engine", truncate: "end" },
					{ id: "completion", head: "Completion", truncate: "start", grow: 1 },
					{ id: "stats", head: "Confidence · latency", align: "end", priority: 1 },
				]}
				rows={rows}
			/>
			<row key="actions" role="omp.actions" gap="sm" align="center">
				<ActionButton act="accept" label={`Accept ${ENGINES[0]}`} keys="tab" tone="accent" native={native} />
				<ActionButton act="clear" label="Clear" keys="enter" native={native} />
				<spacer grow={1} />
				<ActionButton act="quit" label="Quit" keys="escape" native={native} />
			</row>
		</col>
	);
}

/** Run the fullscreen engine comparison until the user quits. */
export async function runPredictCompare(): Promise<void> {
	try {
		await runStandalone({ title: "omp predict" }, screen => {
			const page = new PredictCompare();
			let input: UiNode | undefined;
			return {
				view: () => <PredictPage page={page} native={screen.shell.native} inputRef={node => (input = node)} />,
				focus: root => input ?? root,
				done: page.done,
			};
		});
	} finally {
		// The daemon socket and the global broker lease would keep the process alive.
		closeTextPrediction();
		await closeDaemonClient();
	}
}
