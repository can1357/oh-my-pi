import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { formatStatusIcon } from "../../../tools/render-utils";
import type { LayoutMode } from "../../layout-mode";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const ITEMS: readonly SelectItem[] = [
	{ value: "omp", label: "OMP", description: "Tool cards with framed output previews" },
	{
		value: "opencode",
		label: "OpenCode",
		description: "Flat transcript; collapsed tool calls render as one line (Ctrl+O expands)",
	},
];

/**
 * Decorative side-by-side sample of the same tool call in both styles. The
 * wizard holds the alternate screen, so unlike the theme scene there is no
 * live transcript to preview against — a static mock is the honest option.
 */
function renderLayoutPreview(): string[] {
	const header = `${formatStatusIcon("success", theme)} ${theme.fg("toolTitle", theme.bold("Grep"))} ${theme.fg(
		"muted",
		`"Home"${theme.sep.dot}18 matches`,
	)}`;
	return [
		theme.fg("accent", theme.bold("OMP")),
		header,
		theme.fg("dim", "  src/routes/404.tsx:12: <Home />"),
		theme.fg("dim", "  src/components/header.tsx:8: Home"),
		theme.fg("dim", "  Ctrl+O: Expand"),
		"",
		theme.fg("accent", theme.bold("OpenCode")),
		header,
	];
}

class LayoutSceneController implements SetupSceneController {
	title = "Pick a layout";
	subtitle = "How tool calls render in the transcript; Enter saves the highlighted choice.";
	#selectList: SelectList;
	/** Render line where the select list began, or -1 while it is not shown. */
	#listRowStart = -1;

	constructor(private readonly host: SetupSceneHost) {
		const current = host.ctx.settings.get("display.layout");
		this.#selectList = new SelectList(ITEMS, ITEMS.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(
			Math.max(
				0,
				ITEMS.findIndex(item => item.value === current),
			),
		);
		this.#selectList.onSelect = item => {
			const mode = item.value as LayoutMode;
			this.host.ctx.settings.set("display.layout", mode);
			this.host.ctx.layoutMode = mode;
			this.host.finish("done");
		};
		this.#selectList.onCancel = () => this.host.finish("skipped");
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		const listLine = this.#listRowStart >= 0 ? line - this.#listRowStart : Number.NEGATIVE_INFINITY;
		routeSelectListMouse(this.#selectList, event, listLine);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const budget = maxLines ?? Number.POSITIVE_INFINITY;
		const lines: string[] = [theme.fg("dim", "Changeable any time in /settings under Appearance."), ""];
		// The mock is decorative — it yields to the list when the window is small.
		const preview = renderLayoutPreview();
		if (budget - lines.length - (preview.length + 1) - 1 >= ITEMS.length) {
			lines.push(...preview, "");
		}
		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}
}

export const layoutSetupScene: SetupScene = {
	id: "layout",
	title: "Pick a layout",
	minVersion: 3,
	mount: host => new LayoutSceneController(host),
};
