/**
 * Content-addressed binary blobs (images) for `image` nodes.
 *
 * `describe()` registers the bytes and puts the returned id in `image.p.blob`;
 * the native backend delivers each referenced blob once per terminal
 * connection (asking the terminal first which it holds, or through its blob
 * cache), else uploads it with verb `b` before the frame that first
 * references it.
 */
import * as url from "node:url";
import type { TspProps } from "@oh-my-pi/pi-wire";
import { resolveImageOptions } from "../render/render-utils";
import { getImageDimensions } from "../terminal-capabilities";
import { node } from "./describe";
import { imageLinksEnabled, transcriptImageLink } from "../prompt/image-references";
import type { NativeChild, NativeNode } from "./node";

export interface NativeBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

const blobs = new Map<string, WeakRef<NativeBlob>>();
const registeredBlobs = new Map<string, NativeBlob>();
const releasedBlobs = new FinalizationRegistry<{ id: string; reference: WeakRef<NativeBlob> }>(({ id, reference }) => {
	if (blobs.get(id) === reference) blobs.delete(id);
});
// Props spreads preserve ownership; wire serialization omits symbol keys.
const kBlob = Symbol("native.blob");
// Registration usually repeats with the same bytes object on every describe;
// the tag skips rehashing it.
const kBlobId = Symbol("native.blobId");

interface BlobTagged {
	[kBlobId]?: string;
}

function getOrCreateBlob(bytes: Uint8Array, mime: string): NativeBlob {
	const known = (bytes as BlobTagged)[kBlobId];
	const id = known ?? new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	(bytes as BlobTagged)[kBlobId] = id;
	let blob = blobs.get(id)?.deref();
	if (!blob) {
		blob = { id, mime, bytes };
		const reference = new WeakRef(blob);
		blobs.set(id, reference);
		releasedBlobs.register(blob, { id, reference });
	}
	return blob;
}

/** Register bytes for process-lifetime, id-only use. Prefer {@link nativeImageNode} for owned images. */
export function registerNativeBlob(bytes: Uint8Array, mime: string): string {
	const blob = getOrCreateBlob(bytes, mime);
	registeredBlobs.set(blob.id, blob);
	return blob.id;
}

/** A registered blob by id. */
export function getNativeBlob(id: string): NativeBlob | undefined {
	return blobs.get(id)?.deref();
}

/** An image whose props own its bytes, including while hidden, unmounted, or awaiting upload. */
export function nativeImageNode(
	bytes: Uint8Array,
	mime: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin">,
	key?: string,
): NativeNode {
	const blob = getOrCreateBlob(bytes, mime);
	const props = { ...p, blob: blob.id, [kBlob]: blob };
	return node("image", props, undefined, key);
}

/**
 * An `image` node for a base64 payload: the bytes are registered as a blob and
 * the pixel size probed from the header. Decoding and hashing cost real time,
 * so callers cache the node per payload ({@link NativeImageCache}).
 */
export function base64ImageNode(
	data: string,
	mimeType: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin" | "w" | "h">,
	key?: string,
): NativeNode {
	const size = getImageDimensions(data, mimeType);
	return nativeImageNode(
		Buffer.from(data, "base64"),
		mimeType,
		size ? { ...p, w: size.widthPx, h: size.heightPx } : p,
		key,
	);
}

/**
 * Props that make an `image` node open the file at `filePath` (as a `file://` URL, the TSP
 * open-target form): a click zooms the image in the terminal, and the file opens from its
 * context menu. Empty without a file.
 */
export function openableImageProps(filePath: string | undefined): Pick<TspProps<"image">, "href" | "actions"> {
	return filePath ? { href: url.pathToFileURL(filePath).href, actions: { menu: ["open"] } } : {};
}

/**
 * `image` nodes for base64 payloads, one per slot key, rebuilt only when the slot's payload
 * or the link policy changes. Each opens its file (`sourcePath`, else a blob copy).
 */
export class NativeImageCache {
	#entries = new Map<string, { data: string; linked: boolean; node: NativeNode }>();

	get(key: string, data: string, mimeType: string, sourcePath?: string): NativeNode {
		const linked = imageLinksEnabled();
		const cached = this.#entries.get(key);
		if (cached?.data === data && cached.linked === linked) return cached.node;
		const open = openableImageProps(transcriptImageLink({ data, mimeType }, sourcePath));
		const image = base64ImageNode(data, mimeType, { alt: mimeType, ...open }, key);
		this.#entries.set(key, { data, linked, node: image });
		return image;
	}
}

/** The disk file a tool result's image was read from (`read` details `mediaPath`), when it has one. */
export function readMediaPath(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const mediaPath = (details as { mediaPath?: unknown }).mediaPath;
	return typeof mediaPath === "string" && mediaPath.length > 0 ? mediaPath : undefined;
}

/**
 * A `media` node the host loads by path, capped at the inline image preview
 * height. Callers check `cx.supports("media")` first.
 */
export function nativeMediaNode(path: string, key: string): NativeNode {
	const maxRows = resolveImageOptions().maxHeightCells;
	return node("media", { path, max: maxRows && maxRows > 0 ? { h: `${maxRows}lines` } : undefined }, undefined, key);
}

/** Blob ids of the `image` nodes and paths of the `media` nodes under `children` (described nodes only). */
export function shownMedia(children: readonly NativeChild[] | undefined): { blobs: Set<string>; paths: Set<string> } {
	const shown = { blobs: new Set<string>(), paths: new Set<string>() };
	const visit = (list: readonly NativeChild[] | undefined): void => {
		for (const child of list ?? []) {
			if (!("k" in child)) continue;
			const p = child.p as { blob?: unknown; path?: unknown } | undefined;
			if (child.k === "image" && typeof p?.blob === "string") shown.blobs.add(p.blob);
			else if (child.k === "media" && typeof p?.path === "string") shown.paths.add(p.path);
			visit(child.c);
		}
	};
	visit(children);
	return shown;
}
