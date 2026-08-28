import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { ComposerShape } from "../../../config/settings-schema";
import { renderComposerShapePreview } from "../../components/composer-shape-preview";
import { getComposerShapeOptions } from "../../components/composer-shape-registry";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

class ComposerSceneController implements SetupSceneController {
	title = "Choose composer shape";
	subtitle = "Pick the prompt and status line layout for your workflow.";
	#selectList: SelectList;
	#shapes: readonly ComposerShape[];
	#items: readonly SelectItem[];
	#currentShape: ComposerShape = "band";
	#committing = false;
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		const choices = getComposerShapeOptions();
		this.#shapes = choices.map(choice => choice.value);
		this.#items = choices.map((choice, index) => ({
			value: choice.value,
			label: `${index + 1}  ${choice.label}`,
			description: choice.description,
		}));
		const configuredShape = host.ctx.settings.get("composer.shape") ?? "band";
		const initialShape = this.#shapes.includes(configuredShape) ? configuredShape : "band";
		this.#currentShape = initialShape;
		const initialIndex = Math.max(0, this.#shapes.indexOf(initialShape));

		const selectListTheme = getSelectListTheme();
		this.#selectList = new SelectList(this.#items, this.#items.length, selectListTheme);
		this.#selectList.setSelectedIndex(initialIndex);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value);
		};
		this.#selectList.onCancel = () => {
			// Esc skips the scene without saving; the configured shape stays untouched.
			this.host.finish("skipped");
		};
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data.length === 1 ? Number(data) - 1 : -1;
		if (Number.isInteger(quickIndex) && quickIndex >= 0 && quickIndex < this.#items.length) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(this.#shapes[quickIndex] ?? "band");
			return;
		}
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const listLine = line - this.#listRowStart;
		routeSelectListMouse(this.#selectList, event, listLine);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const budget = maxLines ?? Number.POSITIVE_INFINITY;
		const lines = [theme.fg("muted", "Select a layout; live preview updates below. Press Enter to confirm."), ""];

		const previewLines = renderComposerShapePreview(this.#currentShape, width, this.host.ctx.statusLine);
		if (budget - lines.length - previewLines.length - 2 >= this.#items.length) {
			lines.push(theme.fg("muted", "Preview:"), ...previewLines, "");
		}

		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #commit(shape: ComposerShape): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		try {
			this.host.ctx.settings.set("composer.shape", shape);
			await this.host.ctx.settings.flush();
		} finally {
			this.host.finish("done");
		}
	}

	#preview(shape: ComposerShape): void {
		this.#currentShape = shape;
		this.host.requestRender();
	}
}

export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	minVersion: 2,
	mount: host => new ComposerSceneController(host),
};
