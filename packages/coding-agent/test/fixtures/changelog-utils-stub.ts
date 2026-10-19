import packageJson from "../../package.json" with { type: "json" };

export const VERSION = packageJson.version;
export const getLastChangelogVersionPath = (): string => "";
export const getChangelogPath = (): string | undefined => undefined;
export const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
export const logger = { error: () => {}, warn: () => {} };

// `@oh-my-pi/pi-utils/marked` is a separate deep-import (not the barrel), only
// used by `summarizeChangelogEntries()` — which these path-resolution probes
// never call. Stubbed so `Bun.build`'s bundle/compile graph doesn't have to
// resolve the real lexer for an entry point that never exercises it.
export const Lexer = { lex: (): unknown[] => [] };
