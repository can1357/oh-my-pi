import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS } from "../src/cli/flag-tables";

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
			const result = parseArgs([flag, "--profile", "work"]);
			expect(
				result.profile,
				`parseArgs should treat --profile as the value of ${flag}, not as a profile activation`,
			).toBeUndefined();
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

describe("--tools legacy aliases", () => {
	it("maps search and find to grep and glob", () => {
		const result = parseArgs(["--tools", "search,find,grep"]);

		expect(result.tools).toEqual(["grep", "glob"]);
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
