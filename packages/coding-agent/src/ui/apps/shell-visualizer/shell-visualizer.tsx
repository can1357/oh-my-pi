/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The bash visualizer's focused inspector over the presentation the
 * transcript shows: natively a `shell` node in inspector mode; without a
 * presentation, the plain notice.
 *
 * The terminal shows the classic inspector (the `omp.app.shell` look): the
 * key help and layer states, the presentation rows, and the selected node's
 * details in a pane under them.
 */
import { computed, type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { INSPECTOR_ROLE, NO_PRESENTATION } from "../../styles/apps/shell-visualizer/look";
import type { Shell } from "../../shell/shell";
import "../../styles/apps/screen/look";
import { type ShellInspectorSource, ShellVisualizerModel } from "./model";

/**
 * Open the inspector over `shell` as a page of its own holding the keys (a
 * bash card's `inspect` action); closing the returned handle takes it down.
 */
export function presentShellInspector(
	shell: Pick<Shell, "overlays" | "size">,
	source: ShellInspectorSource,
): { close(): void } {
	const model = new ShellVisualizerModel({ ...source, height: () => shell.size().rows });
	return shell.overlays.show(
		() => (
			<overlay key="fullscreen" size="full" role="omp.app.screen" page={{}}>
				<ShellVisualizer model={model} />
			</overlay>
		),
		{ focus: root => root.children()[0] ?? root, mouse: "off" },
	);
}

export function ShellVisualizer(props: { readonly model: ShellVisualizerModel }): JSXNode {
	const model = props.model;
	const handlers = {
		onKey: (key: { id: string }) => model.key(key.id),
		onSelect: (item: string) => model.event({ type: "select", key: "", item }),
		onAction: (act: string, event: Parameters<ShellVisualizerModel["event"]>[0]) => model.event(event),
		onChange: (event: Parameters<ShellVisualizerModel["event"]>[0]) => model.event(event),
	};
	// One node while a presentation exists: it holds the keyboard focus across view changes.
	const presented = computed(() => model.presentation() !== undefined);
	return () => {
		if (!presented()) {
			return (
				<canvas
					paint={(width: number) => NO_PRESENTATION.map(line => truncate(line, width))}
					term={{ role: INSPECTOR_ROLE, inspector: model }}
					{...handlers}
				/>
			);
		}
		const first = untrack(() => model.presentation())!;
		return (
			<shell
				// A fresh object per change: the host may update the presentation in place.
				presentation={() => ({ ...(model.presentation() ?? first) })}
				lang="bash"
				inspector
				replayEpoch={() => model.host.replayEpoch()}
				liveOrigin={() => model.host.liveOrigin()}
				// A fresh object per change as well: the terminal look reads the model while it paints.
				term={() => (model.presentation(), { role: INSPECTOR_ROLE, inspector: model })}
				{...handlers}
			/>
		);
	};
}
