/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The shape most setup scenes share: a short intro over a numbered list of
 * choices. Up/Down move the highlight (wrapping), a digit jumps to its row,
 * Enter commits the highlighted choice, Escape skips the step. Moving the
 * highlight may preview the choice live.
 */
import { batch, For, type JSXNode, type KeyEvent, signal, untrack } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatKey } from "../../keys/format";
import type { SceneContext } from "../types";
import { listKeyId } from "../../../config/keybindings/matchers";

/** One choice of a list scene. */
export interface Choice<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly detail: string;
}

/**
 * A key spelled out in words (`enter` → `Enter`, `escape` → `Esc`) whatever the
 * glyph preset: setup runs before the user has picked glyphs their font can
 * draw, so keycap glyphs could render as `?` exactly where the user needs them.
 */
export function keyLabel(key: string): string {
	return formatKey(key, { preset: "ascii", platform: process.platform });
}

/** The list pointer of the glyphs in use now (a list keeps the one it was built with). */
export function listPointer(): string {
	return untrack(currentTheme).symbols.symbol("nav.cursor");
}

/** Highlight, quick picks and commit/skip of a list scene. */
export class ChoiceModel<T extends string> {
	readonly choices: readonly Choice<T>[];
	readonly selected;
	/** Set once the scene committed or skipped: later keys do nothing. */
	#finished = false;
	readonly #context: SceneContext;
	readonly #preview?: (value: T) => void;
	readonly #commit: (value: T) => void | Promise<void>;
	readonly #skip?: () => void;

	constructor(options: {
		context: SceneContext;
		choices: readonly Choice<T>[];
		initial: T;
		preview?: (value: T) => void;
		commit: (value: T) => void | Promise<void>;
		skip?: () => void;
	}) {
		this.choices = options.choices;
		this.selected = signal<T>(options.initial);
		this.#context = options.context;
		this.#preview = options.preview;
		this.#commit = options.commit;
		this.#skip = options.skip;
	}

	get finished(): boolean {
		return this.#finished;
	}

	highlight(value: T): void {
		if (this.#finished || untrack(this.selected) === value) return;
		this.selected.set(value);
		this.#preview?.(value);
	}

	/** Move the highlight; arrow keys wrap around, the wheel stops at the ends. */
	move(delta: number, wrap = true): void {
		const count = this.choices.length;
		const at = this.choices.findIndex(choice => choice.value === untrack(this.selected));
		const next = wrap ? (at + delta + count) % count : Math.max(0, Math.min(count - 1, at + delta));
		this.highlight(this.choices[next]!.value);
	}

	async commit(): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		await this.#commit(untrack(this.selected));
		this.#context.finish("done");
	}

	skip(): void {
		if (this.#finished) return;
		this.#finished = true;
		batch(() => this.#skip?.());
		this.#context.finish("skipped");
	}

	key(key: KeyEvent): boolean {
		// Ctrl+C is the wizard's exit, never a scene's skip.
		if (key.id === "ctrl+c") return false;
		switch (listKeyId(key)) {
			case "up":
				this.move(-1);
				return true;
			case "down":
				this.move(1);
				return true;
			case "enter":
				void this.commit();
				return true;
			case "escape":
				this.skip();
				return true;
		}
		const digit = /^[1-9]$/.test(key.id) ? Number(key.id) : 0;
		const choice = this.choices[digit - 1];
		if (!choice) return false;
		this.highlight(choice.value);
		return true;
	}
}

/** The choices as an `omp.select` list. */
export function ChoiceList<T extends string>(props: { readonly model: ChoiceModel<T> }): JSXNode {
	const model = props.model;
	return (
		<col role="omp.select" term={{ pointer: listPointer() }}>
			<list
				key="list"
				empty="No items"
				max={{ lines: model.choices.length }}
				selected={model.selected}
				onSelect={item => model.highlight(item as T)}
				onActivate={item => {
					model.highlight(item as T);
					void model.commit();
				}}
			>
				<For each={() => model.choices}>
					{choice => (
						<item key={choice.value} label={[{ t: choice.label }]} detail={[{ s: "muted", t: choice.detail }]} />
					)}
				</For>
			</list>
		</col>
	);
}
