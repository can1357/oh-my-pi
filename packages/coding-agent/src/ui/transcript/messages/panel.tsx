/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Transcript containers: the transcript's block list, the tool-activity
 * group (hidden with tool activity) and the streaming panel overlays render
 * their body in (sections, then a muted footer line).
 *
 * Terminal looks: `src/ui/styles/messages/panel.ts`.
 */
import { For, type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";

/** The transcript's block list: blocks in order, set off by blank rows in the terminal. */
export function TranscriptBlocks(props: { children: JSXNode }): JSXNode {
	return <col role="omp.transcript">{props.children}</col>;
}

/** Tool activity: shown and hidden with the transcript's tool-activity toggle. */
export function ToolActivity(props: { visible: Reactive<boolean>; children: JSXNode }): JSXNode {
	return (
		<col role="omp.activity" hidden={() => (read(props.visible) ? undefined : true)}>
			{props.children}
		</col>
	);
}

/** One refresh of a streaming overlay's body. */
export interface StreamingPanelView {
	/** Sections (empty ones skipped), set off by blank rows. */
	readonly sections: readonly (JSXNode | undefined)[];
	/** The footer line (may carry SGR styling for the terminal). */
	readonly footer: string;
}

function isEmpty(section: JSXNode | undefined): boolean {
	return section === undefined || section === null || (Array.isArray(section) && section.length === 0);
}

/** A streaming overlay's body: its sections, then the footer. */
export function StreamingPanel(props: { view: Reactive<StreamingPanelView> }): JSXNode {
	const view = (): StreamingPanelView => read(props.view);
	return (
		<col gap="sm" role="omp.panel">
			<For each={() => view().sections.filter(section => !isEmpty(section))}>{section => <col>{section}</col>}</For>
			<text
				role="omp.panel.footer"
				spans={() => [{ t: stripEscapes(view().footer), s: "muted" }]}
				wrap="word"
				term={() => ({ footer: view().footer })}
			/>
		</col>
	);
}
