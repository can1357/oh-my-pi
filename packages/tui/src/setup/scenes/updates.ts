import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { getSelectListTheme, theme } from "../../theme/theme";
import { col, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import { uiText } from "@oh-my-pi/pi-utils";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const INTRO_EN =
	"Updates install through whatever installed omp: the standalone binary, Homebrew, mise, bun, or npm. Change this later in /settings.";
const INTRO = uiText(INTRO_EN);

const UPDATE_ITEMS: readonly SelectItem[] = [
	{
		value: "auto",
		label: "1  Update automatically",
		description: "Installs in the background; the next launch runs it",
	},
	{
		value: "notify",
		label: "2  Notify me",
		description: "Show a notice on startup; run omp update yourself",
	},
];
const UPDATE_ITEM_VIEWS: readonly SelectItem[] = UPDATE_ITEMS.map(item => ({
	value: item.value,
	label: uiText(item.label),
	description: item.description ? uiText(item.description) : undefined,
}));

class UpdatesSceneController implements SetupSceneController {
	get title(): string {
		return uiText("Keep omp up to date");
	}
	subtitle = uiText("Choose how new releases reach you.");
	#selectList: SelectList;
	#committing = false;
	#step: WizardStep | undefined;
	#native = new Memo();

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#selectList = new SelectList(UPDATE_ITEM_VIEWS, UPDATE_ITEM_VIEWS.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(host.ctx.autoUpdate ? 0 : 1);
		this.#selectList.onSelect = item => {
			void this.#commit(item.value === "auto");
		};
		// Esc skips the scene; the configured setting stays untouched.
		this.#selectList.onCancel = () => host.finish("skipped");
	}

	invalidate(): void {
		this.#native.clear();
		if (this.#step) this.#step.invalidate();
		else this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data === "1" || data === "2" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#host.requestRender();
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#committing) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		this.#step ??= new WizardStep({
			kind: "choice",
			intro: new Text(theme.fg("muted", INTRO), 0, 0),
			content: this.#selectList,
			minContentLines: UPDATE_ITEM_VIEWS.length,
			fitContent: () => {
				this.#selectList.setMaxVisible(UPDATE_ITEM_VIEWS.length);
			},
		});
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	describe(): NativeNode {
		return this.#native.get([this.#selectList], () =>
			col([text([span(INTRO, "muted")], { wrap: "word" }), this.#selectList], {
				gap: "sm",
				role: "omp.setup.updates",
			}),
		);
	}

	async #commit(enabled: boolean): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		try {
			await this.#host.ctx.saveAutoUpdate(enabled);
		} finally {
			this.#host.finish("done");
		}
	}
}

/**
 * Opt in to background self-update (`update.auto`). Skipped where omp cannot
 * update itself, notably under Tern, which keeps its omp current on its own.
 */
export const updatesSetupScene: SetupScene = {
	id: "auto-update",
	title: "Keep omp up to date",
	step: "Updates",
	minVersion: 3,
	shouldRun: ctx => ctx.canAutoUpdate(),
	mount: host => new UpdatesSceneController(host),
};

