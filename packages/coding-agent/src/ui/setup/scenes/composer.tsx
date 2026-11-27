/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Composer shape: pick the prompt and status-line layout. The highlighted
 * shape previews below the list (natively the preview is the composer's own
 * rendering, sent as `ansi` at 80 columns).
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../styles/setup";
import { composerShape } from "../../styles/composer/shapes";
import { composerShapePreviewRows } from "../../styles/overlays/composer-shape-preview";
import type { SetupScene } from "../types";
import { type Choice, ChoiceList, ChoiceModel, keyLabel } from "./choice";
import { actionKeyId } from "../../keys/hints";

/** Shapes in the order the scene lists them. */
const SHAPE_ORDER = ["band", "box", "claude", "pi", "borderless", "rule", "field", "rail"] as const;

/** Columns the native preview is rendered at. */
const NATIVE_PREVIEW_COLS = 80;

export const composerScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	subtitle: "Pick the prompt and status line layout for your workflow.",
	step: "Composer",
	minVersion: 2,
	mount(context) {
		const host = context.host;
		const choices: Choice<string>[] = SHAPE_ORDER.map((id, index) => {
			const shape = composerShape(id);
			return { value: id, label: `${index + 1} ${shape.label ?? id}`, detail: shape.description ?? "" };
		});
		const configured = choices.some(choice => choice.value === host.composerShape) ? host.composerShape : "band";
		const model = new ChoiceModel<string>({
			context,
			choices,
			initial: configured,
			commit: shape => host.saveComposerShape(shape),
		});
		const intro = `Select a layout; live preview updates below. Press ${keyLabel(actionKeyId("tui.select.confirm", "enter"))} to confirm.`;
		return {
			body: (
				<col
					role="omp.setup.composer"
					gap="sm"
					term={() => ({ maxLines: context.maxLines() })}
					onKey={key => model.key(key)}
				>
					<text spans={[{ s: "muted", t: intro }]} />
					<ChoiceList model={model} />
					<col term={() => ({ shape: model.selected() })}>
						<text spans={[{ s: "muted", t: "Preview:" }]} />
						<ansi
							cols={NATIVE_PREVIEW_COLS}
							text={() =>
								composerShapePreviewRows(currentTheme(), model.selected(), NATIVE_PREVIEW_COLS).join("\n")
							}
						/>
					</col>
				</col>
			),
			wheel: delta => model.move(delta, false),
		};
	},
};
