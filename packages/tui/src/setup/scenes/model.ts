import type { Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { SgrMouseEvent } from "../../mouse";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "../../overlays/model-browser";
import { BROWSER_FRAME_ROWS } from "../../overlays/model-picker";
import { formatKeyHint } from "../../app-keybindings";
import { matchesKey } from "../../keys";
import { theme } from "../../theme/theme";
import { col, node, span, text } from "../../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../../native/node";
import { Memo } from "../../native/memo";
import { dockedPicker, PICKER_KEY, pickerAction, pickerEvent } from "../../native/picker";
import {
	SETUP_SHEET_ROLE,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
	type StyledLine,
} from "./types";

const MAX_VISIBLE_MODELS = 10;
const TITLE = "Choose your default model";
/** The sheet's subtitle while nothing is in flight. */
const SHEET_SUBTITLE = "Used by new sessions. Change it with /model.";

class ModelSceneController implements SetupSceneController {
	title = TITLE;
	subtitle = "Search configured models and save the model used for new sessions.";
	#browser: ModelBrowser;
	/** Base rows (available chat models), the picker's catalogue. */
	#items: ModelBrowserItem[] = [];
	#current: string | undefined;
	#discovering = false;
	#discoveryError: string | undefined;
	/** Selector being saved as the default. */
	#saving: string | undefined;
	#saveError: string | undefined;
	#disposed = false;
	#step: WizardStep | undefined;
	#sheet = new Memo();
	#inline = new Memo();

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#browser = new ModelBrowser(host.ctx.modelSource);
		this.#browser.onActivate = item => {
			void this.#select(item.model, item.selector);
		};
		this.#browser.onCancel = () => host.finish("skipped");
		this.#syncModels();
	}

	async onMount(): Promise<void> {
		await this.#refreshModels();
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#sheet.clear();
		this.#inline.clear();
		if (this.#step) this.#step.invalidate();
		else this.#browser.invalidate();
	}

	handleInput(data: string): void {
		if (this.#saving !== undefined) return;
		// With nothing to pick after a failed discovery, Enter retries it (the sheet's primary action).
		if (this.#canRetry() && (matchesKey(data, "enter") || matchesKey(data, "return"))) {
			void this.#refreshModels();
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#browser.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#saving !== undefined) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const status = this.#status();
		const intro = new Text(
			status
				? theme.fg(status.color, status.text)
				: theme.fg(
						"muted",
						`Type to search. ${formatKeyHint("enter")} saves the highlighted model as your default.`,
					),
			0,
			0,
		);
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				content: this.#browser,
				minContentLines: 1,
				fitContent: budget => {
					const visible = budget === undefined ? MAX_VISIBLE_MODELS : budget - BROWSER_FRAME_ROWS;
					this.#browser.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE_MODELS, visible)));
				},
			});
		} else {
			this.#step.setIntro(intro);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	/**
	 * The setup sheet (search, provider-grouped models with fact columns, the
	 * highlighted model's details, Skip and Set as default), or where the
	 * terminal lacks `picker`, a status line over the browser's own list.
	 */
	describe(cx?: DescribeContext): NativeNode {
		return cx?.supports("picker") ? this.#describeSheet() : this.#describeInline();
	}

	/** Sheet pointer events, each on the path of the key it stands for. */
	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event, PICKER_KEY);
		if (!picked || this.#saving !== undefined) return;
		if (picked.kind !== "action") {
			this.#browser.routePickerItem(picked.item, picked.kind === "activate");
			return;
		}
		switch (picked.act) {
			case "skip":
				this.#host.finish("skipped");
				return;
			case "retry":
				if (this.#discoveryError !== undefined) void this.#refreshModels();
				return;
			case "save": {
				const selected = this.#browser.pickerSelected;
				if (selected) this.#browser.routePickerItem(selected, true);
				return;
			}
			case "clear":
				if (this.#browser.query.length > 0) this.#browser.handleCancel();
				return;
		}
	}

	/** The latest in-flight or failed operation, as one line of status copy. */
	#status(): (StyledLine & { readonly busy: boolean }) | undefined {
		if (this.#saving !== undefined) {
			return { text: `Saving ${this.#saving} as the default model…`, color: "muted", busy: true };
		}
		if (this.#saveError !== undefined) return { text: this.#saveError, color: "error", busy: false };
		if (this.#discoveryError !== undefined) return { text: this.#discoveryError, color: "error", busy: false };
		if (this.#discovering) return { text: "Discovering available models…", color: "muted", busy: true };
		return undefined;
	}

	/** Discovery failed and nothing is listed: Enter and the primary action retry it. */
	#canRetry(): boolean {
		return this.#discoveryError !== undefined && this.#browser.pickerSelected === null;
	}

	#describeSheet(): NativeNode {
		const browser = this.#browser;
		const query = browser.query;
		const filtering = query.trim().length > 0;
		// Provider groups while browsing; one ranked "Matches" block while searching.
		const view = browser.pickerOrder({ providers: !filtering, rest: filtering ? "Matches" : "All models" });
		const catalogue = browser.pickerItems(this.#items);
		const preview = browser.pickerPreview("full", this.#current);
		const deps = [
			catalogue,
			view,
			preview,
			query,
			browser.cursor,
			browser.pickerSelected,
			this.#current,
			this.#discovering,
			this.#discoveryError,
			this.#saving,
			this.#saveError,
		];
		return this.#sheet.get(deps, () => {
			const rows = browser.pickerRows(catalogue, view, this.#current);
			const listed = view.count > 0 || query.length > 0;
			const state: TspPickerProps["state"] = listed
				? "ready"
				: this.#discoveryError !== undefined
					? "error"
					: this.#discovering
						? "loading"
						: "ready";
			const saving = this.#saving !== undefined;
			const retry = this.#canRetry();
			const primary = retry
				? pickerAction("retry", "Retry", "enter", { primary: true })
				: pickerAction("save", saving ? "Saving…" : "Set as default", "enter", {
						primary: true,
						...(saving
							? { disabled: "Saving the default model" }
							: rows.selected
								? {}
								: { disabled: "No model highlighted" }),
					});
			// The reconciler hoists the picker into `layer`; the column is its place in the page.
			return dockedPicker(
				{
					role: SETUP_SHEET_ROLE,
					title: TITLE,
					subtitle: this.#sheetSubtitle(),
					icon: "cpu",
					noun: "models",
					size: "lg",
					layout: "rows",
					preview: "side",
					placeholder: "Search models…",
					...rows,
					state,
					...(state === "error" && this.#discoveryError !== undefined ? { message: this.#discoveryError } : {}),
					empty: "No models yet. Skip this step and run /login to sign in to a provider.",
					actions: [pickerAction("skip", "Skip", "escape", { end: true }), primary],
				},
				this.#saveError === undefined
					? preview
					: [text([span(this.#saveError, "error")], { wrap: "word" }), ...preview],
			);
		});
	}

	#sheetSubtitle(): TspPickerProps["subtitle"] {
		if (this.#saving !== undefined)
			return [span("Saving "), span(this.#saving, "mono"), span(" as your default model…")];
		if (this.#saveError !== undefined) return [span(`Couldn't save the default model: ${this.#saveError}`, "error")];
		if (this.#discoveryError !== undefined && this.#items.length > 0) return [span(this.#discoveryError, "error")];
		if (this.#discovering && this.#items.length > 0) return "Looking for more models…";
		return SHEET_SUBTITLE;
	}

	/** Status (a spinner while models load or the choice saves) over the model browser, which describes itself. */
	#describeInline(): NativeNode {
		const status = this.#status();
		const enter = formatKeyHint("enter");
		return this.#inline.get([status?.text, status?.color, status?.busy, enter], () => {
			let intro: NativeChild;
			if (status?.busy) {
				intro = node("spinner", { label: [span(status.text, status.color)] });
			} else if (status) {
				intro = text([span(status.text, status.color)]);
			} else {
				intro = text([span(`Type to search. ${enter} saves the highlighted model as your default.`, "muted")]);
			}
			return col([{ ...intro, key: "intro" }, this.#browser], { gap: "sm", role: "omp.setup.model" });
		});
	}

	#syncModels(): void {
		const { available, all, current } = this.#host.ctx.getModels();
		const source = this.#host.ctx.modelSource;
		const roles = resolveRoleAssignments(source, all, available);
		const items = buildBrowserItems(available.filter(model => modelKind(model) === "chat"));
		sortModelItems(items, { roles, mruOrder: source.mruOrder });
		this.#items = items;
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(source.mruOrder);
		this.#browser.setPerfStats(source.modelPerf);
		this.#browser.setItems(items);

		if (current) {
			const selector = `${current.provider}/${current.id}`;
			this.#current = selector;
			this.#browser.setCurrentSelector(selector);
			this.#browser.selectSelector(selector);
		}
	}

	async #refreshModels(): Promise<void> {
		if (this.#discovering) return;
		this.#discovering = true;
		this.#discoveryError = undefined;
		this.#host.requestRender();
		try {
			await this.#host.ctx.refreshModels();
			if (this.#disposed) return;
			this.#syncModels();
		} catch (error) {
			if (this.#disposed) return;
			this.#discoveryError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#discovering = false;
		}
		this.#host.requestRender();
	}

	async #select(model: Model, selector: string): Promise<void> {
		if (this.#saving !== undefined) return;
		this.#saving = selector;
		this.#saveError = undefined;
		this.#host.requestRender();
		try {
			await this.#host.ctx.selectModel(model, selector);
			if (!this.#disposed) this.#host.finish("done");
		} catch (error) {
			if (this.#disposed) return;
			this.#saving = undefined;
			this.#saveError = error instanceof Error ? error.message : String(error);
			this.#host.requestRender();
		}
	}
}

/** Setup step that assigns one available model to the persisted default role. */
export const modelSetupScene: SetupScene = {
	id: "model",
	title: TITLE,
	step: "Model",
	minVersion: 1,
	mount: host => new ModelSceneController(host),
};
