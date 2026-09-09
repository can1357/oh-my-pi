import { describe, expect, it } from "bun:test";
import { parseArgs, reportUnrecognizedFlags } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyExtensionFlags } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";

// Regression coverage for issue #2459: `omp --list-models` (a stale flag) was
// silently consumed as a prompt instead of failing fast — the agent started a
// real session, connected to MCP, and hung waiting for the model. Any
// `--`-prefixed token that does not match a built-in OR an extension-registered
// flag must surface as a hard error before any session/MCP work happens.
describe("parseArgs — unrecognized flag tracking (#2459)", () => {
	it("records a bare unknown --flag instead of silently consuming it", () => {
		const parsed = parseArgs(["--list-models"]);

		expect(parsed.unrecognizedFlags).toEqual(["--list-models"]);
		expect(parsed.messages).toEqual([]);
	});

	it("records the unknown flag without letting `--flag=value` leak `value` into messages", () => {
		const parsed = parseArgs(["--list-models=verbose", "hello"]);

		expect(parsed.unrecognizedFlags).toEqual(["--list-models"]);
		// "verbose" was the spliced equals-value and gets dropped by the
		// unconsumed-equals-value guard; only the real positional survives.
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("records a typo in a known flag name and stops the value from binding", () => {
		const parsed = parseArgs(["--modle", "opus", "hi"]);

		expect(parsed.unrecognizedFlags).toEqual(["--modle"]);
		expect(parsed.model).toBeUndefined();
		// `opus` still leaks into messages here (no way to tell from one token
		// whether it was the flag's intended value); the caller exits on the
		// non-empty unrecognizedFlags before the prompt is ever sent.
		expect(parsed.messages).toEqual(["opus", "hi"]);
	});

	it("records an unknown short flag (`-x`)", () => {
		const parsed = parseArgs(["-x", "msg"]);

		expect(parsed.unrecognizedFlags).toEqual(["-x"]);
		expect(parsed.messages).toEqual(["msg"]);
	});

	it("leaves built-in flags out of unrecognizedFlags", () => {
		const parsed = parseArgs(["--print", "--model", "opus", "hi"]);

		expect(parsed.unrecognizedFlags).toEqual([]);
		expect(parsed.print).toBe(true);
		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["hi"]);
	});

	it("treats `-` (stdin marker) and `--` (POSIX separator) as non-flags, not unrecognized", () => {
		// `-` is a stdin marker by convention and shows up in pipelines; `--`
		// is the POSIX positional separator. Neither is a typo and neither
		// should fire the unknown-flag error.
		const dash = parseArgs(["-"]);
		expect(dash.unrecognizedFlags).toEqual([]);
		expect(dash.messages).toEqual(["-"]);

		const ddash = parseArgs(["--", "hello"]);
		expect(ddash.unrecognizedFlags).toEqual([]);
		// `--` itself is dropped (it is a separator, not a message), `hello`
		// is the positional.
		expect(ddash.messages).toEqual(["hello"]);
	});

	it("treats every token after `--` as a positional, even flag-shaped ones (#2461 review)", () => {
		// `omp -p -- --explain-this` must forward `--explain-this` as the
		// prompt body. Without after-separator semantics the unknown-flag guard
		// trips on it and the CLI exits before any session work.
		const parsed = parseArgs(["-p", "--", "--explain-this", "-x", "plain"]);
		expect(parsed.print).toBe(true);
		expect(parsed.unrecognizedFlags).toEqual([]);
		expect(parsed.messages).toEqual(["--explain-this", "-x", "plain"]);
	});

	it("does not expand `@foo` after `--` into a fileArg (POSIX positional semantics)", () => {
		// After `--`, application-level conventions like `@file` no longer
		// apply — the token is a literal positional. Lets users include `@`
		// strings (e.g. emails, handles) in prompts without file lookup.
		const parsed = parseArgs(["--", "@notes.md", "hello"]);
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.messages).toEqual(["@notes.md", "hello"]);
	});

	it("clears extension-registered flags from unrecognizedFlags on the post-extension reparse", () => {
		const argv = ["--spawn-peer", "reviewer", "review the diff"];

		// Startup parse: extensions not loaded yet → unknown.
		const startup = parseArgs(argv);
		expect(startup.unrecognizedFlags).toEqual(["--spawn-peer"]);

		// Extension-aware reparse: now recognized → unrecognizedFlags clear.
		const reparsed = parseArgs(argv, new Map([["spawn-peer", { type: "string" }]]));
		expect(reparsed.unrecognizedFlags).toEqual([]);
		expect(reparsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
		expect(reparsed.messages).toEqual(["review the diff"]);
	});

	it("keeps a genuine typo in unrecognizedFlags after an extension-aware reparse", () => {
		// `--spawn-peer` is an extension flag, `--list-models` is a typo. After
		// the extension-aware reparse only the typo remains and the caller
		// surfaces it.
		const argv = ["--spawn-peer", "reviewer", "--list-models"];
		const reparsed = parseArgs(argv, new Map([["spawn-peer", { type: "string" }]]));

		expect(reparsed.unrecognizedFlags).toEqual(["--list-models"]);
		expect(reparsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
	});

	it("propagates unrecognizedFlags through applyExtensionFlags so callers can surface them", () => {
		const runner = {
			getFlags: () => new Map<string, { type: "boolean" | "string" }>([["spawn-peer", { type: "string" }]]),
			setFlagValue: () => {},
		};
		const parsed = applyExtensionFlags(runner, ["--spawn-peer", "reviewer", "--typo"]);

		expect(parsed).not.toBeNull();
		expect(parsed?.unrecognizedFlags).toEqual(["--typo"]);
	});
});

describe("reportUnrecognizedFlags — stderr error surface", () => {
	function capture(unrecognized: string[]): { wrote: string[]; reported: boolean } {
		const wrote: string[] = [];
		const reported = reportUnrecognizedFlags({ unrecognizedFlags: unrecognized }, text => {
			wrote.push(text);
		});
		return { wrote, reported };
	}

	it("returns false and writes nothing when there are no unrecognized flags", () => {
		const { wrote, reported } = capture([]);

		expect(reported).toBe(false);
		expect(wrote).toEqual([]);
	});

	it("returns true and writes a singular `unknown flag` line for one entry", () => {
		const { wrote, reported } = capture(["--list-models"]);

		expect(reported).toBe(true);
		const text = wrote.join("");
		expect(text).toContain("Error: unknown flag: --list-models");
		// `--help` hint guides the user toward the actual surface.
		expect(text).toContain("--help");
	});

	it("uses the plural form and joins multiple flags when several are unrecognized", () => {
		const { wrote, reported } = capture(["--foo", "--bar"]);

		expect(reported).toBe(true);
		const text = wrote.join("");
		expect(text).toContain("Error: unknown flags: --foo, --bar");
	});
});
