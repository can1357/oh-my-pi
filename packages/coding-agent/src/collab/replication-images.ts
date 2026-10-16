/**
 * Loadable image placeholders for host→guest collab snapshots (issue #9469).
 *
 * A large snapshot sheds its images before it ships. `stripImagesFromMessage`
 * filters image blocks out and leaves nothing to fetch; here every image is
 * listed in the entry's `collabElided` so a guest can fetch the original from
 * the host by path. Where the image sat among text (content arrays, a file
 * mention's `image` slot) it is replaced **at the same position** by a text
 * block naming its type and size, which old guests render like any other.
 * Image-only arrays (`bashExecution.images`, tool-result `details.images`)
 * cannot hold text — renderers draw every element as an image — so their
 * images are removed and the records say `removed: true`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { CollabElided } from "@oh-my-pi/pi-wire";
import type { ReplicatedEntry } from "./replication-shrink";

/**
 * Hash of a trimmed value's JSON (`JSON.stringify` of the original value), as
 * carried in `collabElided[].hash` and re-checked by the host on fetch.
 */
export function collabValueHash(json: string): string {
	return Bun.hash(json).toString(16);
}

/**
 * Changed object in a detached copy → the original value it stood for: a text
 * placeholder → the image block it replaced, an image-only array whose images
 * were removed → the array as it was.
 *
 * Written here on the host's snapshot copy. Hashes must describe the
 * *original* entry the host fetches from, so the shrinker serializes any value
 * that contains such an object (a clipped array, the whole entry) with the
 * original put back.
 */
export const elidedOriginals = new WeakMap<object, unknown>();

function isImageBlock(value: unknown): value is { type: "image"; mimeType?: unknown } {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type === "image";
}

/** The `kind: "image"` record of `image`, which sits at `path` in the original entry. */
function imageRecord(image: { mimeType?: unknown }, path: (string | number)[]): CollabElided {
	const json = JSON.stringify(image);
	const record: CollabElided = {
		path,
		kind: "image",
		bytes: Buffer.byteLength(json, "utf8"),
		hash: collabValueHash(json),
	};
	if (typeof image.mimeType === "string") record.mimeType = image.mimeType;
	return record;
}

/**
 * The text block that stands in for `image` at `path`. Registered in
 * {@link elidedOriginals}, so hashes of any value containing the placeholder
 * (a clipped array, the whole entry) still describe the original the host
 * serves.
 */
function imagePlaceholder(
	image: { mimeType?: unknown },
	path: (string | number)[],
	elided: CollabElided[],
): TextContent {
	const record = imageRecord(image, path);
	elided.push(record);
	const placeholder: TextContent = {
		type: "text",
		text: `[image ${record.mimeType ?? "unknown type"}, ${formatBytes(record.bytes)} not sent]`,
	};
	elidedOriginals.set(placeholder, image);
	return placeholder;
}

/** Replace every image element of the mixed array `items` in place; `path` addresses the array. */
function placeholdImageElements(items: unknown, path: (string | number)[], elided: CollabElided[]): void {
	if (!Array.isArray(items)) return;
	for (let i = 0; i < items.length; i++) {
		const item: unknown = items[i];
		if (isImageBlock(item)) items[i] = imagePlaceholder(item, [...path, i], elided);
	}
}

/**
 * Remove every image element of the image-only array `items`, keeping the
 * array itself (its identity is the {@link elidedOriginals} key that restores
 * it for hashing). Records keep the original indices.
 */
function removeImageElements(items: unknown, path: (string | number)[], elided: CollabElided[]): void {
	if (!Array.isArray(items) || !items.some(isImageBlock)) return;
	const original = items.slice();
	items.length = 0;
	for (let i = 0; i < original.length; i++) {
		const item: unknown = original[i];
		if (isImageBlock(item)) elided.push({ ...imageRecord(item, [...path, i]), removed: true });
		else items.push(item);
	}
	elidedOriginals.set(items, original);
}

/**
 * Take every image out of `entry`, in place, and append one `kind: "image"`
 * record per image to `entry.collabElided`. Returns the number taken out.
 *
 * Covers the shapes `stripImagesFromMessage` strips — `content` of every role
 * that carries `ImageContent`, tool-result `details.images`, manual Bash
 * `images`, and file-mention `files[i].image` — plus `custom_message` entry
 * content. MUST only be called on a detached copy (the host's snapshot copy):
 * the originals stay in the live session, which is what fetches are served
 * from. A detached copy has no message-cache identity, so unlike
 * `stripImagesFromMessage` there is nothing to invalidate.
 */
export function placeholdImagesForReplication(entry: ReplicatedEntry): number {
	const elided: CollabElided[] = [];
	if (entry.type === "custom_message") {
		placeholdImageElements(entry.content, ["content"], elided);
	} else if (entry.type === "message") {
		const message: AgentMessage = entry.message;
		switch (message.role) {
			case "user":
			case "developer":
			case "custom":
			case "hookMessage":
				placeholdImageElements(message.content, ["message", "content"], elided);
				break;
			case "toolResult":
				placeholdImageElements(message.content, ["message", "content"], elided);
				removeImageElements(
					(message.details as { images?: unknown } | null | undefined)?.images,
					["message", "details", "images"],
					elided,
				);
				break;
			case "bashExecution":
				removeImageElements(message.images, ["message", "images"], elided);
				break;
			case "fileMention":
				for (let i = 0; i < message.files.length; i++) {
					const file = message.files[i];
					if (!file?.image) continue;
					// The slot is typed `ImageContent`; the placeholder is a text
					// block, which is what a guest renders in its place.
					file.image = imagePlaceholder(
						file.image,
						["message", "files", i, "image"],
						elided,
					) as unknown as ImageContent;
				}
				break;
		}
	}
	if (elided.length > 0) entry.collabElided = [...(entry.collabElided ?? []), ...elided];
	return elided.length;
}
