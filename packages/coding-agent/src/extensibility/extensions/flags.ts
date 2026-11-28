import type { Extension, ExtensionFlag } from "./types";

/** Collect registered CLI flags in binding order; the last registration wins. */
export function aggregateExtensionFlags(extensions: readonly Extension[]): Map<string, ExtensionFlag> {
	const allFlags = new Map<string, ExtensionFlag>();
	for (const extension of extensions) {
		for (const [name, flag] of extension.flags) {
			allFlags.set(name, flag);
		}
	}
	return allFlags;
}
