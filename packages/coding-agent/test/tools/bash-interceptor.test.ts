import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashInterceptorRule } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { bashInterception, checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

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
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
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
		const tools = ["write", "read"];
		for (const command of [
			"echo $(printf foo; printf bar) > out.txt",
			"echo `date; ls` > out.txt",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell/JS text under test
			"echo ${x:-a;b} > out.txt",
			"echo $(ls > /dev/null) > out.txt",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell/JS text under test
			"echo ${a:-${b}} > out.txt",
			"echo $(( (1 + 2) * 3 )) > out.txt",
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell/JS text under test
			"printf %s ${HOME:-${USER}} >> out.txt",
		]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("echo $(ls) ; ls > f", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		// oxlint-disable-next-line no-template-curly-in-string -- literal shell/JS text under test
		expect(checkBashInterception("echo ${a:-${b}}; ls 2>e.log", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception("echo $(printf a; printf b)", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
	});

	it("matches commands with many stderr sinks without exponential backtracking", () => {
		const start = performance.now();
		const echo = checkBashInterception(
			// oxlint-disable-next-line no-template-curly-in-string -- literal shell/JS text under test
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
		const tools = ["write", "read"];
		for (const command of ["cat > /tmp/f <<'EOF'\nx\nEOF", "cat <<'EOF' > /tmp/f\nx\nEOF", "cat >> log.txt"]) {
			expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("write");
		}
		expect(checkBashInterception("cat <<'EOF'\nx\nEOF", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("cat file.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).suggestedTool).toBe("read");
	});

	it("keeps cat on read unless its stdout goes to a file", () => {
		const tools = ["write", "read"];
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

describe("default Perl in-place rule", () => {
	it.each([
		`perl -e 'print "re-index\\n"'`,
		"perl script.pl -i",
		"perl -- -i",
		"perl -e 1 -- -i",
		"perl -e -i",
		"perl -e'print q( -i )'",
		"perl -I -include -e 1",
		"perl -Ilib -MList::Util=min -e 1",
		"perl -Ci -e 1",
	])("does not route %s to edit", command => {
		expect(checkBashInterception(command, ["edit"]).block).toBe(false);
	});

	it.each([
		"perl -lpi -e 's/a/b/' f",
		"perl -i.bak -pe 's/a/b/' f",
		"perl -0777 -Mstrict -pi -e 1 f",
		"perl -e 's/a/b/' -pi f",
		"perl -I 'some lib' -ni -e 1 f",
		"perl -C -pi -e 1 f",
		"perl -x -pi f",
	])("routes %s to edit", command => {
		expect(checkBashInterception(command, ["edit"]).suggestedTool).toBe("edit");
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

	it("still blocks a standalone grep sequenced after a pipeline", () => {
		expect(
			checkBashInterception("cat log | tr a b && grep err file", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
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

describe("tool-less policy rules", () => {
	const sleepPolicyRules: BashInterceptorRule[] = [
		{
			pattern: "^\\s*sleep\\s+(?:[1-9]\\d+(?:\\.\\d+)?[smhd]?|\\d+(?:\\.\\d+)?[mhd])(?:\\s|$)",
			message: "Do not poll with sleep; use wait or an event listener.",
		},
		{
			pattern: "(?:^|[;&|\\n])\\s*(?:while|until)\\b[\\s\\S]*\\bsleep\\b",
			message: "Do not run shell polling loops; use wait or an event listener.",
		},
	];

	it("blocks unconditionally when rule.tool is omitted even if availableTools is empty", () => {
		const res = checkBashInterception("sleep 30", [], sleepPolicyRules);
		expect(res.block).toBe(true);
		expect(res.suggestedTool).toBeUndefined();
		expect(res.message).toContain("Do not poll with sleep");
	});

	it("treats whitespace-only rule.tool as unconditional and omits suggestedTool", () => {
		const res = checkBashInterception(
			"sleep 30",
			[],
			[{ pattern: "^\\s*sleep\\s+\\d+", tool: "   ", message: "No sleep." }],
		);
		expect(res.block).toBe(true);
		expect(res.suggestedTool).toBeUndefined();
	});

	it("blocks polling sleep variants while allowing short settle delays, quotes, and comments", () => {
		for (const blocked of [
			"sleep 30",
			"sleep 10s",
			"sleep 1m",
			"FOO=1 sleep 60",
			"gh pr checks && sleep 15",
			"while true; do gh pr checks; sleep 2; done",
			"until false; do sleep 5; done",
		]) {
			expect(checkBashInterception(blocked, [], sleepPolicyRules).block).toBe(true);
		}
		for (const allowed of [
			"sleep 2",
			"sleep 5",
			'echo "sleep 30"',
			"echo ok # sleep 60",
			"printf 'while true; do sleep 5; done'",
		]) {
			expect(checkBashInterception(allowed, [], sleepPolicyRules).block).toBe(false);
		}
	});

	it("rejects via BashTool.execute even when ctx.toolNames is empty", async () => {
		const tool = createBashTool(sleepPolicyRules);
		await expect(
			tool.execute("tool-call", { command: "gh pr checks && sleep 30" }, undefined, undefined, {
				toolNames: [],
			} as unknown as AgentToolContext),
		).rejects.toThrow("Do not poll with sleep");
	});

	it("keeps tool-less rules for named bash services while dropping tool=bash rules", () => {
		const settings = Settings.isolated({
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": [
				{ pattern: "^\\s*nohup\\s+", tool: "bash", message: "Use bash with name." },
				{ pattern: "^\\s*sleep\\s+\\d+", message: "No sleep." },
			],
		});
		expect(bashInterception(settings, "nohup echo hi", "nohup echo hi", "svc", ["bash"], new Set())).toBeUndefined();
		expect(bashInterception(settings, "sleep 30", "sleep 30", "svc", ["bash"], new Set())).toContain("No sleep.");
	});

	it("skips malformed rules without throwing", () => {
		const malformed = [
			{ pattern: "", message: "empty pattern" },
			{ pattern: "[unclosed", message: "bad regex" },
			{ pattern: "^\\s*sleep\\s+30", message: "valid rule" },
		] as BashInterceptorRule[];
		expect(checkBashInterception("sleep 30", [], malformed).block).toBe(true);
		expect(checkBashInterception("echo ok", [], malformed).block).toBe(false);
	});

	it("seeded property/fuzz pass: linear runtime, zero throws, exact tool-scoping invariants", () => {
		let state = 0x5eed1234;
		const nextInt = (max: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % max;
		};
		const benignTokens = [
			"echo hi",
			"ls -la",
			"git status",
			"sleep 2",
			"true",
			'echo "sleep 30"',
			"echo ok # sleep 60",
		];
		const sepTokens = [" && ", "; ", " || ", "\n", " | "];
		const envPrefixes = ["", "FOO=1 ", 'BAR="a b" '];
		const mixedRules: BashInterceptorRule[] = [
			{ pattern: "^\\s*sleep\\s+[1-9]\\d+\\b", message: "No long sleep." },
			{ pattern: "^\\s*cat\\s+", tool: "read", message: "Use read." },
			{ pattern: "[broken(", message: "Invalid." },
		];

		const started = performance.now();
		for (let i = 0; i < 300; i++) {
			const parts: string[] = [];
			const count = 1 + nextInt(4);
			for (let j = 0; j < count; j++) {
				const env = envPrefixes[nextInt(envPrefixes.length)]!;
				const tok = benignTokens[nextInt(benignTokens.length)]!;
				parts.push(`${env}${tok}`);
			}
			const benignCmd = parts.reduce(
				(acc, part, idx) => (idx === 0 ? part : `${acc}${sepTokens[nextInt(sepTokens.length)]}${part}`),
				"",
			);
			// Benign commands never trigger the long-sleep or cat rules.
			expect(checkBashInterception(benignCmd, [], mixedRules).block).toBe(false);
			expect(checkBashInterception(benignCmd, ["read"], mixedRules).block).toBe(false);

			// Injecting a real unpiped long sleep on a new line (so a trailing # comment cannot swallow it) triggers regardless of availableTools.
			const sleepCmd = `${benignCmd}\nsleep ${10 + nextInt(90)}`;
			const sleepRes = checkBashInterception(sleepCmd, [], mixedRules);
			expect(sleepRes.block).toBe(true);
			expect(sleepRes.suggestedTool).toBeUndefined();

			// Injecting cat blocks ONLY when `read` is in availableTools.
			const catCmd = `${benignCmd}\ncat file.txt`;
			expect(checkBashInterception(catCmd, [], mixedRules).block).toBe(false);
			const catRes = checkBashInterception(catCmd, ["read"], mixedRules);
			expect(catRes.block).toBe(true);
			expect(catRes.suggestedTool).toBe("read");
		}
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
