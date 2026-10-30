import { afterEach, beforeEach } from "bun:test";
import { __resetShellConfigCacheForTests } from "@oh-my-pi/pi-utils/procmgr";
import { restoreEnvValue } from "./settings-test-state";

/** The variables the shell config reads its command prefix from (`procmgr.getShellPrefix`). */
const SHELL_PREFIX_KEYS = ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"] as const;

/**
 * Runs the calling file's cases without a shell prefix exported by the shell that
 * started the suite. The prefix is prepended to every command line a shell runs, so
 * an agent shell's `set +e +u +o pipefail;` changes the exact line a case asserts,
 * clears options a case set on a persistent session, and is an error under `/bin/sh`.
 * Shell configs are cached with the prefix they were built from, so the cache is
 * dropped on both sides of each case.
 */
export function withoutAmbientShellPrefix(): void {
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of SHELL_PREFIX_KEYS) {
			saved.set(key, process.env[key]);
			restoreEnvValue(key, undefined);
		}
		__resetShellConfigCacheForTests();
	});
	afterEach(() => {
		for (const key of SHELL_PREFIX_KEYS) restoreEnvValue(key, saved.get(key));
		__resetShellConfigCacheForTests();
	});
}
