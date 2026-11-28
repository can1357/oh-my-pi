import { vi } from "bun:test";

/**
 * Make `process.getuid` give no account id until `vi.restoreAllMocks()`, as on
 * Windows, which has no `getuid`: the code reads it as `process.getuid?.()`,
 * so a spy that answers `undefined` takes the same path. Where `getuid` is
 * absent the code already gets no account id, and there is no method to spy
 * on, so nothing is installed.
 */
export function withoutAccountId(): void {
	if (typeof process.getuid !== "function") return;
	// `getuid` is typed to answer a number; the platform this stands for answers none.
	vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
}
