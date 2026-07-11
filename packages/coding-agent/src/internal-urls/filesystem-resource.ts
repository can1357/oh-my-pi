import * as fs from "node:fs/promises";
import type { InternalResource } from "./types";

/**
 * Builds a text resource for a filesystem directory resolved by an internal URL handler.
 *
 * The resource is flagged immutable so the read tool never mints hashline edit
 * anchors against a directory listing — only file resources from the same
 * handler stay editable.
 */
export async function buildDirectoryResource(
	url: string,
	directoryPath: string,
	notes?: string[],
): Promise<InternalResource> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	entries.sort((a, b) => {
		const directoryOrder = Number(b.isDirectory()) - Number(a.isDirectory());
		return directoryOrder || a.name.localeCompare(b.name);
	});
	const content =
		entries.length === 0
			? "(empty directory)"
			: entries.map(e => `${e.name}${e.isDirectory() ? "/" : ""}`).join("\n");
	return {
		url,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: directoryPath,
		immutable: true,
		...(notes ? { notes } : {}),
	};
}
