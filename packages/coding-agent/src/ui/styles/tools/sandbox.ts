/**
 * A contained run in the terminal looks of `bash` and `eval`: whether the
 * node carries the `sandboxed` head badge, and its sandbox warning notes
 * (the body's `omp.tool.sandbox.note` nodes) as warning-colored lines.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { SANDBOX_BADGE_TEXT } from "../../../tools/details/sandbox";
import { SANDBOX_NOTE_ROLE } from "../../tools/sandbox-meta";
import type { ToolProps } from "./look";

/** The run was contained by the OS sandbox (the presenter set the `sandboxed` badge). */
export function isSandboxed(props: ToolProps): boolean {
	return props.badges?.some(badge => badge.text === SANDBOX_BADGE_TEXT) === true;
}

/** The node's sandbox warning notes, warning-colored, unwrapped. */
export function sandboxNoteLines(node: UiNode, theme: Theme): string[] {
	const lines: string[] = [];
	for (const child of node.children()) {
		const props = child.props() as { role?: string; spans?: readonly { t: string }[] };
		if (props.role !== SANDBOX_NOTE_ROLE) continue;
		lines.push(theme.fg("warning", (props.spans ?? []).map(span => span.t).join("")));
	}
	return lines;
}
