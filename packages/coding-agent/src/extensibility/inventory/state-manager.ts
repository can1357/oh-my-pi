import { FuzzyQuery, FuzzyText } from "../../utils/fuzzy";
import { type Extension } from "./types";

/** Searchable fields an extension's cached {@link FuzzyText} was built from. */
interface ExtensionSearchMemo {
	name: string;
	displayName: string;
	description: string | undefined;
	trigger: string | undefined;
	providerName: string;
	kind: string;
	text: FuzzyText;
}

/** Prepared search text per extension; rebuilt if any searchable field changes. */
const extensionSearchCache = new WeakMap<Extension, ExtensionSearchMemo>();

function extensionSearchText(ext: Extension): FuzzyText {
	const memo = extensionSearchCache.get(ext);
	if (
		memo !== undefined &&
		memo.name === ext.name &&
		memo.displayName === ext.displayName &&
		memo.description === ext.description &&
		memo.trigger === ext.trigger &&
		memo.providerName === ext.source.providerName &&
		memo.kind === ext.kind
	) {
		return memo.text;
	}
	const text = new FuzzyText(
		[ext.name, ext.displayName, ext.description || "", ext.trigger || "", ext.source.providerName, ext.kind].join(
			" ",
		),
	);
	extensionSearchCache.set(ext, {
		name: ext.name,
		displayName: ext.displayName,
		description: ext.description,
		trigger: ext.trigger,
		providerName: ext.source.providerName,
		kind: ext.kind,
		text,
	});
	return text;
}

/**
 * Apply fuzzy filter to extensions.
 */
export function applyFilter(extensions: Extension[], query: string): Extension[] {
	if (!query.trim()) {
		return extensions;
	}

	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map(token => new FuzzyQuery(token));
	if (tokens.length === 0) {
		return extensions;
	}

	return extensions.filter(ext => {
		const searchable = extensionSearchText(ext);
		return tokens.every(token => token.match(searchable).matches);
	});
}
