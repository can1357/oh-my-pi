import type { Model } from "@oh-my-pi/pi-ai";
import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";
import {
	buildBrowserItems,
	ModelBrowser,
	resolveRoleAssignments,
	sortModelItems,
} from "../../components/model-browser";
import { theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const MAX_VISIBLE_MODELS = 10;
/** ModelBrowser chrome: search row + blank above the list, blank + two detail rows below. */
const BROWSER_FRAME_ROWS = 5;

class ModelSceneController implements SetupSceneController {
	title = "Choose your default model";
	subtitle = "Search configured models and save the model used for new sessions.";
	#browser: ModelBrowser;
	#status: string | undefined;
	#selecting = false;
	#disposed = false;
	#browserRowStart = 2;

	constructor(private readonly host: SetupSceneHost) {
		this.#browser = new ModelBrowser(host.ctx.settings);
		this.#browser.onActivate = item => {
			void this.#select(item.model, item.selector);
		};
		this.#browser.onCancel = () => host.finish("skipped");
		this.#syncModels();
	}

	async onMount(): Promise<void> {
		this.#status = theme.fg("muted", "Discovering available models…");
		this.host.requestRender();
		await this.#refreshModels();
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		this.#browser.invalidate();
	}

	handleInput(data: string): void {
		if (this.#selecting) return;
		this.#browser.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		if (this.#selecting) return;
		this.#browser.routeMouse(event, line - this.#browserRowStart);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const lines = [
			this.#status ?? theme.fg("muted", "Type to search. Enter saves the highlighted model as your default."),
			"",
		];
		const budget = maxLines === undefined ? MAX_VISIBLE_MODELS : maxLines - lines.length - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE_MODELS, budget)));
		this.#browserRowStart = lines.length;
		lines.push(...this.#browser.render(width));
		return lines;
	}

	#syncModels(): void {
		const registry = this.host.ctx.session.modelRegistry;
		const available = registry.getAvailable();
		const roles = resolveRoleAssignments(this.host.ctx.settings, registry.getAll(), available);
		const storage = this.host.ctx.settings.getStorage();
		const items = buildBrowserItems(available);
		sortModelItems(items, { roles, mruOrder: storage?.getModelUsageOrder() ?? [] });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(storage?.getModelUsageOrder() ?? []);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#browser.setItems(items);

		const current = this.host.ctx.session.model;
		if (current) {
			const selector = `${current.provider}/${current.id}`;
			this.#browser.setCurrentSelector(selector);
			this.#browser.selectSelector(selector);
		}
	}

	async #refreshModels(): Promise<void> {
		try {
			await this.host.ctx.session.modelRegistry.refresh("online-if-uncached");
			if (this.#disposed) return;
			this.#syncModels();
			this.#status = undefined;
			this.host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			this.#status = theme.fg("error", error instanceof Error ? error.message : String(error));
			this.host.requestRender();
		}
	}

	async #select(model: Model, selector: string): Promise<void> {
		if (this.#selecting) return;
		this.#selecting = true;
		this.#status = theme.fg("muted", `Saving ${selector} as the default model…`);
		this.host.requestRender();
		try {
			const projectScope = this.host.ctx.settings.get("modelRoleStorage") === "project";
			await this.host.ctx.session.setModel(model, "default", { selector, persist: !projectScope });
			if (projectScope) {
				this.host.ctx.settings.setProjectModelRole("default", selector);
			}
			await this.host.ctx.settings.flush();
			if (!this.#disposed) this.host.finish("done");
		} catch (error) {
			if (this.#disposed) return;
			this.#selecting = false;
			this.#status = theme.fg("error", error instanceof Error ? error.message : String(error));
			this.host.requestRender();
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
