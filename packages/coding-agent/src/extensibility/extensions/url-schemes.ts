/**
 * Internal URL schemes a session's extensions registered with `pi.registerUrlScheme`: a source
 * of the session's URL router (`SessionUrlSchemes`), read from the session's active extensions
 * on every lookup, so a suspended extension stops serving and a resumed one serves again.
 */
import type { UrlSchemeSource } from "../../internal-urls/router";
import type { ProtocolHandler } from "../../internal-urls/types";
import type { Extension } from "./types";

/** The URL schemes of `extensions()` (a session's active extensions, in load order); the earliest registration wins. */
export class ExtensionUrlSchemes implements UrlSchemeSource {
	readonly #extensions: () => readonly Extension[];

	constructor(extensions: () => readonly Extension[]) {
		this.#extensions = extensions;
	}

	get(scheme: string): ProtocolHandler | undefined {
		for (const extension of this.#extensions()) {
			const handler = extension.urlSchemes.get(scheme);
			if (handler) return handler;
		}
		return undefined;
	}

	*handlers(): Iterable<ProtocolHandler> {
		const seen = new Set<string>();
		for (const extension of this.#extensions()) {
			for (const [scheme, handler] of extension.urlSchemes) {
				if (seen.has(scheme)) continue;
				seen.add(scheme);
				yield handler;
			}
		}
	}
}

/**
 * One error per extension that registered a URL scheme an earlier extension in `extensions` (one
 * session's active extensions, in load order) already registered; the earlier one serves it.
 */
export function urlSchemeConflicts(extensions: readonly Extension[]): Array<{ path: string; error: string }> {
	const owners = new Map<string, Extension>();
	const errors: Array<{ path: string; error: string }> = [];
	for (const extension of extensions) {
		for (const scheme of extension.urlSchemes.keys()) {
			const owner = owners.get(scheme);
			if (!owner) {
				owners.set(scheme, extension);
				continue;
			}
			errors.push({
				path: extension.path,
				error: `URL scheme ${scheme}:// is already registered by ${owner.path}; this extension's handler is not used`,
			});
		}
	}
	return errors;
}
