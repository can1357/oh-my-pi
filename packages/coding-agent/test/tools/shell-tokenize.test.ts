import { describe, expect, it } from "bun:test";
import {
	extractLeadingCdTarget,
	readShellWord,
	tokenizeShellSegments,
} from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";

describe("extractLeadingCdTarget", () => {
	it("extracts a bare cd target and returns the remainder", () => {
		expect(extractLeadingCdTarget("cd /some/dir && echo ok")).toEqual({
			path: "/some/dir",
			rest: "echo ok",
		});
	});

	it("resolves quoted and escaped path tokens", () => {
		expect(extractLeadingCdTarget('cd "/my dir" && ls')).toEqual({ path: "/my dir", rest: "ls" });
		expect(extractLeadingCdTarget("cd '/a b' && ls")).toEqual({ path: "/a b", rest: "ls" });
		expect(extractLeadingCdTarget("cd /a\\ b && ls")).toEqual({ path: "/a b", rest: "ls" });
	});

	it("leaves escaped newlines to the shell", () => {
		expect(extractLeadingCdTarget("cd /tmp\\\n&& echo ok")).toBeNull();
		expect(extractLeadingCdTarget('cd "/tmp\\\n" && echo ok')).toBeNull();
	});

	it("preserves ~ so resolveToCwd can expand it", () => {
		expect(extractLeadingCdTarget("cd ~/proj && make")).toEqual({ path: "~/proj", rest: "make" });
	});

	it("accepts a && with no leading whitespace", () => {
		expect(extractLeadingCdTarget("cd /tmp&& echo ok")).toEqual({ path: "/tmp", rest: "echo ok" });
	});

	// Regression for #7883: a redirect between the path and `&&` must not be
	// absorbed into the cwd token — the command belongs to the shell intact.
	it("bails when a redirect follows the path", () => {
		expect(extractLeadingCdTarget("cd /tmp 2>/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp >/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp >/dev/null 2>&1 && echo ok")).toBeNull();
	});

	it("bails when an extra argument follows the path", () => {
		expect(extractLeadingCdTarget("cd /tmp extra && echo ok")).toBeNull();
	});

	it("bails on paths that need shell expansion", () => {
		expect(extractLeadingCdTarget("cd $HOME && ls")).toBeNull();
		expect(extractLeadingCdTarget('cd "$(git rev-parse --show-toplevel)" && make')).toBeNull();
		expect(extractLeadingCdTarget("cd `pwd` && ls")).toBeNull();
	});

	it("requires a top-level && separator", () => {
		expect(extractLeadingCdTarget("cd /tmp; echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /foo || echo fail")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp &echo")).toBeNull();
	});

	it("bails when there is no cd target", () => {
		expect(extractLeadingCdTarget("cd  && echo")).toBeNull();
		expect(extractLeadingCdTarget("ls -la")).toBeNull();
		expect(extractLeadingCdTarget("cdx /tmp && ls")).toBeNull();
	});
});

describe("readShellWord", () => {
	it("reads a bare whitespace-delimited token", () => {
		expect(readShellWord("bun test extra")).toEqual({ value: "bun", rest: "test extra" });
	});

	it("reads a fully quoted value and preserves internal whitespace", () => {
		expect(readShellWord('"bun test" fix it')).toEqual({ value: "bun test", rest: "fix it" });
		expect(readShellWord("'bun test' fix it")).toEqual({ value: "bun test", rest: "fix it" });
	});

	// Regression: an `indexOf`-based scanner treats an escaped instance of the
	// outer delimiter as the closing quote, silently truncating the value.
	it("keeps an escaped instance of the outer delimiter inside the value", () => {
		expect(readShellWord(`"node -e \\"process.exit(0)\\"" fix it`)).toEqual({
			value: 'node -e "process.exit(0)"',
			rest: "fix it",
		});
		expect(readShellWord(`"test \\"$READY\\" = yes" continue`)).toEqual({
			value: 'test "$READY" = yes',
			rest: "continue",
		});
	});

	// Regression: a scanner that only checks space/tab does not end a quoted
	// value at a newline, so a multiline invocation folds the next line's
	// prompt text into the condition command.
	it("stops on a newline or carriage return, not just space and tab", () => {
		expect(readShellWord("'bun test'\nfix the tests")).toEqual({ value: "bun test", rest: "fix the tests" });
		expect(readShellWord("bun\ntest")).toEqual({ value: "bun", rest: "test" });
		expect(readShellWord("bun\r\ntest")).toEqual({ value: "bun", rest: "test" });
	});

	it("does not un-escape inside single quotes", () => {
		expect(readShellWord(String.raw`'a\"b' rest`)).toEqual({ value: 'a\\"b', rest: "rest" });
	});

	it("reports an unterminated quote", () => {
		expect(readShellWord('"bun test')).toBe("unterminated");
		expect(readShellWord("'bun test")).toBe("unterminated");
	});

	it("returns undefined for empty or all-whitespace input", () => {
		expect(readShellWord("")).toBeUndefined();
		expect(readShellWord("   ")).toBeUndefined();
	});
});

describe("tokenizeShellSegments", () => {
	it("keeps a multiline ANSI-C string open as one word, then splits", () => {
		// `$'...\'` stays open across newlines: the escaped quote does not
		// close it. `echo AFTER` is string CONTENT, like bash prints it; the
		// contract's fix is that it is no longer read as the closing quote,
		// so the segment after the string is `echo REACHED`, not the payload.
		// Probed against bash: one printf, then `echo REACHED`.
		const command = "printf $'prefix \\'\necho AFTER\n' ; echo REACHED";
		expect(tokenizeShellSegments(command)).toEqual([
			["printf", "$prefix \\'\necho AFTER\n"],
			["echo", "REACHED"],
		]);
	});

	it("closes a plain quoted string on the first apostrophe", () => {
		// A backslash is literal inside plain quotes: nothing is escaped.
		const command = "echo 'a\\b'; echo NEXT";
		expect(tokenizeShellSegments(command)).toEqual([
			["echo", "a\\b"],
			["echo", "NEXT"],
		]);
	});

	it("closes an ANSI-C string at its own closing quote, one line later", () => {
		const command = "printf $'a\\'b\n' ; echo REACHED";
		expect(tokenizeShellSegments(command)).toEqual([
			["printf", "$a\\'b\n"],
			["echo", "REACHED"],
		]);
	});

	it("treats a quoted apostrophe after a bare word as plain quoting", () => {
		// The sensory trap: `x '...'` is a plain string; only `$'...'` escapes.
		const command = "echo x'not ansi'; echo REACHED";
		expect(tokenizeShellSegments(command)).toEqual([
			["echo", "xnot ansi"],
			["echo", "REACHED"],
		]);
	});

	it("keeps a command after an escaped dollar that only looks ANSI-C", () => {
		// Codex review: `\$'` is NOT an ANSI-C opener; the dollar is escaped,
		// so the string is plain and closes at the FIRST apostrophe. The
		// `; sudo whoami` after it must split into its own segment. Probed
		// against bash: `$a\` printed, then sudo runs.
		const command = "echo \\$'a\\'; sudo whoami";
		expect(tokenizeShellSegments(command)).toEqual([
			["echo", "$a\\"],
			["sudo", "whoami"],
		]);
	});

	it("does not open a quote inside a comment", () => {
		// Codex review: a `#` comment runs to end of line and the `$'\'`
		// inside it opens nothing, so `sudo whoami` on the next line stays a
		// command of its own. Probed against bash: `ok`, then sudo runs.
		const command = "echo ok # $'\\'\nsudo whoami";
		expect(tokenizeShellSegments(command)).toEqual([
			["echo", "ok", "$'\\'"],
			["sudo", "whoami"],
		]);
	});
});
