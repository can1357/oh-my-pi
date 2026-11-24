/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A side answer's body: markdown, with its `<inject>` block (the steering
 * prompt the answer drafted for the main session) shown apart as an
 * `omp.btw.inject` card: `Inject into main session` while sendable,
 * `➤ Injected into main session` once sent.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayText } from "../../../extensibility/inventory/display-text";
import {
	BTW_INJECT_LABEL,
	BTW_INJECTED_LABEL,
	type BtwInjectState,
} from "../../../modes/view-model/overlays/btw-inject";
import { type BtwInjectParts, formatBtwInjectText, splitBtwInject } from "../../../session/btw-history-model";
import { sanitizeErrorLine } from "../../../modes/view-model/chrome/error-block";
import "../../styles/panels/btw";

/** Markdown of answer text as shown: controls stripped, tabs expanded, trimmed. */
export function answerMarkdown(text: string): string {
	return sanitizeDisplayText(text).trim();
}

/** The `<inject>` card: one wrapped text per line of the block, then its state label. */
export function BtwInjectCard(props: { readonly text: string; readonly state: BtwInjectState }): JSXNode {
	const sent = props.state === "sent";
	const label: TspSpan = sent
		? { s: "success", t: `➤ ${BTW_INJECTED_LABEL}` }
		: { s: "customMessageLabel", t: BTW_INJECT_LABEL };
	return (
		<card role="omp.btw.inject" tone={sent ? "success" : "user"}>
			{formatBtwInjectText(props.text)
				.split("\n")
				.map(line => (
					<text text={line} wrap="word" />
				))}
			<text spans={[label]} />
		</card>
	);
}

/** An answer split around its `<inject>` block: prose before, the card, prose after. */
export function BtwInjectAnswer(props: {
	readonly parts: BtwInjectParts;
	readonly state: BtwInjectState;
	readonly stream: boolean;
}): JSXNode {
	const before = answerMarkdown(props.parts.before);
	const after = answerMarkdown(props.parts.after);
	return (
		<col gap="sm">
			{before && <md text={before} stream={props.stream} />}
			<BtwInjectCard text={props.parts.inject} state={props.state} />
			{after && <md text={after} stream={props.stream} />}
		</col>
	);
}

/**
 * An answer's body: split around its `<inject>` block when the block shows
 * apart (`inject` set, and the block closed or still streaming), else one
 * markdown node.
 */
export function BtwAnswerBody(props: {
	readonly answer: string;
	readonly inject: BtwInjectState | undefined;
	readonly stream: boolean;
}): JSXNode {
	const parts = props.inject ? splitBtwInject(props.answer) : undefined;
	if (parts && props.inject && (parts.closed || props.stream)) {
		return <BtwInjectAnswer parts={parts} state={props.inject} stream={props.stream} />;
	}
	return <md text={answerMarkdown(props.answer)} stream={props.stream} />;
}

/** Inline markdown of a one-line topic as spans: code spans become `mono`. */
export function topicSpans(text: string): TspSpan[] {
	const spans: TspSpan[] = [];
	const parts = text.split("`");
	if (parts.length % 2 === 0) return [{ t: text }];
	parts.forEach((part, index) => {
		if (part === "") return;
		spans.push(index % 2 === 1 ? { s: "mono", t: part } : { t: part });
	});
	return spans;
}

/**
 * An error message on one line: control sequences stripped, home paths shortened, whitespace
 * runs collapsed, truncated to a line; `Unknown error` when blank.
 */
export function flatError(error: string | undefined): string {
	return sanitizeErrorLine(error ?? "");
}
