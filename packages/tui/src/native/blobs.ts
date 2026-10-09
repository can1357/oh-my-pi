/**
 * Content-addressed binary blobs (images) for `image` nodes.
 *
 * `describe()` registers the bytes and puts the returned id in `image.p.blob`;
 * the native backend delivers each referenced blob once per terminal
 * connection (asking the terminal first which it holds, or through its blob
 * cache), else uploads it with verb `b` before the frame that first
 * references it.
 */
import type { TspProps } from "@oh-my-pi/pi-wire";
import { getImageDimensions } from "../terminal-capabilities";
import { node } from "./describe";
import type { NativeNode } from "./node";

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

/** `image` nodes for base64 payloads, one per slot key, rebuilt only when the slot's payload changes. */
export class NativeImageCache {
	#entries = new Map<string, { data: string; node: NativeNode }>();

	get(key: string, data: string, mimeType: string): NativeNode {
		const cached = this.#entries.get(key);
		if (cached?.data === data) return cached.node;
		const image = base64ImageNode(data, mimeType, { alt: mimeType }, key);
		this.#entries.set(key, { data, node: image });
		return image;
	}
}
