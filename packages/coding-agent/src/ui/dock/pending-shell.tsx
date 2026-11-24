/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `!`/`$` runs started while the agent streams (`pendingShell` slot): their
 * live blocks wait here, above the queued messages in a text terminal and at
 * the transcript's end natively, until the turn settles and they move into
 * the transcript. The blocks are the transcript's own, built by the shell
 * controller into a {@link ViewList} (`runs.push(mountNode(() => <BashRun …/>,
 * "shell run"))`, `runs.clear()` at settle); this is their ordered stack.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { ViewList } from "../shell/views";

/** See the module docs. */
export function PendingShellRuns(props: { readonly runs: ViewList }): JSXNode {
	const runs = props.runs;
	return () => (runs.entries().length > 0 ? <col>{runs.nodes}</col> : undefined);
}
