/**
 * Mouse steps for the app suites: decode the recorded SGR sequences and
 * deliver each event the way the terminal backend does, to the widget of
 * the node whose painted hit region holds the cell (at width 80).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { widgetFor, widgetState } from "@oh-my-pi/pi-tui/term/widgets";
import { signal, type Signal } from "@oh-my-pi/pi-tui";
import type { AppDriver } from "../harness";

const WIDTH = 80;

/** Deliver raw SGR mouse sequences to the hit regions of the root's painted block. */
export function mouse(driver: AppDriver, ...sequences: string[]): void {
	for (const sequence of sequences) {
		const event = decodeMouse(sequence);
		if (!event) throw new Error(`undecodable mouse sequence ${JSON.stringify(sequence)}`);
		const block = paintNode(driver.env, driver.root, WIDTH);
		const hit = [...(block.hits ?? [])]
			.reverse()
			.find(
				h =>
					event.row >= h.row && event.row < h.row + h.height && event.col >= h.col && event.col < h.col + h.width,
			);
		if (!hit) continue;
		const node: UiNode = hit.node;
		widgetFor(node)?.mouse?.(
			node,
			event,
			{ row: event.row - hit.row, col: event.col - hit.col },
			{
				emit: () => {},
				state: <T>(name: string, init: () => T): Signal<T> => {
					const map = widgetState(node);
					let value = map.get(name) as Signal<T> | undefined;
					if (!value) {
						value = signal(init());
						map.set(name, value as Signal<unknown>);
					}
					return value;
				},
				keypath: "",
				focus: next => driver.focus(next),
				pageRows: 40,
			},
			hit,
		);
	}
}

/** SGR press + release at a 0-based cell. */
export const click = (row: number, col: number): string[] => [
	`\x1b[<0;${col + 1};${row + 1}M`,
	`\x1b[<0;${col + 1};${row + 1}m`,
];
