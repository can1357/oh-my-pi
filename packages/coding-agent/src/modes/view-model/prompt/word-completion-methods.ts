/** Values of the `spelling.autocomplete` setting. */
export const WORD_COMPLETION_METHODS = ["off", "auto", "ngram", "smollm", "apple"] as const;

/** Configured word-completion engine; `off` disables ghost text. */
export type WordCompletionMethod = (typeof WORD_COMPLETION_METHODS)[number];

/** An engine that answers (every method but `off`). */
export type WordCompletionEngine = Exclude<WordCompletionMethod, "off">;
