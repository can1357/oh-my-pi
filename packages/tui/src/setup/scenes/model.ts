import type { Model } from "@oh-my-pi/pi-ai";
import type { SgrMouseEvent } from "../../mouse";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { buildBrowserItems, ModelBrowser, resolveRoleAssignments, sortModelItems } from "../../overlays/model-browser";
import { BROWSER_FRAME_ROWS } from "../../overlays/model-picker";
import { formatKeyHint } from "../../app-keybindings";
import { theme } from "../../theme/theme";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import type { SetupScene, SetupSceneController, SetupSceneHost, StyledLine } from "./types";

const MAX_VISIBLE_MODELS = 10;

class ModelSceneController implements SetupSceneController {
	title = "Choose your default model";
	subtitle = "Search configured models and save the model used for new sessions.";
	#browser: ModelBrowser;
	/** Intro override; `busy` while discovering or saving (a spinner on the native path). */
	#status: (StyledLine & { readonly busy: boolean }) | undefined;
	#selecting = false;
	#disposed = false;
	#step: WizardStep | undefined;
	#native = new Memo();

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
		this.#status = { text: "Discovering available models…", color: "muted", busy: true };
		this.#host.requestRender();
		await this.#refreshModels();
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#native.clear();
		if (this.#step) this.#step.invalidate();
		else this.#browser.invalidate();
	}

	handleInput(data: string): void {
		if (this.#selecting) return;
		if (this.#step) this.#step.handleInput(data);
		else this.#browser.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#selecting) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const status = this.#status;
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

	/** Intro (a spinner while models load or the choice saves) over the model browser, which describes itself. */
	describe(): NativeNode {
		const status = this.#status;
		const enter = formatKeyHint("enter");
		return this.#native.get([status, enter], () => {
			let intro: NativeNode;
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
		const items = buildBrowserItems(available);
		sortModelItems(items, { roles, mruOrder: source.mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(source.mruOrder);
		this.#browser.setPerfStats(source.modelPerf);
		this.#browser.setItems(items);

		if (current) {
			const selector = `${current.provider}/${current.id}`;
			this.#browser.setCurrentSelector(selector);
			this.#browser.selectSelector(selector);
		}
	}

	async #refreshModels(): Promise<void> {
		try {
			await this.#host.ctx.refreshModels();
			if (this.#disposed) return;
			this.#syncModels();
			this.#status = undefined;
			this.#host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			this.#status = { text: error instanceof Error ? error.message : String(error), color: "error", busy: false };
			this.#host.requestRender();
		}
	}

	async #select(model: Model, selector: string): Promise<void> {
		if (this.#selecting) return;
		this.#selecting = true;
		this.#status = { text: `Saving ${selector} as the default model…`, color: "muted", busy: true };
		this.#host.requestRender();
		try {
			await this.#host.ctx.selectModel(model, selector);
			if (!this.#disposed) this.#host.finish("done");
		} catch (error) {
			if (this.#disposed) return;
			this.#selecting = false;
			this.#status = { text: error instanceof Error ? error.message : String(error), color: "error", busy: false };
			this.#host.requestRender();
		}
	}
}

/** Setup step that assigns one available model to the persisted default role. */
export const modelSetupScene: SetupScene = {
	id: "model",
	title: "Choose your default model",
	minVersion: 1,
	mount: host => new ModelSceneController(host),
};
