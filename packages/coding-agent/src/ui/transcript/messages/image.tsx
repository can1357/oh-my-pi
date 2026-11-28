/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Attached and produced images as `image` nodes: the bytes go to the blob
 * registry once (the node names them by content address) and the header's
 * pixel size rides along so a terminal can lay the image out before it
 * decodes it. The terminal backend draws images where the terminal supports
 * a graphics protocol; transcript looks fall back to a `[Image: mime]` line.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { computed, createRoot, effect, type Reactive, read, signal } from "@oh-my-pi/pi-tui/reactive";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { TspImageProps } from "@oh-my-pi/pi-wire";
import { readImageHeaderDimensions } from "../../../utils/image-resize";

/** An image content part (base64 bytes). */
export interface ImagePart {
	readonly type?: "image";
	readonly data: string;
	readonly mimeType: string;
}

const blobIds = new Map<string, string>();

/** The blob id of a base64 payload (registered once). */
export function imageBlob(image: ImagePart): string {
	const cacheKey = `${image.mimeType}:${image.data.length}:${Bun.hash(image.data)}`;
	let id = blobIds.get(cacheKey);
	if (id === undefined) {
		id = registerBlob(Buffer.from(image.data, "base64"), image.mimeType);
		blobIds.set(cacheKey, id);
	}
	return id;
}

/** Props that let a terminal open `filePath` from the image (a click zooms; the menu opens the file). */
export function openableImage(filePath: string | undefined): {
	href?: string;
	actions?: { menu: string[] };
} {
	if (!filePath) return {};
	try {
		return {
			href: Bun.pathToFileURL(filePath).href,
			actions: { menu: ["open"] },
		};
	} catch {
		return {};
	}
}

/** Default maximum width of a transcript image, in terminal columns. */
export const DEFAULT_INLINE_IMAGE_COLUMNS = 100;

/** Default maximum height of a transcript image, in terminal rows. */
export const DEFAULT_INLINE_IMAGE_ROWS = 20;

const inlineImageLimits = signal({ columns: DEFAULT_INLINE_IMAGE_COLUMNS, rows: DEFAULT_INLINE_IMAGE_ROWS });

/** Set the process-wide transcript image limits. */
export const setInlineImageLimits = inlineImageLimits.set;

interface InlineImageBounds {
	readonly maxColumns?: number;
	readonly maxRows?: number;
}

const inlineImageBounds = signal<InlineImageBounds>(resolveBounds(inlineImageLimits.peek(), undefined));
let stopFollowing: (() => void) | undefined;

function resolveBounds(
	limits: { readonly columns: number; readonly rows: number },
	viewportRows: number | undefined,
): InlineImageBounds {
	const viewportLimit = Math.floor((viewportRows ?? 0) * 0.6);
	const { columns, rows } = limits;
	const maxRows = rows > 0 ? (viewportLimit > 0 ? Math.min(rows, viewportLimit) : rows) : viewportLimit || undefined;
	return { maxColumns: columns > 0 ? columns : undefined, maxRows };
}

/** Follow the active shell's viewport and image settings for all transcript views it draws. */
export function followInlineImageLimits(viewportRows: () => number | undefined): () => void {
	stopFollowing?.();
	const stop = createRoot(dispose => {
		effect(() => {
			const next = resolveBounds(inlineImageLimits(), viewportRows());
			const current = inlineImageBounds.peek();
			if (next.maxColumns !== current.maxColumns || next.maxRows !== current.maxRows) inlineImageBounds.set(next);
		});
		return dispose;
	});
	stopFollowing = stop;
	return () => {
		if (stopFollowing !== stop) return;
		stopFollowing = undefined;
		stop();
		inlineImageBounds.set(resolveBounds(inlineImageLimits.peek(), undefined));
	};
}

const inlineImageMax = computed<TspImageProps["max"]>(() => {
	const { maxColumns, maxRows } = inlineImageBounds();
	return {
		w: maxColumns === undefined ? undefined : `${maxColumns}ch`,
		h: maxRows === undefined ? undefined : `${maxRows}lines`,
	};
});

/** Terminal-only bounds, keeping native blob images at their natural size. */
export function inlineImageTerm(facts?: Readonly<Record<string, unknown>>): () => Readonly<Record<string, unknown>> {
	return () => ({ ...facts, max: inlineImageMax() });
}

function inlineMediaMax(): TspImageProps["max"] {
	const { maxRows: rows } = inlineImageBounds();
	return rows === undefined ? undefined : { h: `${rows}lines` };
}

/** A file preview, for callers whose native host supports `media`. */
export function InlineMedia(props: { readonly path: Reactive<string>; readonly nodeKey: string }): JSXNode {
	return <media key={props.nodeKey} path={props.path} max={inlineMediaMax} />;
}

/** An `image` node for a base64 payload. */
export function ImageNode(props: {
	readonly image: ImagePart;
	readonly nodeKey?: string;
	readonly alt?: string;
	readonly title?: string;
	/** The file the image opens (undefined: not openable). */
	readonly path?: Reactive<string | undefined>;
	/** Terminal-only look facts. */
	readonly term?: Readonly<Record<string, unknown>>;
}): JSXNode {
	const size = readImageHeaderDimensions(Buffer.from(props.image.data, "base64"));
	return (
		<image
			key={props.nodeKey}
			blob={imageBlob(props.image)}
			w={size?.width}
			h={size?.height}
			alt={props.alt}
			title={props.title}
			href={() => openableImage(read(props.path)).href}
			actions={() => openableImage(read(props.path)).actions}
			term={inlineImageTerm(props.term)}
		/>
	);
}
