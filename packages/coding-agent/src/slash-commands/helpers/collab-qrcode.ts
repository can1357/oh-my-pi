import { type Component, Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AnimationFrame, TranscriptPresentationTarget } from "../../modes/components/transcript-container";
import { fgOrPlain } from "../../modes/theme/theme";
import { urlHyperlinkAlways } from "../../tui";
import { QrCode, renderQrHalfBlocks } from "../../utils/qrcode";

/** Scheme-less display form of a collab browser deep link, OSC-8 linked. */
export function collabBrowserLink(webLink: string, label?: string): string {
	const schemeLess = webLink.replace(/^https?:\/\//, "");
	const display = fgOrPlain("accent", `\x1b[4m${label ?? schemeLess}\x1b[24m`);
	const linked = urlHyperlinkAlways(webLink, display);
	// Without OSC-8 support, keep the literal URL at the visible prefix.
	return label !== undefined && linked === display ? fgOrPlain("accent", `\x1b[4m${schemeLess}\x1b[24m`) : linked;
}

/**
 * One-shot transcript block that prints a collab browser-join URL as a
 * scannable QR code. The symbol is encoded once at construction (byte mode,
 * EC level M) and rendered as ANSI half-blocks; on terminals too narrow for
 * the symbol it degrades to a one-line hint that includes the URL.
 *
 * The transcript viewport can also clip a live block to a single row under
 * pressure (many short settled blocks — typical when thinking is a one-line
 * summary rather than a tall trace). The QR's first/last rows are a white
 * quiet zone, so a 1-row clip looks like an empty white line. When the
 * allocated height cannot fit the full symbol, degrade to the same hint.
 * The sibling `/collab` status heading can also collapse to its first row
 * under that pressure, so the hint must carry the URL itself — "use the
 * URL above" is not reachable.
 */
export class CollabQrCodeComponent implements Component, TranscriptPresentationTarget {
	readonly #lines: readonly string[];
	readonly #minWidth: number;
	#allocatedRows = Number.POSITIVE_INFINITY;

	constructor(readonly url: string) {
		const rows = renderQrHalfBlocks(QrCode.encodeText(url, "M"));
		this.#lines = rows.map(row => ` ${row}`);
		this.#minWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0) + 1;
	}

	setTranscriptAllocation(rows: number, _frame?: AnimationFrame): void {
		this.#allocatedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : Number.POSITIVE_INFINITY;
	}

	render(width: number): readonly string[] {
		if (width < this.#minWidth) {
			return [this.#hiddenHint(`terminal width ${width}; need ${this.#minWidth}`, width)];
		}
		if (this.#allocatedRows < this.#lines.length) {
			return [this.#hiddenHint(`viewport height ${this.#allocatedRows}; need ${this.#lines.length}`, width)];
		}
		return this.#lines;
	}

	/** Survives emergency 1-row transcript pressure when this block is otherwise hidden. */
	renderTranscriptBlockEmergencyRow(width: number): string {
		return this.#hiddenHint(
			Number.isFinite(this.#allocatedRows)
				? `viewport height ${this.#allocatedRows}; need ${this.#lines.length}`
				: "transcript pressure",
			width,
		);
	}

	#hiddenHint(reason: string, width: number): string {
		return truncateToWidth(
			`${collabBrowserLink(this.url, "Join")} ${fgOrPlain("warning", `QR code hidden: ${reason}.`)}`,
			width,
			Ellipsis.Omit,
		);
	}
}
