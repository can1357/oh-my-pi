/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Attached and produced images as `image` nodes: the bytes go to the blob
 * registry once (the node names them by content address) and the header's
 * pixel size rides along so a terminal can lay the image out before it
 * decodes it. The terminal backend draws images where the terminal supports
 * a graphics protocol; transcript looks fall back to a `[Image: mime]` line.
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
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
			term={props.term}
		/>
	);
}
