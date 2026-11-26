/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The error banner over the composer: a strip with the error's headline,
 * `Details` (unfolds the whole message in place, `Less` folds it) when the
 * message has more to show, and `Dismiss` when the caller can dismiss it.
 *
 * The terminal draws it as a red-ruled block: the message (first line bold,
 * at most four rows, then a `… +N more lines` hint) and the dismissal note.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import "../../styles/panels/error-banner";
import { ActionButton } from "./common";

export interface ErrorBannerProps {
	/** The error text (may carry ANSI styling). */
	readonly message: string;
	/** Dismiss the banner; absent: no Dismiss button. */
	readonly onDismiss?: () => void;
}

/** Headlines longer than this offer Details even on one line. */
const HEADLINE_MAX = 80;

export function ErrorBanner(props: ErrorBannerProps): JSXNode {
	const plain = replaceTabs(stripEscapes(props.message)).trim();
	const headline = plain.split("\n")[0] || "Error";
	const expandable = plain !== headline || headline.length > HEADLINE_MAX;
	const expanded = signal(false);
	return (
		<row
			role="omp.errorBanner"
			tone="error"
			gap="sm"
			align={() => (expanded() ? "start" : "center")}
			term={{ message: props.message }}
			onAction={act => {
				if (act === "details") expanded.set(!expanded());
				else if (act === "dismiss") props.onDismiss?.();
			}}
		>
			{() =>
				expanded() ? (
					<text grow={1} wrap="word" spans={[{ s: "error", t: plain }]} />
				) : (
					<text grow={1} lines={1} truncate="end" title={plain} spans={[{ s: "error", t: headline }]} />
				)
			}
			{expandable && <ActionButton id="details" label={() => (expanded() ? "Less" : "Details")} />}
			{props.onDismiss && <ActionButton id="dismiss" label="Dismiss" />}
		</row>
	);
}
