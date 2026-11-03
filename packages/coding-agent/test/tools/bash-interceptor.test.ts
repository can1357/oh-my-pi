// Shell commands under test spell `${…}` parameter expansions as plain text, not as template placeholders.
/* oxlint-disable no-template-curly-in-string */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashInterceptorRule } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { dedicatedToolCanPerformStep } from "@oh-my-pi/pi-coding-agent/tools/bash-step";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: Settings.isolated({
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": rules,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
		}),
		getSessionFile: () => null,
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		const command = "cd packages/coding-agent && cat package.json";
		await expect(
			tool.execute("tool-call", { command }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow(`Use read instead.\n\nOriginal command: ${command}`);
	});
});

describe("compound command interception", () => {
	const rules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*git\\s+commit\\b",
			tool: "commit",
			message: "Use the commit tool instead.",
		},
	];

	it.each([
		"git commit -m message",
		"git add file && git commit -m message",
		"git add file; git commit -m message",
		"git add file || git commit -m message",
		"git add file & git commit -m message",
		"git add file\ngit commit -m message",
	])("blocks a later command after %s", command => {
		expect(checkBashInterception(command, ["commit"], rules).block).toBe(true);
	});

	it("does not intercept a downstream pipe stage that consumes piped stdin", () => {
		// `git commit` after a single `|` reads the previous stage's stdout, so
		// the dedicated tool cannot replace it. `||` still starts a fresh command.
		expect(checkBashInterception("git add file | git commit -m message", ["commit"], rules).block).toBe(false);
		expect(checkBashInterception("git add file || git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("removes one or more leading environment assignments before matching", () => {
		expect(
			checkBashInterception('GIT_AUTHOR_EMAIL="a@example.com" git commit -m message', ["commit"], rules).block,
		).toBe(true);
		expect(
			checkBashInterception(
				'GIT_AUTHOR_EMAIL="a@example.com" GIT_AUTHOR_NAME=Dev git commit -m message',
				["commit"],
				rules,
			).block,
		).toBe(true);
	});

	it("does not treat quoted, escaped, or commented text as a later command", () => {
		for (const command of [
			"printf '%s\\n' \"git add file && git commit -m message\"",
			'echo "git commit"',
			"echo git\\ commit",
			"echo ok # git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("does not treat redirection targets as later commands", () => {
		for (const command of [
			"echo hi >|git commit -m message",
			"echo hi >| git commit -m message",
			"echo hi >&git commit -m message",
			"echo hi >& git commit -m message",
			"echo hi <&3 git commit -m message",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
		// <& is a redirect operator, so the & does not split the command;
		// but when a && follows the redirect, the later command is still extracted.
		expect(checkBashInterception("echo hi <&3 && git commit -m message", ["commit"], rules).block).toBe(true);
	});

	it("does not add matches for unsupported shell syntax", () => {
		for (const command of [
			'echo "$(git commit -m message)"',
			"echo `git commit -m message`",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell parameter expansion under test
			"echo ${x:-foo;git commit -m message}",
			"( git commit -m message )",
			"echo start; { true; git commit -m message; }",
			"cat <<'EOF'\ngit commit -m message\nEOF",
		]) {
			expect(checkBashInterception(command, ["commit"], rules).block).toBe(false);
		}
	});

	it("keeps matching a rule written for the complete original input", () => {
		const command = "git add file && git commit -m message";
		const completeInputRule: BashInterceptorRule[] = [
			{
				pattern: "^git add file && git commit",
				tool: "commit",
				message: "Use the commit tool instead.",
			},
		];
		expect(checkBashInterception(command, ["commit"], completeInputRule).block).toBe(true);
	});

	it("does not block when the suggested tool is unavailable", () => {
		expect(checkBashInterception("git add file && git commit -m message", [], rules).block).toBe(false);
	});
});

describe("default echo/printf redirect rule", () => {
	// The rule's message sends appends to `edit`, so an append is refused only when `edit` exists.
	const tools = ["write", "edit"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not refuse an append when edit, the tool its message names for appends, is unavailable", () => {
		expect(checkBashInterception("echo hi >> out.txt", ["write"], DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo hi > out.txt", ["write"], DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber redirects and leaves writes to a path in a variable to the shell", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		// A parameter's value lives in the shell; the agent would have to resolve it first.
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo hi > $HOME/out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo hi > ~/out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not refuse a write that also opens a /dev sink", () => {
		// A write has exactly one redirection; a second one opens something the write tool does not.
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("does not attribute a later command's stderr redirect to echo", () => {
		const tools = ["write", "read"];
		for (const command of [
			'echo "hi"; gcloud auth print-access-token 2>/tmp/tok.err',
			'echo "hi" && ls 2>/tmp/e.err',
			"echo start\nmake 2>build.err",
			"echo x > /dev/null; ls > listing.txt",
			"echo x 2>err.log",
			"echo x 2>>err.log",
			"echo x 2>&1 && ls > listing.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(checkBashInterception("ls; echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi 1> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		// Only a single stdout redirection is a write; anything else touches more than one file.
		for (const command of [
			"echo hi &> out.txt",
			"echo hi 2>&1 > out.txt",
			"echo hi 2>err.txt > out.txt",
			"echo hi 2>|err.txt > out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
	});

	it("keeps scanning past escaped separators and input fd duplication", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo foo\\; > out.txt",
			"echo a \\| b > out.txt",
			"echo a \\& b > out.txt",
			"echo one\\\ntwo > out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		for (const command of ["echo hi <&0 > out.txt", "echo hi 0<&- > out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(checkBashInterception("echo hi <&0", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("keeps separators inside a substitution out of the boundary scan", () => {
		const tools = ["write", "read", "edit"];
		for (const command of ["echo a\\;b > out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		// The same scan with an expansion: the shell computes the text (arithmetic can even fail), so write cannot.
		for (const command of [
			"echo $(( (1 + 2) * 3 )) > out.txt",
			"echo $((1/0)) > out.txt",
			"echo a\\;b ${HOME} > out.txt",
			"echo ${x:-a;b} > out.txt",
			"echo ${a:-${b}} > out.txt",
			"printf %s ${HOME:-${USER}} >> out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(checkBashInterception("echo $(ls) ; ls > f", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo ${a:-${b}}; ls 2>e.log", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception("echo $(printf a; printf b)", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
	});

	it("does not refuse writing what only the running shell knows", () => {
		// The write tool writes text the agent supplies; it cannot run `date` or read `$?`.
		const tools = ["write", "read", "edit"];
		for (const command of [
			"echo $(printf foo; printf bar) > out.txt",
			"echo `date; ls` > out.txt",
			"echo $(ls > /dev/null) > out.txt",
			'echo "$(date -u +%FT%TZ) merge seg_parse da06efaa" >> /home/sami/work/cold/workers/h-ctrl-a3/reply-commits.txt',
			'echo "exit=$?" >> /tmp/al2k2/build1.out',
			"echo $! > pid.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		// Sample row 33: `$PWD` is a parameter the shell resolves, so its value is not text the agent has.
		expect(
			checkBashInterception(
				"printf 'r188 log=%s/logs-box/fit2-r188.log\\n' $PWD > logs-box/fit2-pids.txt",
				tools,
				DEFAULT_BASH_INTERCEPTOR_RULES,
			).block,
		).toBe(false);
	});

	it("matches commands with many stderr sinks without exponential backtracking", () => {
		const start = performance.now();
		const echo = checkBashInterception(
			"echo hi" + " 2>/dev/null 2>>/dev/null 2>&1 \\; <&0 $(a; b) `c; d` ${e:-f;g}".repeat(20),
			["write"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		const cat = checkBashInterception(
			`cat${" 2>>/dev/null 2>|/dev/null".repeat(20)} file.txt`,
			["write", "read"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(echo.block).toBe(false);
		expect(cat.suggestedTool).toBe("read");
	});

	it("routes cat heredoc and redirect writes to write, not read", () => {
		const tools = ["write", "read", "edit"];
		for (const command of ["cat > /tmp/f <<'EOF'\nx\nEOF", "cat <<'EOF' > /tmp/f\nx\nEOF", "cat <<< 'x' > /tmp/f"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		// Without a document cat copies its stdin, which the write tool cannot read.
		expect(checkBashInterception("cat >> log.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("cat <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("cat file.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
	});

	it("refuses neither read nor write for a cat that copies or concatenates files", () => {
		// Case 5 of the refusal study: the read rule took this concatenation for a read.
		const tools = ["write", "read", "edit"];
		for (const command of [
			"cat local://review-1d-r3.md /mnt/nvme/sami/tmp/XV6-01a16551/rev1d-r3/review-1d-r2.round2.bak > $F",
			"cat new.md bak > review.md",
			"cat a > b",
			"cat > b a",
			"cat < a > b",
			"cat a >> b",
			"cat a b | sort > merged.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
	});

	it("keeps cat on read unless its stdout goes to a file", () => {
		const tools = ["write", "read", "edit"];
		for (const command of [
			"cat 2>/dev/null file.txt",
			"cat 2>&1 file.txt",
			"cat >&2 file.txt",
			"cat 1>&2 file.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
		}
		// Without a document these copy stdin into the file: neither a read nor a write.
		for (const command of ["cat 2>/dev/null 1>out.txt", "cat &>out.txt", "cat 2>&1 1>out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		// Stderr into a file is a file neither read nor write creates.
		for (const command of ["cat 2>err.log file.txt", "cat 2>err.log > out.txt", "cat 2> err.log >> out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		}
		expect(
			checkBashInterception("cat 2>/dev/null <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
	});
});

describe("default grep rule and pipeline stdin", () => {
	const tools = ["grep"];

	it("blocks standalone file searches", () => {
		expect(checkBashInterception("grep pattern path", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("rg pattern src", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks a first-stage grep that produces pipeline input", () => {
		expect(checkBashInterception("grep x file | wc -l", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block grep consuming pipeline stdin", () => {
		expect(checkBashInterception("printf 'x\\n' | grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(
			checkBashInterception("tr -d '\\r' < input.log | grep -v '^ *foo'", tools, DEFAULT_BASH_INTERCEPTOR_RULES)
				.block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(
			checkBashInterception("printf 'x\\n' |\n # filter\n grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
		expect(checkBashInterception("printf 'x\\n' |& grep x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("does not block a grep sequenced after another command", () => {
		expect(
			checkBashInterception("cat log | tr a b && grep err file", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(false);
	});
});

describe("default bash service rules", () => {
	const tools = ["bash"];

	it.each(["bun run dev", "vite --host 0.0.0.0", "lldb ./app", "bun test --watch", "nohup server", "server &"])(
		"routes %s to named bash service mode",
		command => {
			const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(result.block).toBe(true);
			expect(result.suggestedTool).toBe("bash");
		},
	);

	it.each(["git diff -w", "docker compose up -d", "bun test", "printf 'server &'"])(
		"does not misclassify finite command %s",
		command => {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		},
	);
});

describe("leading-step matching for read, grep and glob rules", () => {
	const tools = ["read", "grep", "glob", "write", "edit", "bash"];
	const decide = (command: string) => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		return result.block ? result.suggestedTool : undefined;
	};

	it("does not refuse a read-only step that a later position makes depend on earlier steps", () => {
		// Commands from the refusal study's random sample, refused on a later step.
		for (const command of [
			"ls /home/sami/work/workers/h-ctrl-a6/reloc/sweep/ 2>&1; echo ===; grep -n 'Tk/A' /home/sami/work/workers/h-ctrl-a6/reloc/sweep/excluded.tsv 2>/dev/null || find /home/sami/work/workers/h-ctrl-a6/reloc -name 'excluded.tsv' 2>/dev/null",
			"F=~/.cache/knives-sweep/final; rm -rf $F/mut; cp -r $F/exportR $F/mut; ls $F/probes; grep -n 'func Test\\|^package' $F/probes/*.go",
			"mkdir -p /tmp/ucirev/tree && cd /tmp/ucirev/tree && git -C /home/sami/work/ovpi archive ab3b50f25453 proofs/reac-repacer/fuzz_uci | tar x && find . -name '*.v' | wc -l",
			"ls d && cat f",
		]) {
			expect(decide(command)).toBeUndefined();
		}
	});

	it("still refuses a leading read-only step", () => {
		expect(decide("cat f && ls d")).toBe("read");
		expect(
			decide("grep -n 'YK06\\|YM05' ExvB_NumE.v 2>/dev/null | head -5; grep -c 'alloc_ceiling' ExvB_NumE.v"),
		).toBe("grep");
		// An assignment changes what the command does (`LC_ALL=C` its matching), so it runs.
		expect(decide("LC_ALL=C grep -n x f")).toBeUndefined();
	});

	it("keeps matching write, edit and service rules on every step", () => {
		expect(decide("ls && echo '{}' > a.jsonl")).toBe("write");
		expect(decide("make && sed -i 's/a/b/' f.v")).toBe("edit");
		expect(decide("cd app && npm run dev")).toBe("bash");
	});
});

describe("dedicated tool capability", () => {
	const tools = ["read", "grep", "glob", "write", "edit", "bash"];
	const decide = (command: string) => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		return result.block ? result.suggestedTool : undefined;
	};

	it.each([
		// Case 1 of the refusal study: a byte read of a file that failed to decompress.
		"head -c 300 rtaudit.tar.gz | od -c | head -20",
		"head --bytes=300 f",
		"head -n -5 f",
		"head -5",
		"cat -A f",
		"cat - f",
		"cat *.log",
		"cat $(which ossv-wt-add) | head -50",
		"cat f > out.txt",
		"cat f | tee copy.txt",
		"cat f | xargs rm",
	])("does not refuse %s as a read", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		["cat f", "read"],
		["cat -n a b", "read"],
		["cat < f", "read"],
		["cat f > /dev/stderr", "read"],
		["head -5 f", "read"],
		["head -n 20 f | cut -c1-80", "read"],
		["tail -n +20 f", "read"],
		["tail -f log", "bash"],
		// Main's service rule names only `tail -f`; the read tool cannot follow, so these run.
		["tail -F log", undefined],
		["tail -n 5 -f log", undefined],
	])("routes %s to %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it.each([
		// Sample row 12 of the refusal study: only-matching output cut into fields.
		"grep -oE '^proofs/[^ ]+\\.vo \\(real' build.log | cut -d' ' -f1; tail -n 2 build.log",
		// Sample row 20: a pipeline whose output goes to a file.
		"grep ': test$' tests-before.txt | sed 's/: test$//;s/.*:://' | sort > before-bare.txt",
		"grep -c x f",
		"grep -v x f",
		"grep -L x src",
		"grep -b x f",
		"grep -f patterns.txt f",
		'grep x <<< "$v"',
		"grep x",
		"grep x f > /dev/null && echo found",
		"grep -l x src | xargs sed -n 1p",
		// The grep tool shows matching lines; it has no quiet or file-list mode.
		"grep -q x f",
		"grep -l x f",
		"rg -l x",
		"rg -tv -l x .",
		"grep -rIl --include='_CoqProject*' -e 'Proof Using' .",
		"cat f | grep -q x",
		"grep x f | while read l; do echo $l; done",
		"rg --files",
		"rg -c x",
		"rg --max-depth 2 x",
	])("does not refuse %s as a grep", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		"grep -rn x .",
		"grep -n x f | head",
		"grep -nE 'a|b' -e x f",
		"grep -rI --include='_CoqProject*' -e 'Proof Using' .",
		"rg x",
		"rg -tv x .",
		"grep x < f",
	])("refuses %s as a grep", command => {
		expect(decide(command)).toBe("grep");
	});

	it.each([
		// Case 6 of the refusal study: `-maxdepth 4` maps to glob's `depth: 4`, but `-type d` does not.
		"find /srv/deploy -maxdepth 4 -type d -name first-a | head",
		// `-maxdepth 0` lists only the roots, which the glob tool never reports.
		"find . -maxdepth 0 -name x",
		"find . -mindepth 2 -name x",
		// Sample row 18: a size test; glob has `depth` but no size test.
		'find /theorem-xfs/r15 /theorem-xfs/r14 -maxdepth 9 -name "*.usekey" -size +50k 2>/dev/null | head -3',
		"find . -iname x",
		"find . -name x -newer stamp",
		"find . -name x -exec rm {} +",
		"find . -name x -printf '%s %p\\n'",
		"find . -type l -name x",
		// glob lists symlinks to files as files and cannot leave out directories.
		"find a b -type f -name '*.v' | head -20",
		"find . -type d -name x",
		"find . -name x ! -path './build/*'",
		// A negation or a prune of anything but `.git` has no glob argument.
		"find . -name '*.v' -not -path '*/.git/*'",
		"find . -path ./node_modules -prune -o -name '*.ts' -print",
		// Without `-print` find also prints the pruned `.git`.
		"find . -name .git -prune -o -name '*.ts'",
		// find lists a root the pattern matches; glob never lists its roots.
		"find src -name src",
		"find . -name '*.o' | xargs rm",
		"locate foo -name",
		"fd --type f Foo",
		"fd foo",
		"fd 'a.*b'",
		// fd skips ignored files, which glob does only together with node_modules.
		"fd --glob 'Foo*'",
		"fd -H --glob 'Foo*'",
	])("does not refuse %s as a glob", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		["find . -name '*.v'", { path: "**/*.v", hidden: true, gitignore: false, git: true }],
		["find a b -name '*.v' | head -20", { path: "a/**/*.v;b/**/*.v", hidden: true, gitignore: false, git: true }],
		[
			"find /srv/deploy -maxdepth 4 -name first-a | head",
			{ path: "/srv/deploy/**/first-a", hidden: true, gitignore: false, git: true, depth: 4 },
		],
		["find . -name dune -maxdepth 2", { path: "**/dune", hidden: true, gitignore: false, git: true, depth: 2 }],
		[
			"find . \\( -name 'thermonuclear*' -o -name reviewer.md \\)",
			{ path: "**/thermonuclear*;**/reviewer.md", hidden: true, gitignore: false, git: true },
		],
		["find . -name .git", { path: "**/.git", hidden: true, gitignore: false, git: true }],
		[
			"find . -name .git -prune -o -name '*.ts' -print",
			{ path: "**/*.ts", hidden: true, gitignore: false, git: false },
		],
		["fd -I --glob --max-depth 3 'Foo*'", { path: "**/Foo*", hidden: false, gitignore: false, git: false, depth: 3 }],
		["fd -u --glob -s 'foo*' src", { path: "src/**/foo*", hidden: true, gitignore: false, git: true }],
		["fd -HI --glob Foo", { path: "**/Foo", hidden: true, gitignore: false, git: true }],
	])("refuses %s as a glob and names the same glob call", (command, args) => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.suggestedTool).toBe("glob");
		expect(result.message).toContain(`The same listing: glob ${JSON.stringify(args)}`);
	});

	it.each([
		"perl x.pl -input data",
		"perl -e 'print \"-i\"' f",
		"awk '{print \"-i inplace\"}' f",
		"sed -i 's/a/b/' *.v",
		// Backup copies, other files read or written, and code the edit tool does not run.
		"perl -i.bak -pe 's/a/b/' f",
		"perl -pi -e '$_=localtime.qq(\\n)' f",
		"awk -i inplace '{print}' f",
		"sed -i.bak 's/first/edited/' f",
		"sed -i 'r other' f",
		"sed -i 's/a/b/w log' f",
		"sed -n -i 's/a/b/p' f",
	])("does not refuse %s as an edit", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		"perl -pi -e 's/a/b/' f",
		"perl -0777 -i -pe 's/a/b/g' f",
		"sed -i 's/a/b/' f.v",
		"sed -i -E -e 's/^x$/y/g' -e '/drop/d' f.v",
	])("refuses %s as an edit", command => {
		expect(decide(command)).toBe("edit");
	});

	it.each([
		// Stdout reaches a file through descriptor duplication, `<>`, a mid-pipeline redirect or a wrapped writer.
		"cat f 1<> out",
		"cat f 2> out 1>&2",
		"cat f 3> out 1>&3",
		"cat f | sort > out | wc -c",
		"cat f | command tee out",
		"cat f | env tee out",
		"grep -n x f | sort -o out",
		"grep -n x f | sed 's/a/b/w out'",
		"cat f | grep x other.txt",
	])("does not refuse %s, whose output does not reach the agent, as a read or grep", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		["cat f 2>/dev/null | sort | uniq -c | head", "read"],
		["grep -n x f 2>&1 | cut -c1-80 | sed -n '1,20p'", "grep"],
		["cat f > /dev/stdout", "read"],
	])("refuses %s, whose output reaches the agent through filters, as %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it.each([
		// Text or paths only the running shell knows.
		"cat > out <<EOF\n$$\nEOF",
		"cat > out <<EOF\nnow `date`\nEOF",
		'echo "${v:-$(printf computed)}" > out',
		'echo "$((RANDOM))" > out',
		'printf "%(%s)T" -1 > out',
		'echo hi > "$(printf dynamic.txt)"',
		'cat <<< "$(date)" > out',
		"echo * > out",
	])("does not refuse %s as a write", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		"cat > out <<'EOF'\n$$ stays literal\nEOF",
		"cat > out <<EOF\nplain text, \\$ escaped\nEOF",
		"echo hi > out.txt",
	])("refuses %s as a write", command => {
		expect(decide(command)).toBe("write");
	});

	it.each([
		// ANSI-C and continued double-quoted words decode to what the shell passes.
		["head -n $'2' f", "read"],
		['head -n "2\\\n" f', "read"],
		["head $'-c' 2 f", undefined],
		// fd's `-S` is a size filter; glob has none.
		["fd --type f -s -S 5b Foo", undefined],
		// A filename after `--` is not a follow flag.
		["tail -c 4 -- -f", undefined],
		["tail -n 4 -- -f", "read"],
		// Round 2: descriptor numbers with leading zeros, Unicode escapes, continued delimiters.
		["cat f 01>out", undefined],
		["cat < f 00<<< computed", undefined],
		["head $'\\u002d\\u0063' 2 f", undefined],
		["head $'\\U0000002dc' 2 f", undefined],
		["cat >out <<EO\\\nF\n$(printf computed)\nEOF", undefined],
		["cat >out <<'EO'F\n$(printf literal)\nEOF", "write"],
	])("decides %s as %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it.each([
		// Round 2: options that write, read or run something make a later stage more than a filter.
		"cat f | sort --out=out",
		"cat f | wc --files0-fr=names",
		"cat f | sort -S1 --compress-program=./compress.sh",
		// Perl code in a pattern or replacement.
		'perl -pi -e \'s/(?{open my $fh, ">", "marker"})a/b/\' f',
		"perl -pi -e 's/@{[do { 1 }]}/b/' f",
		"perl -pi -e 's/a/$x/' f",
		// Descriptor duplication into a computed or appended target.
		'echo hi >unused 2>"$(printf out)" 1>&2',
		"echo hi >unused 3>>out 1>&3",
		// Computed redirections around read and edit commands.
		'cat f 2>"$(printf ran >marker; printf err)"',
		"sed -i 's/a/b/' f >\"$(printf unused)\"",
		"sed -i 's/a/b/' f > log",
		// Shell state only the running shell knows.
		'echo "$PIPESTATUS $BASH_REMATCH $EUID $UID" >out',
	])("does not refuse %s", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		["perl -pi -e 's/a$/b/g' f", "edit"],
		["perl -pi -e 's/(\\w+)/[$1]/' f", "edit"],
		["cat f | sort -n -k2 | uniq -c", "read"],
		["echo hi, home is ~ > out.txt", "write"],
	])("still refuses %s as %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it.each([
		// Round 3: a heredoc on any descriptor expands its body, even when nothing reads it.
		"cat f 3<<EOF\n$(printf side >marker)\nEOF",
		"grep -n x f 3<<EOF\n$(printf side >marker)\nEOF",
		"find . -name x 3<<EOF\n$(printf side >marker)\nEOF",
		"sed -i 's/a/b/' f 3<<EOF\n$(printf side >marker)\nEOF",
		"echo hi >out 3<<EOF\n$(printf side >marker)\nEOF",
		"echo hi >out <<EOF\n$(printf side >marker)\nEOF",
		// A later stage with a computed assignment or command word runs code.
		"cat f | X=$(printf side >marker) sort",
		'cat f | "$(printf side >marker; printf /usr/bin)/sort"',
		// An edit whose output also goes somewhere.
		"sed -i 's/a/b/' f | tee marker",
		"perl -pi -e 's/a/b/' f | tee marker",
		// Regex code blocks run under a `'` delimiter too.
		"perl -pi -e \"s'(?{system q(touch marker)})a'b'\" f",
		// Shell state and raw bytes the write tool cannot produce.
		"printf -v state '%s' hi >out",
		"printf '\\377' >out",
		"echo -e 'a\\xff' >out",
		"printf $'\\377' >out",
		"printf '%b' 'a\\0101' >out",
		// Devices and kernel files.
		"echo 1 > /proc/sys/vm/drop_caches",
		"echo hi > /dev/pts/0",
	])("does not refuse %s (round 3)", command => {
		expect(decide(command)).toBeUndefined();
	});

	it("does not send a FIFO, device or uninspectable path to read, grep, write or edit", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-interceptor-fifo-")));
		try {
			await fs.mkdir(path.join(dir, "actual", "deep"), { recursive: true });
			await fs.symlink(path.join(dir, "actual", "deep"), path.join(dir, "link"));
			for (const fifo of ["fifo", "-fifo", "~", "actual/deepfifo"])
				await Bun.$`mkfifo ${path.join(dir, fifo)}`.quiet();
			await Bun.write(path.join(dir, "plain"), "a\n");
			const at = (command: string, cwd = dir) =>
				checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES, command, cwd).suggestedTool;
			// Round 4: quoted `~`, `--` operands and `..` after a symlink name a FIFO here.
			for (const command of [
				"echo hi > fifo",
				"cat fifo",
				"cat < fifo",
				"cat -- -fifo",
				"cat '~'",
				"cat link/../deepfifo",
				`cat ${dir}/link/../deepfifo`,
				"grep a fifo",
				"grep a < fifo",
				"echo hi 3<fifo >out",
				"sed -i 's/a/b/' fifo",
				// Round 5: an edit's operand after `--` is checked too.
				"sed -i 's/a/b/' -- -fifo",
				"perl -pi -e 's/a/b/' -- -fifo",
				"cat /dev/null",
			]) {
				expect(at(command)).toBeUndefined();
			}
			// A URL directory cannot be inspected, so nothing there is sent to a tool.
			expect(at("cat plain", "local://work")).toBeUndefined();
			expect(at("echo hi > plain")).toBeUndefined();
			expect(at("echo hi > new-file")).toBe("write");
			expect(at("cat plain")).toBe("read");
			expect(at("grep a plain")).toBe("grep");
			expect(at("sed -i 's/a/b/' plain")).toBe("edit");
			// The script is not a path: a directory named like it does not change the decision.
			await fs.mkdir(path.join(dir, "s", "a", "b"), { recursive: true });
			expect(at("sed -i 's/a/b/' plain")).toBe("edit");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		// Round 4: a here-string or input on an echo is not part of a write.
		'echo hi <<<"$(printf marker >side)" >out',
		"echo hi <<<literal >out",
		// Formatted `%b`, `%n` and invalid Unicode escapes produce state or bytes.
		"printf '%5b' '\\377' >out",
		"printf '%-5b' x >out",
		"printf 'x%n' state >out",
		"printf '\\uD800' >out",
		"echo $'\\uD800' >out",
		"echo $'\\U00110000' >out",
		// Edits that write a character by its code.
		"sed -i 's/a/\\xff/' f",
		"perl -pi -e 's/a/\\xff/' f",
		"perl -pi -e 'tr/a/\\xff/' f",
	])("does not refuse %s (round 4)", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		["printf '%s: %5d%%\\n' rate 7 > out", "write"],
		["cat plain | cat", "read"],
		["cat plain | cat -", "read"],
		["cat plain | sort --", "read"],
	])("refuses %s as %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it.each([
		// Round 5: a precision can cut a character's bytes; non-integers make printf fail after writing.
		"printf '%.1s' 'é' > precision",
		"printf '%d' not-a-number > numeric",
		"printf '%i' 08 > numeric",
		"printf '%s=%d\\n' a 1 b x > numeric",
		// The write tool makes a `#!` file executable.
		"printf '#!/bin/sh\\n' > shebang",
		"echo '#!/bin/sh' > shebang",
		"cat > shebang <<'EOF'\n#!/bin/sh\nEOF",
		// Round 6: a `#!` line split across printf's words, or behind tabs `<<-` strips.
		"printf '#%s\\n' '!/bin/sh' > shebang",
		"printf '%s%s\\n' '#' '!/bin/sh' > shebang",
		"cat > shebang <<-'EOF'\n\t#!/bin/sh\n\tEOF",
		"printf '#%s/bin/sh\\n' '!' > shebang",
		"printf '%s%s/bin/sh\\n' $'#\\0discard' '!' > shebang",
		// Round 6: a literal assignment still changes what the command does.
		"PERL5OPT=-MReview PERL5LIB=. perl -pi -e 's/a/b/' f",
	])("does not refuse %s (round 5)", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each(["echo $'\\uZ' > out", "echo $'\\Uwat' > out", "echo $'\\u' > out"])(
		"decides %s without throwing",
		command => {
			expect(() => decide(command)).not.toThrow();
		},
	);

	it("classifies many here-strings in linear time", () => {
		const time = (count: number) => {
			const command = `cat ${"<<<'a' ".repeat(count)}>out`;
			const samples = [0, 1, 2].map(() => {
				const start = performance.now();
				dedicatedToolCanPerformStep("write", command, tools);
				return performance.now() - start;
			});
			return samples.sort((a, b) => a - b)[1];
		};
		time(1_000);
		// Eight times the input: linear work takes about 8 times as long, quadratic work 64 times.
		expect(time(128_000)).toBeLessThan(24 * time(16_000) + 50);
	});

	it.each([
		["printf '# heading\\n' > notes.md", "write"],
		["cat > notes.md <<-'EOF'\n\t# heading\n\tEOF", "write"],
	])("still refuses %s as %s", (command, tool) => {
		expect(decide(command)).toBe(tool);
	});

	it("rejects a long excluded printf format in linear time", () => {
		const start = performance.now();
		expect(decide(`printf '%${"0".repeat(32_000)}q' x > out`)).toBeUndefined();
		expect(performance.now() - start).toBeLessThan(250);
	});

	it("inspects only the leading step's paths, without following an edited symlink or a /proc alias", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-interceptor-round5-")));
		try {
			await fs.mkdir(path.join(dir, "nested"));
			await fs.symlink("/dev/null", path.join(dir, "nested", "sink"));
			await Bun.write(path.join(dir, "target"), "a\n");
			await fs.symlink(path.join(dir, "target"), path.join(dir, "link"));
			await fs.symlink("/proc", path.join(dir, "kernel"));
			await Bun.write(path.join(dir, "existing"), "\ufeffold\r\n");
			const at = (command: string, cwd = dir) =>
				checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES, command, cwd).suggestedTool;
			for (const command of [
				// A later step may run after a `cd`: its paths cannot be inspected.
				"true && cd nested && echo hi > sink",
				// `sed -i` replaces a symlink with a file; the edit tool edits the target.
				"sed -i 's/a/b/' link",
				// Kernel paths reached through a symlink or a relative path.
				"cat kernel/self/comm",
				// The write tool keeps an existing file's byte-order mark and line endings.
				"echo hi > existing",
			]) {
				expect(at(command)).toBeUndefined();
			}
			expect(at("cat self/comm", "/proc")).toBeUndefined();
			expect(at("echo hi > fresh")).toBe("write");
			expect(at("sed -i 's/a/b/' target")).toBe("edit");
			// Round 6: the edit tool refuses non-UTF-8 and keeps a BOM and CRLF, so those edits run.
			await Bun.write(path.join(dir, "binary"), new Uint8Array([0x61, 0x0a, 0xff, 0x0a]));
			await Bun.write(path.join(dir, "bom"), "\ufeffa\nb\n");
			await Bun.write(path.join(dir, "crlf"), "a\r\n");
			for (const command of ["sed -i 's/a/b/' binary", "sed -i '1d' bom", "sed -i 's/a/b/' crlf"]) {
				expect(at(command)).toBeUndefined();
			}
			// A multiline search reads only the first 4 MB of a large file.
			await Bun.write(path.join(dir, "large"), `${"x\n".repeat(2_200_000)}UNIQUE_MARKER\nEND_MARKER\n`);
			expect(at("rg -U 'UNIQUE_MARKER\\nEND_MARKER' large")).toBeUndefined();
			expect(at("rg UNIQUE_MARKER large")).toBe("grep");
			// The shell cannot create a file in a missing directory; the write tool would create both.
			expect(at("echo hi > missing/out")).toBeUndefined();
			expect(at("cat link")).toBe("read");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not send a find over a symlinked root to glob unless -H follows it", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-interceptor-find-root-")));
		try {
			await Bun.write(path.join(dir, "real", "dune"), "x\n");
			await fs.symlink(path.join(dir, "real"), path.join(dir, "alias"));
			const at = (command: string) =>
				checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES, command, dir).suggestedTool;
			expect(at("find alias -name dune")).toBeUndefined();
			expect(at("find -H alias -name dune")).toBe("glob");
			expect(at("find real -name dune")).toBe("glob");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("parses a long perl substitution in linear time", () => {
		const start = performance.now();
		decide(`perl -pi -e 's${"\\\\".repeat(32_000)}!' f`);
		expect(performance.now() - start).toBeLessThan(250);
	});

	it.each(["grep --__proto__ x f", "head --hasOwnProperty=f", "cat --constructor f", "find . -constructor x"])(
		"does not throw on %s",
		command => {
			expect(decide(command)).toBeUndefined();
		},
	);

	it("keeps a custom rule whose tool names an Object.prototype property working", () => {
		const rules: BashInterceptorRule[] = [{ pattern: "^\\s*deploy\\b", tool: "constructor", message: "Use it." }];
		expect(checkBashInterception("ls && deploy now", ["constructor"], rules).block).toBe(true);
	});

	it("does not take a later command's watch flag for the matched command's", () => {
		expect(decide("bun install && grep -w foo f")).toBeUndefined();
		expect(decide("jest -w 4")).toBeUndefined();
		expect(decide("jest --watch")).toBe("bash");
		expect(decide("bun test --watch")).toBe("bash");
	});
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});

describe("BashTool runs a step the named tool cannot perform", () => {
	it("runs a concatenation and a byte read, and still refuses a plain read", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-interceptor-")));
		try {
			await Bun.write(path.join(dir, "new.md"), "round 3\n");
			await Bun.write(path.join(dir, "old.md"), "round 2\n");
			await Bun.write(path.join(dir, "data.bin"), new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]));
			const tool = new BashTool({
				cwd: dir,
				hasUI: false,
				skills: [],
				getSessionFile: () => null,
				getClientBridge: () => undefined,
				settings: Settings.isolated({
					"bashInterceptor.enabled": true,
					"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
				}),
			} as unknown as ToolSession);
			const ctx = { toolNames: ["read", "grep", "glob", "write", "edit", "bash"] } as AgentToolContext;
			const text = (result: { content: Array<{ type: string; text?: string }> }) =>
				result.content.find(c => c.type === "text")?.text ?? "";

			await tool.execute(
				"call-1",
				{ command: "cat new.md old.md > review.md && wc -l review.md" },
				undefined,
				undefined,
				ctx,
			);
			expect(await Bun.file(path.join(dir, "review.md")).text()).toBe("round 3\nround 2\n");

			const bytes = await tool.execute(
				"call-2",
				{ command: "head -c 4 data.bin | od -An -tx1" },
				undefined,
				undefined,
				ctx,
			);
			expect(text(bytes).trim()).toBe("50 4b 03 04");

			await expect(tool.execute("call-3", { command: "cat new.md" }, undefined, undefined, ctx)).rejects.toThrow(
				"Use the `read` tool instead of cat/head/tail",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("pre-approval refusal gate", () => {
	const createSession = (settingsOverrides: Record<string, unknown> = {}, toolNames = ["read", "grep", "bash"]) =>
		({
			cwd: process.cwd(),
			hasUI: true,
			getSessionFile: () => null,
			isToolActive: (name: string) => toolNames.includes(name),
			getToolContext: () => ({ toolNames, hasUI: true, ui: {} }) as unknown as AgentToolContext,
			settings: Settings.isolated({
				"async.enabled": true,
				"launch.enabled": true,
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
				...settingsOverrides,
			}),
		}) as unknown as ToolSession;

	const makeWrapper = (tool: BashTool, select: () => Promise<string>, hasUI = true, rewrittenCommand?: string) => {
		const runner = {
			hasHandlers: (event: string) => rewrittenCommand !== undefined && event === "tool_call",
			emitToolCall: async () => (rewrittenCommand ? { input: { command: rewrittenCommand } } : undefined),
			consumeToolCallEmitted: () => false,
			hasUI: () => hasUI,
			getUIContext: () => ({ select }),
			hasSessionApproval: () => false,
			sessionId: "bash-approval-test",
			cwd: process.cwd(),
			runScoped: <T>(fn: () => T): T => fn(),
		} as unknown as ExtensionRunner;
		return new ExtensionToolWrapper(tool as Tool, runner);
	};

	const alwaysAskCtx = {
		settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
		toolNames: ["read", "grep", "bash"],
	} as unknown as AgentToolContext;

	it("rejects an intercepted command in always-ask mode without prompting", async () => {
		const select = vi.fn(async () => "Approve");
		const wrapper = makeWrapper(new BashTool(createSession()), select);

		await expect(
			wrapper.execute("call-1", { command: "cat package.json" }, undefined, undefined, alwaysAskCtx),
		).rejects.toThrow("Use the `read` tool instead of cat/head/tail");

		expect(select).not.toHaveBeenCalled();
	});
});
