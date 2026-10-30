import { type Component, Container } from "../tui";
import { isNativeRendering } from "../native/state";
import { Disclosure } from "../components/disclosure";
import { Text } from "../components/text";
import { formatDiagnostics } from "../render/render-utils";
import { getLanguageFromPath, getThemeEpoch, theme } from "../theme";
import { card, span, text, withHidden } from "../native/describe";
import { type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { plainText } from "../native/spans";
import { Memo } from "../native/memo";

/** Diagnostics shown by the collapsed native card, matching the ANSI tree's collapsed count. */
const COLLAPSED_DIAGNOSTICS = 5;

const EMPTY_ROWS: readonly string[] = [];

/** One file's worth of late LSP diagnostics, as carried on the transcript message. */
export interface LateDiagnosticsFile {
	path?: string;
	summary?: string;
	errored?: boolean;
	messages?: string[];
}

/** A tool frame (edit/write) that takes late diagnostics for its own paths. */
interface LateDiagnosticsTarget {
	attachLateDiagnostics(
		files: readonly { path: string; summary: string; errored: boolean; messages: string[] }[],
	): boolean;
}

/**
 * Native terminals append late diagnostics into the edit/write frame they
 * belong to: each file goes to the most recent tool component in `blocks`
 * that accepts it. Returns the files no frame took (all of them on the ANSI
 * path), for the standalone {@link LateDiagnosticsMessageComponent}.
 */
export function routeLateDiagnostics(
	blocks: readonly Component[],
	files: readonly LateDiagnosticsFile[],
): LateDiagnosticsFile[] {
	if (!isNativeRendering()) return [...files];
	const targets = blocks.filter(
		(block): block is Component & LateDiagnosticsTarget =>
			typeof (block as Partial<LateDiagnosticsTarget>).attachLateDiagnostics === "function",
	);
	const unrouted: LateDiagnosticsFile[] = [];
	for (const file of files) {
		const entry = file.path
			? {
					path: file.path,
					summary: file.summary ?? "",
					errored: file.errored === true,
					messages: file.messages ?? [],
				}
			: undefined;
		const routed =
			entry !== undefined && targets.findLast(target => target.attachLateDiagnostics([entry])) !== undefined;
		if (!routed) unrouted.push(file);
	}
	return unrouted;
}

/**
 * Renders late LSP diagnostics (arrived after edit/write returned) in the
 * transcript, reusing the same tree renderer the edit/write tools use so the
 * styling stays consistent. Supports the global tool-output expand toggle.
 */
export class LateDiagnosticsMessageComponent extends Container {
	#toolActivityVisible = true;
	// Controlled expansion delegate with no summary: the collapsed and
	// expanded diagnostic trees are mutually exclusive slots, each formatted
	// lazily on its first render. Only the tool-visibility gate stays here.
	#disclosure: Disclosure | undefined;
	readonly #files: LateDiagnosticsFile[];
	#expanded = false;
	readonly #native = new Memo();

	constructor(files: LateDiagnosticsFile[]) {
		super();
		this.#files = files;

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#disclosure?.setExpanded(expanded);
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return EMPTY_ROWS;
		return super.render(width);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	/**
	 * A severity-toned card (role `omp.diagnostics.late`) with one wrapped line
	 * per diagnostic, clamped by the terminal while collapsed.
	 */
	override describe(): NativeNode {
		const key = [this.#expanded, this.#toolActivityVisible, getThemeEpoch()];
		return this.#native.get(key, () => {
			const input = this.#diagnosticInput();
			const icon = input?.errored ? theme.status.error : theme.status.warning;
			const head = [span(`${icon} `, input?.errored ? "error" : "warning"), span("Late diagnostics", "toolTitle")];
			if (input?.summary) head.push(span(` (${plainText(input.summary)})`, "dim"));
			const diagnostics = card(
				{
					role: "omp.diagnostics.late",
					tone: input?.errored ? "error" : "warning",
					head,
					collapsible: true,
					collapsed: !this.#expanded,
					preview: { lines: COLLAPSED_DIAGNOSTICS },
				},
				(input?.messages ?? []).map((message, index) =>
					text([span(plainText(message), "mono")], { wrap: "word", key: `d${index}` }),
				),
			);
			return withHidden(diagnostics, !this.#toolActivityVisible);
		});
	}

	override invalidate(): void {
		this.#rebuild();
	}

	#rebuild(): void {
		// Preserve controlled state across theme-invalidation rebuilds while
		// leaving both diagnostic trees unmaterialized until their next render.
		const expanded = this.#disclosure?.expanded ?? false;
		this.clear();
		this.#disclosure?.dispose();
		this.#disclosure = undefined;

		const input = this.#diagnosticInput() ?? { errored: false, summary: "", messages: [] };

		this.#disclosure = new Disclosure({
			collapsedBody: () => new Text(this.#format(input, false), 1, 0),
			body: () => new Text(this.#format(input, true), 1, 0),
			expanded,
		});
		this.addChild(this.#disclosure);
	}

	/** Aggregate file payloads; undefined when there is nothing to render. */
	#diagnosticInput(): { errored: boolean; summary: string; messages: string[] } | undefined {
		const messages: string[] = [];
		const summaries: string[] = [];
		let errored = false;
		for (const file of this.#files) {
			if (file.messages?.length) messages.push(...file.messages);
			if (file.summary) summaries.push(file.summary);
			if (file.errored) errored = true;
		}
		if (messages.length === 0) return undefined;
		return { errored, summary: summaries.join(", "), messages };
	}

	/** Render one branch of the diagnostic tree, reusing the tool renderer. */
	#format(input: { errored: boolean; summary: string; messages: string[] }, expanded: boolean): string {
		return formatDiagnostics(input, expanded, theme, fp => theme.getLangIcon(getLanguageFromPath(fp)), {
			title: "Late diagnostics",
		}).replace(/^\n+/, "");
	}
}
