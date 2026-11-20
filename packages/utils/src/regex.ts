/** `RegExp` that cannot backtrack catastrophically, with JavaScript's own matches; see {@link LinearRegExp}. */
export type { RegexStream } from "./regex/dfa";
export * from "./regex/linear-regexp";
export { countCapturingGroups } from "./regex/parse";
