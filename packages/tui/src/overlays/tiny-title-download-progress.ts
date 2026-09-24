import { type Component, truncateToWidth, visibleWidth } from "../index";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { ProgressBar } from "../components/progress-bar";
/** Download progress fields consumed by the status display. */
export interface TinyTitleDownloadProgress {
	status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, { loaded: number; total: number }>;
}
import { theme } from "../theme/theme";
import { getDefaultI18n } from "../i18n";

const DEFAULT_BAR_WIDTH = 24;

function padLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? truncateToWidth(line, width) : `${line}${" ".repeat(width - visible)}`;
}

function currentFile(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event) return undefined;
	if (event.file) return event.file.split("/").at(-1) ?? event.file;
	if (event.files) {
		let largestFile: string | undefined;
		let largestLoaded = -1;
		for (const file in event.files) {
			const state = event.files[file];
			if (state.loaded <= largestLoaded || state.loaded >= state.total) continue;
			largestFile = file;
			largestLoaded = state.loaded;
		}
		return largestFile?.split("/").at(-1) ?? largestFile;
	}
	return undefined;
}

function statusLabel(event: TinyTitleDownloadProgress | undefined): string {
	const i18n = getDefaultI18n();
	if (!event) return i18n.t("tui.download.preparing");
	if (event.status === "error") return i18n.t("tui.download.failed");
	if (event.status === "ready") return i18n.t("tui.download.ready");
	if (event.status === "done") return i18n.t("tui.download.downloaded");
	if (event.status === "download") return i18n.t("tui.download.downloading");
	if (event.status === "progress" || event.status === "progress_total") return i18n.t("tui.download.downloading");
	return i18n.t("tui.download.preparing");
}

function byteLabel(event: TinyTitleDownloadProgress | undefined): string | undefined {
	if (!event?.loaded || !event.total) return undefined;
	return `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;
}

export class TinyTitleDownloadProgressComponent implements Component {
	#modelLabel: string;
	#event: TinyTitleDownloadProgress | undefined;
	#bar = new ProgressBar(undefined, {
		min: 0,
		max: 100,
		minWidth: 8,
		maxWidth: DEFAULT_BAR_WIDTH,
		style: {
			filled: "█",
			empty: "░",
			styleFilled: text => theme.fg("accent", text),
			styleEmpty: text => theme.fg("muted", text),
			styleIndeterminate: text => theme.fg("muted", text),
		},
	});

	constructor(modelLabel: string) {
		this.#modelLabel = modelLabel;
	}

	update(event: TinyTitleDownloadProgress): void {
		this.#event = event;
		this.#bar.setValue(event.progress);
	}

	isComplete(): boolean {
		return this.#event?.status === "ready" || this.#event?.status === "error";
	}

	invalidate(): void {
		this.#bar.invalidate();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const border = theme.fg("border", theme.boxRound.horizontal.repeat(width));
		const status = statusLabel(this.#event);
		const file = currentFile(this.#event);
		const pct =
			this.#event?.progress === undefined ? "" : `${Math.floor(this.#event.progress).toString().padStart(3, " ")}%`;
		const bytes = byteLabel(this.#event);
		const title = `${theme.fg("accent", getDefaultI18n().t("tui.download.title"))} ${theme.fg("muted", status)} ${this.#modelLabel}`;
		const bar = this.#bar.render(Math.max(8, width - 36))[0] ?? "";
		const details = [bar, pct, bytes, file].filter((part): part is string => Boolean(part)).join(" ");

		return [border, padLine(` ${title}`, width), padLine(` ${details}`, width), border];
	}
}
