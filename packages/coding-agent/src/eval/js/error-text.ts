import * as path from "node:path";
import { getPackageDir } from "../../config";

/**
 * The tree omp runs from: the `node_modules` holding an installed omp, or a source checkout's root, so frames
 * in omp's own code and in its dependencies both fall under it. Compiled binaries run from `$bunfs` instead.
 */
const OMP_ROOT = (() => {
	const packageDir = getPackageDir();
	return packageDir ? path.dirname(path.dirname(packageDir)) : undefined;
})();

/** Frame locations that are never the cell's code: engine internals, omp's preludes, a compiled omp. */
const HOST_LOCATION = /^(?:native\b|unknown$|node:|bun:|\[eval-prelude:)|\$bunfs|~BUN/;
const FRAME_LINE = /^\s+at (?:.*\((.*)\)|(.*))$/;

/**
 * The text a failed cell prints for an uncaught error: its stack without the frames from omp's own runtime,
 * its dependencies and engine internals, which say nothing about the cell. Message lines, the cell's frames
 * (with line and column), functions the cell sent to the page or worker and modules it imported are kept,
 * and one line says how many frames were hidden; the error's own `stack` is left whole.
 */
export function formatCellError(stack: string, ompRoot: string | undefined = OMP_ROOT): string {
	const rootPrefix = ompRoot === undefined ? undefined : ompRoot.endsWith(path.sep) ? ompRoot : ompRoot + path.sep;
	const kept: string[] = [];
	let hidden = 0;
	for (const line of stack.split("\n")) {
		const frame = FRAME_LINE.exec(line);
		const location = frame ? (frame[1] ?? frame[2]).trim() : undefined;
		if (
			location !== undefined &&
			(HOST_LOCATION.test(location) || (rootPrefix !== undefined && location.startsWith(rootPrefix)))
		) {
			hidden++;
			continue;
		}
		kept.push(line);
	}
	if (hidden === 0) return stack;
	kept.push(
		`    (${hidden} omp frame${hidden === 1 ? "" : "s"} hidden; catch the error and print e.stack to see them)`,
	);
	return kept.join("\n");
}
