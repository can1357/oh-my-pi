/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Theme: curated looks (follow the terminal, the default dark and light
 * themes, colorblind colors, ANSI-safe), or every installed theme. Moving the
 * highlight previews the look across the UI; Enter saves it; Escape restores
 * the original look and skips (from the full list it goes back to the
 * curated choices).
 */
import { batch, computed, For, type JSXNode, type KeyEvent, Show, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { fuzzyFilter } from "../../../utils/fuzzy";
import "../../styles/setup";
import { fittedListMax } from "../../styles/setup/scenes";
import type { SceneContext, SetupScene, ThemeLook } from "../types";
import { keyLabel, listPointer } from "./choice";
import { listKeyId } from "../../../config/keybindings/matchers";
import { actionKeyId } from "../../keys/hints";

interface ThemeItem {
	readonly value: string;
	readonly label: string;
	readonly detail?: string;
}

const CURATED: readonly ThemeItem[] = [
	{ value: "auto", label: "Match terminal", detail: "Titanium in dark terminals, Light in light terminals" },
	{ value: "theme:titanium", label: "Titanium", detail: "Default dark theme" },
	{ value: "theme:light", label: "Light", detail: "Default light theme" },
	{ value: "colorblind", label: "Colorblind colors", detail: "Adjust red/green contrast" },
	{ value: "ansi", label: "ANSI-safe", detail: "ASCII glyphs with the dark terminal theme" },
	{ value: "browse", label: "Browse all…", detail: "Show every built-in and custom theme" },
];

/** Rows of the full theme list before it scrolls (and type-to-search turns on). */
const LIST_ROWS = 10;

/** Rows of the preview block (title, samples, status line, editor box). */
const PREVIEW_ROWS = 9;

/** Fewest list rows worth keeping the preview for. */
const MIN_LIST_ROWS = 5;

/** Columns the native list window is fitted at. */
const NATIVE_COLS = 80;

const PREVIEW_PROMPT = "Ask anything, edit files, run tools";

/** The UI look a list value stands for (the host's configured glyphs and colors unless the value changes them). */
function lookOf(value: string, context: SceneContext): ThemeLook | undefined {
	const host = context.host;
	const base = { symbols: host.symbolPreset, colorBlind: host.colorBlindMode };
	if (value === "auto") return { theme: "auto", ...base };
	if (value === "colorblind") return { theme: host.themeName, ...base, colorBlind: true };
	if (value === "ansi") return { theme: "dark-terminal", ...base, symbols: "ascii" };
	if (value.startsWith("theme:")) return { theme: value.slice("theme:".length), ...base };
	return undefined;
}

class ThemeSceneModel {
	readonly mode = signal<"curated" | "all">("curated");
	readonly loading = signal(false);
	readonly message = signal<string | undefined>(undefined);
	readonly allThemes = signal<readonly ThemeItem[]>([]);
	readonly query = signal("");
	readonly selected: Signal<string>;
	readonly items = computed((): readonly ThemeItem[] => {
		if (this.mode() === "curated") return CURATED;
		const query = this.query().trim();
		const all = this.allThemes();
		return query ? fuzzyFilter([...all], query, item => `${item.label} ${item.detail ?? ""}`) : all;
	});
	#finished = false;
	readonly #context: SceneContext;

	constructor(context: SceneContext) {
		this.#context = context;
		this.selected = signal(this.#curatedFor(context.host.themeName));
	}

	#curatedFor(theme: string): string {
		if (theme === "titanium") return "theme:titanium";
		if (theme === "light") return "theme:light";
		return "auto";
	}

	get searchable(): boolean {
		return this.mode() === "all" && this.allThemes().length > LIST_ROWS;
	}

	/**
	 * List rows within the body budget (at {@link NATIVE_COLS}): all of them
	 * beside the preview when everything fits, else what the intro leaves.
	 */
	listRows(introRows: number): number {
		const budget = this.#context.maxLines();
		if (budget === undefined) return LIST_ROWS;
		const count = this.items().length;
		const shown = Math.min(count, LIST_ROWS) + (count > LIST_ROWS ? 1 : 0);
		if (introRows + 1 + PREVIEW_ROWS + 1 + shown <= budget) return LIST_ROWS;
		const withPreview = introRows + 1 + PREVIEW_ROWS + 1;
		if (budget - withPreview >= Math.min(count, MIN_LIST_ROWS)) return fittedListMax(count, budget - withPreview);
		// Without the preview the list keeps a row for its search status.
		return Math.max(1, Math.min(LIST_ROWS, budget - introRows - 2));
	}

	highlight(value: string): void {
		if (untrack(this.selected) === value) return;
		batch(() => {
			this.selected.set(value);
			this.message.set(undefined);
		});
		const look = lookOf(value, this.#context);
		if (look) void this.#context.host.previewTheme?.(look);
	}

	move(delta: number): void {
		const items = untrack(this.items);
		if (items.length === 0) return;
		const at = items.findIndex(item => item.value === untrack(this.selected));
		this.highlight(items[(at + delta + items.length) % items.length]!.value);
	}

	setQuery(query: string): void {
		this.query.set(query);
		const items = untrack(this.items);
		if (!items.some(item => item.value === untrack(this.selected)) && items[0]) this.highlight(items[0].value);
	}

	async showAll(): Promise<void> {
		if (untrack(this.loading)) return;
		batch(() => {
			this.loading.set(true);
			this.message.set(undefined);
		});
		try {
			const names = (await this.#context.host.listThemes?.()) ?? [];
			const original = this.#context.host.themeName;
			batch(() => {
				this.allThemes.set(
					names.map(name => ({
						value: `theme:${name}`,
						label: name,
						...(name === original ? { detail: "current" } : {}),
					})),
				);
				this.query.set("");
				this.mode.set("all");
				this.selected.set(`theme:${names.includes(original) ? original : (names[0] ?? "")}`);
			});
		} catch (error) {
			this.message.set(`Failed to load themes: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.loading.set(false);
		}
	}

	async commit(value: string): Promise<void> {
		if (value === "browse") return this.showAll();
		const host = this.#context.host;
		const look = lookOf(value, this.#context);
		if (!look || this.#finished) return;
		this.#finished = true;
		if (value === "auto") {
			host.saveTheme("dark", "titanium");
			host.saveTheme("light", "light");
		} else if (value === "colorblind") host.saveColorBlindMode(true);
		else if (value === "ansi") {
			host.saveSymbolPreset("ascii");
			host.saveTheme("dark", "dark-terminal");
		} else {
			const light = !(await loadTheme(look.theme).then(
				theme => theme.dark,
				() => true,
			));
			host.saveTheme(light ? "light" : "dark", look.theme);
		}
		await host.applyTheme?.(look);
		this.#context.finish("done");
	}

	skip(): void {
		if (this.#finished) return;
		if (untrack(this.mode) === "all") {
			batch(() => {
				this.mode.set("curated");
				this.query.set("");
				this.selected.set(this.#curatedFor(currentTheme().name ?? ""));
			});
			return;
		}
		this.#finished = true;
		void this.#context.host.previewTheme?.(null);
		this.#context.finish("skipped");
	}

	key(key: KeyEvent): boolean {
		if (untrack(this.loading)) return true;
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
				void this.commit(untrack(this.selected));
				return true;
			case "escape":
				this.skip();
				return true;
			case "backspace":
				if (!this.searchable || untrack(this.query) === "") return false;
				this.setQuery([...untrack(this.query)].slice(0, -1).join(""));
				return true;
		}
		if (untrack(this.mode) === "curated") {
			// A digit past the last row picks the last row.
			const item = /^[1-9]$/.test(key.id) ? CURATED[Math.min(Number(key.id), CURATED.length) - 1] : undefined;
			if (!item) return false;
			this.highlight(item.value);
			return true;
		}
		const typed = key.text;
		if (!this.searchable || typed === undefined || typed === "" || /[\x00-\x1f\x7f]/.test(typed)) return false;
		this.setQuery(untrack(this.query) + typed);
		return true;
	}
}

/** The live sample: semantic colors, a status line and an editor in the previewed look. */
function ThemePreview(): JSXNode {
	const symbol = (key: string): string => currentTheme().symbols.symbol(key);
	const samples = (): TspSpan[] => [
		{ s: "success", t: `${symbol("status.success")} success` },
		{ t: "  " },
		{ s: "warning", t: `${symbol("status.warning")} warning` },
		{ t: "  " },
		{ s: "error", t: `${symbol("status.error")} error` },
		{ t: "  " },
		{ s: "accent", t: "accent" },
	];
	return (
		<col role="omp.setup.theme.preview">
			<text spans={[{ s: "strong", t: "Preview" }]} />
			<text spans={samples} />
			<text spans={[{ s: "muted", t: "Status line" }]} />
			<status>
				<seg side="left" spans={() => [{ s: "statusLineModel", t: `${symbol("icon.model")} sonnet` }]} />
				<seg side="left" spans={[{ s: "statusLinePath", t: "~/project" }]} />
				<seg side="left" spans={() => [{ s: "statusLineGitDirty", t: `${symbol("icon.git")} main +2` }]} />
				<seg side="right" spans={() => [{ s: "statusLineContext", t: `${symbol("icon.context")} 42%` }]} />
				<seg side="right" spans={() => [{ s: "statusLineCost", t: `${symbol("icon.cost")} 0.18` }]} />
			</status>
			<text spans={[{ s: "muted", t: "Editor" }]} />
			<input prompt={[{ s: "accent", t: ">" }]} readonly text={PREVIEW_PROMPT} cursor={PREVIEW_PROMPT.length} />
			<text
				spans={() => [
					{ s: "dim", t: `${keyLabel("enter")} send · ${keyLabel("shift+enter")} newline · / commands` },
				]}
			/>
		</col>
	);
}

export const themeScene: SetupScene = {
	id: "theme",
	title: "Pick a theme",
	subtitle: "Move through the list to preview; Enter saves the highlighted choice.",
	step: "Theme",
	minVersion: 1,
	mount(context) {
		const model = new ThemeSceneModel(context);
		const pointer = listPointer();
		const intro = (): string =>
			`Theme changes preview live. Nothing is saved until you press ${keyLabel(actionKeyId("tui.select.confirm", "enter"))}.`;
		const listRows = computed(() => model.listRows(wrap(intro(), NATIVE_COLS).length + 1));
		const hint = (): string =>
			model.mode() === "all"
				? `Browsing all themes · ${keyLabel(actionKeyId("tui.select.cancel", "escape"))} returns to curated choices`
				: `${keyLabel(actionKeyId("tui.select.cancel", "escape"))} skips this step`;
		return {
			body: (
				<col
					role="omp.setup.theme"
					gap="sm"
					term={() => ({ maxLines: context.maxLines() })}
					onKey={key => model.key(key)}
				>
					<col>
						<text spans={() => [{ s: "muted", t: intro() }]} />
						<text spans={() => [{ s: "dim", t: hint() }]} />
					</col>
					<ThemePreview />
					<Show
						when={model.loading}
						fallback={
							<col role="omp.select" term={{ pointer: pointer }}>
								<list
									key="list"
									empty={() => (model.query() ? "No matching items" : "No items")}
									filter={() => model.query() || undefined}
									max={() => ({ lines: listRows() })}
									selected={model.selected}
									onSelect={item => model.highlight(item)}
									onActivate={item => {
										model.highlight(item);
										void model.commit(item);
									}}
								>
									<For each={model.items}>
										{item => (
											<item
												key={item.value}
												label={[{ t: item.label }]}
												detail={item.detail === undefined ? undefined : [{ s: "muted", t: item.detail }]}
											/>
										)}
									</For>
								</list>
								{() =>
									model.searchable || model.items().length > listRows() ? (
										<text
											key="status"
											wrap="none"
											spans={() => [
												{ s: "muted", t: model.query() ? `Search: ${model.query()}` : "Type to search" },
											]}
										/>
									) : null
								}
							</col>
						}
					>
						<spinner key="loading" label={[{ s: "dim", t: "Loading themes…" }]} />
					</Show>
					{() => {
						const message = model.message();
						return message ? <text key="message" spans={[{ s: "error", t: message }]} /> : null;
					}}
				</col>
			),
		};
	},
};
