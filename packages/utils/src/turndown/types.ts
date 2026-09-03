/** Behavior-compatible reimplementation of turndown's used surface. */

/** A DOM-shaped node accepted by conversion rules. */
export interface TurndownNode {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly parentNode: TurndownNode | null;
	readonly childNodes: ArrayLike<TurndownNode>;
	readonly children: ArrayLike<TurndownNode>;
	readonly firstChild: TurndownNode | null;
	readonly lastChild: TurndownNode | null;
	readonly nextSibling: TurndownNode | null;
	readonly previousSibling: TurndownNode | null;
	readonly textContent: string | null;
	readonly outerHTML?: string;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
}

/** Options supported by the HTML-to-Markdown converter. */
export interface TurndownOptions {
	headingStyle?: "setext" | "atx";
	hr?: string;
	bulletListMarker?: "*" | "-" | "+";
	codeBlockStyle?: "indented" | "fenced";
	fence?: string;
	emDelimiter?: "_" | "*";
	strongDelimiter?: "**" | "__";
	linkStyle?: "inlined" | "referenced";
	linkReferenceStyle?: "full" | "collapsed" | "shortcut";
	preformattedCode?: boolean;
	blankReplacement?: ReplacementFunction;
	keepReplacement?: ReplacementFunction;
	defaultReplacement?: ReplacementFunction;
}

/** Fully resolved options passed to replacement callbacks. */
export interface ResolvedTurndownOptions {
	headingStyle: "setext" | "atx";
	hr: string;
	bulletListMarker: "*" | "-" | "+";
	codeBlockStyle: "indented" | "fenced";
	fence: string;
	emDelimiter: "_" | "*";
	strongDelimiter: "**" | "__";
	linkStyle: "inlined" | "referenced";
	linkReferenceStyle: "full" | "collapsed" | "shortcut";
	preformattedCode: boolean;
	blankReplacement?: ReplacementFunction;
	keepReplacement?: ReplacementFunction;
	defaultReplacement?: ReplacementFunction;
}

/** A tag name, list of tag names, or predicate selecting nodes for a rule. */
export type RuleFilter =
	| string
	| readonly string[]
	| ((node: TurndownNode, options: ResolvedTurndownOptions) => boolean);

/** Produces Markdown for a matched node and its already-converted children. */
export type ReplacementFunction = (content: string, node: TurndownNode, options: ResolvedTurndownOptions) => string;

/** A named conversion rule accepted by `addRule`. */
export interface TurndownRule {
	filter: RuleFilter;
	replacement: ReplacementFunction;
}

/** A plugin that installs one or more conversion rules. */
export type TurndownPlugin = (service: TurndownServiceLike) => void;

/** Structural service surface available to plugins. */
export interface TurndownServiceLike {
	readonly options: ResolvedTurndownOptions;
	addRule(key: string, rule: TurndownRule): this;
	convertChildren(node: TurndownNode): string;
	keep(filter: RuleFilter): this;
	remove(filter: RuleFilter): this;
	turndown(input: string | TurndownNode): string;
	escape(text: string): string;
}
