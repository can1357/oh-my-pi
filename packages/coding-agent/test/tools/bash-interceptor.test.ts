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

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
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

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
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
		expect(checkBashInterception("echo hi &> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		for (const command of ["echo hi 2>err.txt > out.txt", "echo hi 2>|err.txt > out.txt", "echo hi 2>&1 > out.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		}
	});

	it("keeps scanning past escaped separators and input fd duplication", () => {
		const tools = ["write", "read"];
		for (const command of [
			"echo foo\\; > out.txt",
			"echo a \\| b > out.txt",
			"echo a \\& b > out.txt",
			"echo hi <&0 > out.txt",
			"echo hi 0<&- > out.txt",
			"echo one\\\ntwo > out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo hi <&0", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("keeps separators inside a substitution out of the boundary scan", () => {
		const tools = ["write", "read", "edit"];
		for (const command of [
			"echo ${x:-a;b} > out.txt",
			"echo ${a:-${b}} > out.txt",
			"echo $(( (1 + 2) * 3 )) > out.txt",
			"printf %s ${HOME:-${USER}} >> out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
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
		// A variable the agent set or knows (`$PWD`) is still text it can write itself.
		expect(
			checkBashInterception(
				"printf 'r188 log=%s/logs-box/fit2-r188.log\\n' $PWD > logs-box/fit2-pids.txt",
				tools,
				DEFAULT_BASH_INTERCEPTOR_RULES,
			).suggestedTool,
		).toBe("write");
	});

	it("matches commands with many stderr sinks without exponential backtracking", () => {
		const start = performance.now();
		const echo = checkBashInterception(
			"echo hi" + " 2>/dev/null 2>>/dev/null 2>&1 \\; <&0 $(a; b) `c; d` ${e:-f;g}".repeat(20),
			["write"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		const cat = checkBashInterception(
			`cat${" 2>>/dev/null 2>|e.log".repeat(20)} file.txt`,
			["write", "read"],
			DEFAULT_BASH_INTERCEPTOR_RULES,
		);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(echo.block).toBe(false);
		expect(cat.suggestedTool).toBe("read");
	});

	it("routes cat heredoc and redirect writes to write, not read", () => {
		const tools = ["write", "read", "edit"];
		for (const command of ["cat > /tmp/f <<'EOF'\nx\nEOF", "cat <<'EOF' > /tmp/f\nx\nEOF", "cat >> log.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
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
			"cat 2>err.log file.txt",
			"cat 2>&1 file.txt",
			"cat >&2 file.txt",
			"cat 1>&2 file.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
		}
		for (const command of [
			"cat 2>err.log > out.txt",
			"cat 2> err.log >> out.txt",
			"cat 2>/dev/null 1>out.txt",
			"cat &>out.txt",
			"cat 2>&1 1>out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
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
		expect(decide("LC_ALL=C grep -n x f")).toBe("grep");
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
		["tail -F log", "bash"],
		["tail -n 5 -f log", "bash"],
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
		"grep -nE 'a|b' -A5 f",
		"grep -rIl --include='_CoqProject*' -e 'Proof Using' .",
		"rg -l x",
		"rg -tv -l x .",
		"grep x < f",
	])("refuses %s as a grep", command => {
		expect(decide(command)).toBe("grep");
	});

	it.each([
		// Case 6 of the refusal study: the glob tool has no depth limit.
		"find /srv/deploy -maxdepth 4 -type d -name first-a | head",
		// Sample row 18: a size test.
		'find /theorem-xfs/r15 /theorem-xfs/r14 -maxdepth 9 -name "*.usekey" -size +50k 2>/dev/null | head -3',
		"find . -iname x",
		"find . -name x -newer stamp",
		"find . -name x -exec rm {} +",
		"find . -name x -printf '%s %p\\n'",
		"find . -type l -name x",
		"find . -name x ! -path './build/*'",
		"find . -name .git",
		"find . -name '*.o' | xargs rm",
		"locate foo -name",
		"fd --type f foo",
		"fd --type f 'a.*b'",
	])("does not refuse %s as a glob", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		"find . -name '*.v'",
		"find a b -type f -name '*.v' | head -20",
		"find . \\( -name 'thermonuclear*' -o -name reviewer.md \\)",
		"find . -name '*.v' -not -path '*/.git/*'",
		"find . -path ./node_modules -prune -o -name '*.ts' -print",
		"fd --type f Foo",
		"fd --type f -s foo",
	])("refuses %s as a glob", command => {
		expect(decide(command)).toBe("glob");
	});

	it.each([
		"perl x.pl -input data",
		"perl -e 'print \"-i\"' f",
		"awk '{print \"-i inplace\"}' f",
		"sed -i 's/a/b/' *.v",
	])("does not refuse %s as an edit", command => {
		expect(decide(command)).toBeUndefined();
	});

	it.each([
		"perl -pi -e 's/a/b/' f",
		"perl -i.bak -pe 's/a/b/' f",
		"perl -0777 -i -pe 's/a/b/' f",
		"awk -i inplace '{print}' f",
		"sed -i 's/a/b/' f.v",
	])("refuses %s as an edit", command => {
		expect(decide(command)).toBe("edit");
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
