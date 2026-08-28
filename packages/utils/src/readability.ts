/** Behavior-compatible reimplementation of @mozilla/readability's used surface. */

export { Readability } from "./readability/readability";
export { isProbablyReaderable, type ReaderableOptions } from "./readability/readerable";
export type {
	ReadabilityArticle,
	ReadabilityDocument,
	ReadabilityElement,
	ReadabilityNode,
	ReadabilityOptions,
} from "./readability/types";
