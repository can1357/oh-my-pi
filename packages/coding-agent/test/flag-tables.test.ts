import { describe, expect, it } from "bun:test";
import { parseArgs, validateToolNames } from "../src/cli/args";
import { OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS } from "../src/cli/flag-tables";
import { CliUsageError } from "../src/cli/usage-error";

/**
 * Catches the set → args.ts direction of drift between
 * `cli/flag-tables.ts` and `cli/args.ts`:
 *
 * - If `STRING_VALUE_FLAGS` claims a flag consumes a value but
 *   `parseArgs` treats it as boolean (or doesn't handle it), then
 *   `<flag> --profile work` would leave `--profile` standing — and
 *   parseArgs would activate the profile branch. We assert
 *   `result.profile` is undefined: the only way that's true is if the
 *   flag actually swallowed `--profile` as its value.
 *
 * - If `OPTIONAL_VALUE_FLAGS` claims a flag releases `-`-prefixed
 *   tokens but `parseArgs` swallows them anyway, then
 *   `<flag> --profile work` would suppress the profile activation. We
 *   assert `result.profile === "work"`: the flag must NOT have eaten
 *   `--profile`, so parseArgs sees and activates it.
 *
 * The reverse direction (args.ts handler missing from the set) cannot
 * be reflected on without parsing args.ts source — it's covered by
 * per-flag regression tests in `profile-bootstrap.test.ts` and by
 * user-facing scenarios in `profile-cli.test.ts`.
 */
describe("STRING_VALUE_FLAGS table is honored by args.ts parseArgs", () => {
	for (const flag of STRING_VALUE_FLAGS) {
		it(`${flag} consumes the next token unconditionally`, () => {
			try {
				const result = parseArgs([flag, "--profile", "work"]);
				expect(
					result.profile,
					`parseArgs should treat --profile as the value of ${flag}, not as a profile activation`,
				).toBeUndefined();
			} catch (error) {
				// Value-validating flags (e.g. --max-time) reject "--profile" as their
				// value; consuming-and-rejecting still proves the flag swallowed the
				// token instead of activating the profile.
				expect(error).toBeInstanceOf(CliUsageError);
			}
		});
	}
});

describe("OPTIONAL_VALUE_FLAGS table is honored by args.ts parseArgs", () => {
	for (const flag of OPTIONAL_VALUE_FLAGS) {
		it(`${flag} releases tokens that start with -`, () => {
			const result = parseArgs([flag, "--profile", "work"]);
			expect(
				result.profile,
				`parseArgs should release --profile back to its own handler when it follows ${flag}`,
			).toBe("work");
		});
	}
});

describe("--external-thinking", () => {
	it("enables external thinking without consuming the initial message", () => {
		const result = parseArgs(["--external-thinking", "check this"]);

		expect(result.externalThinking).toBe(true);
		expect(result.messages).toEqual(["check this"]);
	});

	it("stays unset when omitted", () => {
		expect(parseArgs([]).externalThinking).toBeUndefined();
	});
});
describe("--session-dir", () => {
	it("uses PI_CODING_AGENT_SESSION_DIR unless the CLI flag overrides it", () => {
		const previous = Bun.env.PI_CODING_AGENT_SESSION_DIR;
		Bun.env.PI_CODING_AGENT_SESSION_DIR = "/env/sessions";
		try {
			expect(parseArgs([]).sessionDir).toBe("/env/sessions");
			expect(parseArgs(["--session-dir", "/cli/sessions"]).sessionDir).toBe("/cli/sessions");
		} finally {
			if (previous === undefined) {
				delete Bun.env.PI_CODING_AGENT_SESSION_DIR;
			} else {
				Bun.env.PI_CODING_AGENT_SESSION_DIR = previous;
			}
		}
	});
});

describe("--tools validation", () => {
	it("maps search and find to grep and glob", () => {
		const result = parseArgs(["--tools", "search,find,grep"]);

		expect(result.tools).toEqual(["grep", "glob"]);
	});

	it("defers unknown-name validation until all session tools are discovered", () => {
		expect(parseArgs(["--tools", "bash,intercom"]).tools).toEqual(["bash", "intercom"]);
		expect(parseArgs(["--tools", "read,custom_tool"], new Map()).tools).toEqual(["read", "custom_tool"]);
	});
});

describe("--tools discovered-registry validation", () => {
	it("accepts extension and custom tools after they enter the session registry", () => {
		expect(() =>
			validateToolNames(["read", "intercom", "custom_tool"], ["read", "intercom", "custom_tool"]),
		).not.toThrow();
	});

	it("rejects names absent from the final registry", () => {
		expect(() => validateToolNames(["read", "missing"], ["read", "intercom", "custom_tool"])).toThrow(
			/Unknown tool in --tools: missing/,
		);
	});
});

describe("OPTIONAL_FLAGS per-flag quirks", () => {
	it("treats empty string as bare resume for --resume", () => {
		const result = parseArgs(["--resume", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});

	it("treats empty string as bare resume for -r", () => {
		const result = parseArgs(["-r", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});

	it("treats empty string as bare resume for --session", () => {
		const result = parseArgs(["--session", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});
});

describe("parseArgs end-of-options (--)", () => {
	it("treats tokens after -- as literal messages, not flags", () => {
		const result = parseArgs(["--", "--profile", "work"]);
		expect(result.profile).toBeUndefined();
		expect(result.messages).toEqual(["--profile", "work"]);
	});

	it("does not interpret @ args or known value flags after --", () => {
		const result = parseArgs(["--", "@file.md", "--model", "opus"]);
		expect(result.model).toBeUndefined();
		expect(result.fileArgs).toEqual([]);
		expect(result.messages).toEqual(["@file.md", "--model", "opus"]);
	});

	it("parses flags before -- and forwards the rest as text", () => {
		const result = parseArgs(["--print", "hello", "--", "--no-tools"]);
		expect(result.print).toBe(true);
		expect(result.noTools).toBeUndefined();
		expect(result.messages).toEqual(["hello", "--no-tools"]);
	});
});

describe("parseArgs @file parsing with quotes", () => {
	it("parses unquoted @file arguments normally", () => {
		const result = parseArgs(["@foo.png"]);
		expect(result.fileArgs).toEqual(["foo.png"]);
	});

	it('parses double-quoted @"file" arguments', () => {
		const result = parseArgs(['@"foo bar.png"']);
		expect(result.fileArgs).toEqual(["foo bar.png"]);
	});

	it("parses single-quoted @'file' arguments", () => {
		const result = parseArgs(["@'foo bar.png'"]);
		expect(result.fileArgs).toEqual(["foo bar.png"]);
	});
});

describe("foreign session import flags", () => {
	it("parses each source flag without consuming the initial message", () => {
		const claude = parseArgs(["--from-claude", "continue this session"]);
		const codex = parseArgs(["--from-codex", "continue this session"]);

		expect(claude.fromClaude).toBe(true);
		expect(claude.messages).toEqual(["continue this session"]);
		expect(claude.unrecognizedFlags).toEqual([]);
		expect(codex.fromCodex).toBe(true);
		expect(codex.messages).toEqual(["continue this session"]);
		expect(codex.unrecognizedFlags).toEqual([]);
	});
});
