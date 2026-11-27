/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The composer-shape picker's preview: a read-only prompt in the highlighted
 * shape's chrome, with the live status line where that shape puts it (top
 * border, band, chip on the top rule, bottom bar).
 *
 * A native terminal draws the composer itself: natively the preview names
 * the shape over a read-only prompt. Terminal look:
 * `src/ui/styles/overlays/composer-shape-preview.ts`.
 *
 * The status comes from the session's status line (`createStatusLine(…).chrome`);
 * an unnamed session previews its title as {@link PREVIEW_TITLE}.
 */
import { type Accessor, type JSXNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { StatusChrome } from "../status/status-line";
import { composerShape } from "../styles/composer/shapes";

/** Stand-in session title a preview shows while the session is unnamed. */
export const PREVIEW_TITLE = "omp";

/** The prompt the preview shows. */
export const PREVIEW_PROMPT = "Ask anything, edit files, run tools";

/** Terminal look facts of the preview. */
export type ComposerShapePreviewLook = {
	readonly shape: string;
	readonly status?: StatusChrome;
};

export interface ComposerShapePreviewProps {
	/** Shape id (unknown ids draw as `box`). */
	readonly shape: Accessor<string>;
	/** The live status line's chrome; omitted, the chrome shows no status. */
	readonly status?: StatusChrome;
}

export function ComposerShapePreview(props: ComposerShapePreviewProps): JSXNode {
	const caption = (): TspSpan[] => {
		const id = props.shape();
		const shape = composerShape(id);
		const known = shape.id === id;
		const spans: TspSpan[] = [{ t: (known && shape.label) || id, s: "strong" }];
		if (known && shape.description) spans.push({ t: ` · ${shape.description}`, s: "muted" });
		return spans;
	};
	return (
		<col
			role="omp.preview.composer-shape"
			gap="xs"
			term={(): ComposerShapePreviewLook => ({
				shape: props.shape(),
				...(props.status ? { status: props.status } : {}),
			})}
		>
			<text spans={[{ t: "Preview:", s: "muted" }]} />
			<editor placeholder={PREVIEW_PROMPT} readonly maxLines={1} />
			<text spans={caption} wrap="word" />
		</col>
	);
}
