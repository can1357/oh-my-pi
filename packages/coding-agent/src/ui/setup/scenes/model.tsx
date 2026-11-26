/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Default model: a searchable list of the configured models (a setup sheet
 * natively); Enter saves the highlighted one as the default for new
 * sessions. Mounting starts model discovery; when it fails with nothing to
 * list, Enter retries.
 */
import { batch, computed, type KeyEvent, signal, untrack } from "@oh-my-pi/pi-tui";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { errorMessage } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspText } from "@oh-my-pi/pi-wire";
import {
	buildBrowserItems,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "../../../modes/view-model/overlays/model-browser";
import { modelPreview } from "../../overlays/pickers/model-browser";
import { ModelBrowserState } from "../../overlays/pickers/model-browser-state";
import "../../styles/setup";
import type { ModelSceneTerm } from "../../styles/setup/model";
import type { SetupScene } from "../types";
import { keyLabel } from "./choice";
import { pickerAction } from "../../overlays/pickers/select-sheet";
import { actionKeyId, cancelKbd, confirmKbd } from "../../keys/hints";

/** Rows of the browser around its list: search, blank, blank, two detail rows. */
const BROWSER_CHROME_ROWS = 5;
/** List rows with no body budget. */
const LIST_ROWS = 10;

type Discovery =
	| { readonly kind: "idle" }
	| { readonly kind: "running" }
	| { readonly kind: "failed"; readonly message: string };

export const modelScene: SetupScene = {
	id: "model",
	title: "Choose your default model",
	subtitle: "Search configured models and save the model used for new sessions.",
	step: "Model",
	minVersion: 1,
	mount(context) {
		const host = context.host;
		const browser = new ModelBrowserState(host.modelSource);
		const items = signal<readonly ModelBrowserItem[]>([]);
		const discovery = signal<Discovery>({ kind: "idle" });
		const saving = signal<string | undefined>(undefined);
		const saveError = signal<string | undefined>(undefined);
		let finished = false;
		const current = (): string | undefined => {
			const model = host.getModels().current;
			return model ? `${model.provider}/${model.id}` : undefined;
		};

		const load = (): void => {
			const { available, all } = host.getModels();
			const source = host.modelSource;
			// Role chips resolve over every model; the rows are the chat models.
			const roles = resolveRoleAssignments(source, all, available);
			const next = buildBrowserItems(available.filter(model => modelKind(model) === "chat"));
			sortModelItems(next, { roles, mruOrder: source.mruOrder });
			batch(() => {
				items.set(next);
				browser.setRoles(roles);
				browser.setMruOrder(source.mruOrder);
				browser.setPerfStats(source.modelPerf);
				browser.setItems(next);
				browser.setCurrentSelector(current());
				const selector = current();
				if (selector) browser.selectSelector(selector);
			});
		};
		load();
		browser.setMaxVisible(
			untrack(() => {
				const budget = context.maxLines();
				return budget === undefined ? LIST_ROWS : Math.max(1, budget - 2 - BROWSER_CHROME_ROWS);
			}),
		);

		const discover = async (): Promise<void> => {
			if (untrack(discovery).kind === "running") return;
			discovery.set({ kind: "running" });
			try {
				await host.refreshModels();
				batch(() => {
					load();
					discovery.set({ kind: "idle" });
				});
			} catch (error) {
				discovery.set({ kind: "failed", message: errorMessage(error) });
			}
		};
		const save = async (): Promise<void> => {
			const item = browser.selected();
			if (!item || untrack(saving) !== undefined || finished) return;
			batch(() => {
				saving.set(item.selector);
				saveError.set(undefined);
			});
			try {
				await host.selectModel(item.model, item.selector);
				finished = true;
				context.finish("done");
			} catch (error) {
				batch(() => {
					saving.set(undefined);
					saveError.set(errorMessage(error));
				});
			}
		};
		const skip = (): void => {
			if (finished) return;
			finished = true;
			context.finish("skipped");
		};
		browser.onActivate = () => void save();
		browser.onCancel = skip;

		/** Nothing listed for an empty query: the sheet shows discovery's state instead of a list. */
		const pickerState = computed((): "ready" | "loading" | "error" => {
			if (items().length > 0) return "ready";
			const state = discovery();
			if (browser.query !== "") return "ready";
			return state.kind === "running" ? "loading" : state.kind === "failed" ? "error" : "ready";
		});
		/** Discovery failed with nothing listed: Enter retries it. */
		const retrying = (): boolean => items().length === 0 && discovery().kind === "failed";
		const head = (): string => {
			const target = saving();
			if (target !== undefined) return `Saving ${target} as the default model…`;
			const state = discovery();
			if (state.kind === "running") return "Discovering available models…";
			if (state.kind === "failed") return state.message;
			return (
				saveError() ??
				`Type to search. ${keyLabel(actionKeyId("tui.select.confirm", "enter"))} saves the highlighted model as your default.`
			);
		};
		const actions = (): TspPickerAction[] => {
			const skipAction = pickerAction("skip", "Skip", cancelKbd(), { end: true });
			if (retrying()) return [skipAction, pickerAction("retry", "Retry", confirmKbd(), { primary: true })];
			const save = pickerAction("save", "Set as default", confirmKbd(), { primary: true });
			if (saving() !== undefined)
				return [skipAction, { ...save, label: "Saving…", disabled: "Saving the default model" }];
			return [skipAction, browser.selected() ? save : { ...save, disabled: "No model highlighted" }];
		};
		// Provider groups while browsing; one ranked "Matches" block while searching.
		const rows = computed(() => {
			const filtering = browser.query.trim().length > 0;
			return browser.pickerRows(
				browser.pickerItems(items()),
				{ providers: !filtering, rest: filtering ? "Matches" : "All models" },
				current(),
			);
		});
		const onKey = (key: KeyEvent): boolean => {
			if (key.id === "enter" && untrack(retrying)) {
				void discover();
				return true;
			}
			return browser.handleKey(key);
		};
		const failed = (): boolean =>
			saving() === undefined &&
			(discovery().kind === "failed" || (discovery().kind === "idle" && saveError() !== undefined));
		const term = (): ModelSceneTerm => ({
			role: "omp.setup.model",
			head: head(),
			error: failed(),
			maxLines: context.maxLines(),
		});
		const subtitle = (): TspText => {
			const target = saving();
			if (target !== undefined)
				return [{ t: "Saving " }, { s: "mono", t: target }, { t: " as your default model…" }];
			const error = saveError();
			if (error !== undefined) return [{ s: "error", t: `Couldn't save the default model: ${error}` }];
			const state = discovery();
			if (items().length > 0 && state.kind === "running") return "Looking for more models…";
			if (items().length > 0 && state.kind === "failed") return [{ s: "error", t: state.message }];
			return "Used by new sessions. Change it with /model.";
		};
		return {
			body: (
				<col term={term}>
					<picker
						key="picker"
						role="omp.setup.sheet"
						title="Choose your default model"
						subtitle={subtitle}
						icon="cpu"
						noun="models"
						size="lg"
						layout="rows"
						preview="side"
						placeholder="Search models…"
						empty="No models yet. Skip this step and run /login to sign in to a provider."
						state={pickerState}
						message={() => {
							const state = discovery();
							return pickerState() === "error" && state.kind === "failed" ? state.message : undefined;
						}}
						actions={actions}
						query={() => rows().query}
						cursor={() => rows().cursor}
						columns={() => rows().columns}
						items={() => rows().items}
						order={() => rows().order}
						hits={() => rows().hits}
						selected={() => rows().selected}
						current={() => rows().current}
						total={() => rows().total}
						term={{ look: "omp.setup.model", browser }}
						onKey={onKey}
						onSelect={item => void browser.selectSelector(item)}
						onActivate={item => {
							if (browser.selectSelector(item)) void save();
						}}
						onAction={act => {
							if (act === "save") void save();
							else if (act === "retry") void discover();
							else if (act === "skip") skip();
							else if (act === "clear") browser.setQuery("");
						}}
					>
						{() => {
							const error = saveError();
							return error === undefined || saving() !== undefined ? null : (
								<text wrap="word" spans={[{ s: "error", t: error }]} />
							);
						}}
						{() => {
							const selected = browser.selected();
							return selected ? modelPreview(browser, selected, "full", current()) : [];
						}}
					</picker>
				</col>
			),
			focusTarget: body => body.children()[0],
			onMount: () => void discover(),
		};
	},
};
