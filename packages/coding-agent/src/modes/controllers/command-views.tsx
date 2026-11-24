/** @jsxImportSource @oh-my-pi/pi-tui */
/** Views the command controllers mount: report sheets, report bodies, transcript outcome lines, dialogs. */
import { type JSXNode, type KeyEvent, nativeRendering, type Reactive } from "@oh-my-pi/pi-tui";
import { styledSpans, unstyledText } from "@oh-my-pi/pi-tui/text/styled-spans";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspText } from "@oh-my-pi/pi-wire";
import { BorderedLoader } from "../../ui/overlays/panels/bordered-loader";
import { ContextViewer, type ContextViewerModel } from "../../ui/overlays/panels/context-viewer";
import { HotkeysSheet, type HotkeysSheetProps } from "../../ui/overlays/panels/hotkeys-sheet";
import { MoveOverlay, type MoveOverlayProps } from "../../ui/overlays/panels/move-overlay";
import { ReportPanel, type ReportPanelProps } from "../../ui/overlays/panels/report-panel";
import "../../ui/styles/apps/screen/look";
import { AnsiText } from "../../ui/transcript/ansi-text";

/** How a focused report reaches the terminal. */
export interface ReportSheetOptions {
	/** A full-screen page on the terminal's alternate screen; else a centered modal sheet (a native terminal). */
	readonly page: boolean;
	/** The sheet's role (Tern styles it by role). Default `omp.overlay.report`. */
	readonly role?: string;
	/** The sheet's title. */
	readonly head?: Reactive<TspText | undefined>;
	/** Keys taken on the sheet itself, for content that rebuilds its root. */
	readonly onKey?: (key: KeyEvent) => boolean;
}

/** A focused report sheet around `content`; see {@link ReportSheetOptions}. */
export function reportSheetView(content: JSXNode, options: ReportSheetOptions): JSXNode {
	return options.page ? (
		<overlay key="report" size="full" role="omp.app.screen" onKey={options.onKey}>
			{content}
		</overlay>
	) : (
		<overlay
			key="report"
			role={options.role ?? "omp.overlay.report"}
			anchor="center"
			size="lg"
			modal
			head={options.head}
			onKey={options.onKey}
		>
			{content}
		</overlay>
	);
}

export function reportPanelView(props: ReportPanelProps): JSXNode {
	return <ReportPanel {...props} />;
}

/** A markdown report body; a native terminal styles the source itself, so escapes spliced into it are dropped there. */
export function markdownView(text: string): JSXNode {
	const plain = text.includes("\x1b") ? unstyledText(text) : text;
	return <md text={() => (nativeRendering() ? plain : text)} />;
}

/**
 * A report body pre-styled with SGR colors: wrapped terminal rows (see
 * {@link AnsiText}); natively word-wrapped text whose spans carry the theme
 * colors the escapes came from.
 */
export function reportTextView(text: string): JSXNode {
	return () => {
		if (!nativeRendering()) return <AnsiText text={text} />;
		const spans = text.trim() === "" ? [] : styledSpans(text);
		return spans.length === 0 ? <col hidden /> : <text wrap="word" spans={spans} />;
	};
}

/** The native `/hotkeys` sheet body. */
export function hotkeysSheetView(props: HotkeysSheetProps): JSXNode {
	return <HotkeysSheet {...props} />;
}

/** Command output between two rules. */
export function ruledTextView(text: string): JSXNode {
	return (
		<col>
			<rule key="top" />
			<AnsiText text={text} padX={1} padY={1} />
			<rule key="bottom" />
		</col>
	);
}

/** A cancellable wait in the composer's place. */
export function loaderView(message: string, onAbort: () => void): JSXNode {
	return <BorderedLoader message={message} onAbort={onAbort} />;
}

export function contextViewerView(model: ContextViewerModel): JSXNode {
	return <ContextViewer model={model} />;
}

export function moveOverlayView(props: MoveOverlayProps): JSXNode {
	return <MoveOverlay {...props} />;
}

/** A `✓ message` transcript line in the accent color: a session-level outcome (`/new`, `/fork`, `/move`). */
export function successLineView(message: string): JSXNode {
	// A terminal separates blocks by a blank row; Tern gets the line's own spacer, as it stands apart there.
	return [
		() => (nativeRendering() ? <spacer size="sm" /> : null),
		<text
			spans={[{ s: "accent", t: `${currentTheme().symbols.symbol("status.success")} ${message}` }]}
			wrap="word"
		/>,
	];
}
