/**
 * Regression test for #2935: the plugins docs advertise `omp list` / `omp remove`
 * as top-level commands, but only `omp install` is registered. Before the fix,
 * `resolveCliArgv(["list"])` rewrote the bare verb to `["launch", "list"]`, so
 * `omp list` silently started an interactive agent session with "list" as the
 * initial LLM prompt instead of managing plugins (the real command is
 * `omp plugin list`). Same footgun for `omp remove`.
 *
 * These tests pin the chosen bugfix: a bare, single-arg documented plugin verb
 * yields a helpful hint pointing at the real `omp plugin <action>` command
 * rather than leaking the word to the model — while multi-word invocations that
 * merely happen to begin with one of these verbs still fall through to `launch`
 * so genuine prompts are unaffected.
 *
 * Imported via a relative path (not the `@pk-nerdsaver-ai/pi-coding-agent` alias) so the
 * assertions exercise this checkout's `cli-commands.ts` directly.
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "../src/cli-commands";

describe("documented-but-unregistered plugin verbs do not leak to launch (#2935)", () => {
	test("bare `omp list` hints at `omp plugin list` instead of launching with 'list' as the prompt", () => {
		const result = resolveCliArgv(["list"]);
		// Must NOT be the old silent-launch behavior.
		expect(result).not.toEqual({ argv: ["launch", "list"] });
		expect(result).not.toHaveProperty("argv");
		// Must point at the real command.
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("omp plugin list");
	});

	test("bare `omp remove` hints at `omp plugin uninstall` instead of launching with 'remove' as the prompt", () => {
		const result = resolveCliArgv(["remove"]);
		expect(result).not.toEqual({ argv: ["launch", "remove"] });
		expect(result).not.toHaveProperty("argv");
		expect(result).toHaveProperty("error");
		expect("error" in result && result.error).toContain("omp plugin uninstall");
	});

	test("genuine multi-word prompts beginning with these verbs still route to launch", () => {
		// A real prompt that happens to start with `list`/`remove` must not be hijacked.
		expect(resolveCliArgv(["list", "all", "my", "files"])).toEqual({
			argv: ["launch", "list", "all", "my", "files"],
		});
		expect(resolveCliArgv(["remove", "the", "unused", "import"])).toEqual({
			argv: ["launch", "remove", "the", "unused", "import"],
		});
	});

	test("the hint path does not pretend these are real subcommands", () => {
		// We surface guidance; we do not invent new top-level commands.
		expect(isSubcommand("list")).toBe(false);
		expect(isSubcommand("remove")).toBe(false);
	});
});
