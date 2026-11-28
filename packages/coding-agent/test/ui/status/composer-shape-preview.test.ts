/**
 * `overlays/composer-shape-preview` corpus: every composer shape's chrome
 * with and without a status line. The capture's status stand-in names what
 * the shape asked for (`top omp 74`, `band omp`, `chip omp`, `bar left omp 80`),
 * so the stages pin where each shape attaches the status and at what width.
 */
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { ComposerShapePreview, PREVIEW_TITLE } from "../../../src/ui/overlays/composer-shape-preview";
import type { StatusChrome } from "../../../src/ui/status/status-line";
import "../../../src/ui/styles/composer";
import "../../../src/ui/styles/overlays/composer-shape-preview";
import { stagedSuite } from "./corpus-suite";

/** The capture's status stand-in. */
const STAND_IN: StatusChrome = {
	composerStatus(_cx, attachment, width) {
		const t = PREVIEW_TITLE;
		if (attachment === "top-border")
			return { content: `top ${t} ${width}`, width: 8 + String(width).length + t.length };
		if (attachment === "top-band") return { content: `band ${t}`, width: 5 + t.length };
		return { content: `chip ${t}`, width: 5 + t.length };
	},
	bottomBar: (_cx, groups, width) => `bar ${groups} ${PREVIEW_TITLE} ${width}`,
};

stagedSuite("overlays/composer-shape-preview", corpusCase => {
	const withStatus = corpusCase.case === "status";
	const shape = signal(withStatus ? "box" : "band");
	return {
		tree: jsx(ComposerShapePreview, { shape, ...(withStatus ? { status: STAND_IN } : {}) }),
		step(label) {
			if (label === "same") return;
			if (label === "unknown") return shape.set("nope");
			const match = /^shape (\w+)$/.exec(label);
			if (!match) throw new Error(`composer-shape-preview: unknown stage ${label}`);
			shape.set(match[1]!);
		},
	};
});
