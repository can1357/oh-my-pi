import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Container } from "../../tui";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import { renderComposerShapePreview } from "../../overlays/composer-shape-preview";
import { getComposerShapeOptions } from "../../overlays/composer-shape-registry";
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
	#step: WizardStep | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		const choices = getComposerShapeOptions();
		this.#shapes = choices.map(choice => choice.value);
		this.#items = choices.map((choice, index) => ({
			value: choice.value,
			label: `${index + 1}  ${choice.label}`,
			description: choice.description,
		}));
		const configuredShape = host.ctx.composerShape ?? "band";
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
			this.#host.finish("skipped");
		};
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data.length === 1 ? Number(data) - 1 : -1;
		if (Number.isInteger(quickIndex) && quickIndex >= 0 && quickIndex < this.#items.length) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(this.#shapes[quickIndex] ?? "band");
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const intro = new Text(
			theme.fg("muted", "Select a layout; live preview updates below. Press Enter to confirm."),
			0,
			0,
		);
		const preview = new Container();
		preview.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
		for (const line of renderComposerShapePreview(this.#currentShape, width, this.#host.ctx.statusLine)) {
			preview.addChild(new Text(line, 0, 0));
		}
		const items = this.#items.length;
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				preview: { component: preview, optional: true },
				content: this.#selectList,
				minContentLines: items,
				fitContent: () => {
					this.#selectList.setMaxVisible(items);
				},
			});
		} else {
			this.#step.setIntro(intro);
			this.#step.setPreview({ component: preview, optional: true });
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	async #commit(shape: ComposerShape): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		try {
			await this.#host.ctx.saveComposerShape(shape);
		} finally {
			this.#host.finish("done");
		}
	}

	#preview(shape: ComposerShape): void {
		this.#currentShape = shape;
		this.#host.requestRender();
	}
}

/** Select and persist the prompt composer layout. */
export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	minVersion: 2,
	mount: host => new ComposerSceneController(host),
};
