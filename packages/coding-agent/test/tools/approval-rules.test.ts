import { describe, expect, it } from "bun:test";
import type { AgentTool, ToolApproval } from "@oh-my-pi/pi-agent-core";
import { denyError, requiresApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	findApprovalPatternRule,
	normalizeApprovalPatternRules,
	normalizeApprovalRules,
	primaryStringArgForTool,
} from "@oh-my-pi/pi-coding-agent/tools/approval-rules";

type ApprovalTool = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

function tool(name: string, approval?: ToolApproval): ApprovalTool {
	return { name, approval };
}

/** RPC-style rule list as it would come from the settings file. */
function rules(...entries: unknown[]): unknown {
	return entries;
}

describe("tools.approvalRules precedence (rule > per-tool policy > mode)", () => {
	it("a matching deny rule beats a per-tool allow policy and mode", () => {
		const subject = tool("bash", { tier: "write", policy: "allow" });
		const resolved = resolveApproval(
			subject,
			{ command: "rm -rf /tmp/junk" },
			"yolo",
			{ bash: "allow" },
			rules({ tool: "bash", match: "rm -rf *", approval: "deny", reason: "destructive" }),
		);
		expect(resolved).toMatchObject({
			policy: "deny",
			source: "rule",
			policyKey: "tools.approvalRules[0]",
			reason: "destructive",
			override: true,
		});
		expect(() =>
			requiresApproval(
				subject,
				{ command: "rm -rf /tmp/junk" },
				"yolo",
				{ bash: "allow" },
				rules({ tool: "bash", match: "rm -rf *", approval: "deny" }),
			),
		).toThrow('Tool "bash" is blocked by an approval rule.');
	});

	it("a matching allow rule beats a tool-sourced deny", () => {
		const subject = tool("bash", {
			tier: "exec",
			override: true,
			policy: "deny",
			reason: "Blocked by bash pattern",
		});
		const resolved = resolveApproval(
			subject,
			{ command: "git status" },
			"always-ask",
			{},
			rules({ tool: "bash", match: "git *", approval: "allow" }),
		);
		expect(resolved).toMatchObject({ policy: "allow", source: "rule" });
	});

	it("a matching prompt rule forces a prompt even in yolo mode", () => {
		const subject = tool("bash", "read");
		const resolved = resolveApproval(
			subject,
			{ command: "git status" },
			"yolo",
			{ bash: "allow" },
			rules({ tool: "bash", match: "git *", approval: "prompt" }),
		);
		expect(resolved).toMatchObject({ policy: "prompt", source: "rule" });
		expect(
			requiresApproval(subject, { command: "git status" }, "yolo", {}, rules({ tool: "bash", approval: "prompt" }))
				.required,
		).toBe(true);
	});

	it("a tool-name-only allow rule covers every call of the tool regardless of mode", () => {
		const subject = tool("bash", "exec");
		expect(
			resolveApproval(
				subject,
				{ command: "anything" },
				"always-ask",
				{},
				rules({ tool: "bash", approval: "allow" }),
			),
		).toMatchObject({ policy: "allow", source: "rule" });
	});

	it("first matching rule wins over later ones", () => {
		const subject = tool("bash", "exec");
		const resolved = resolveApproval(
			subject,
			{ command: "git status" },
			"yolo",
			{},
			rules(
				{ tool: "bash", match: "git *", approval: "allow" },
				{ tool: "bash", match: "git status", approval: "deny" },
			),
		);
		expect(resolved).toMatchObject({ policy: "allow", policyKey: "tools.approvalRules[0]" });
	});

	it("does not apply rules for other tools", () => {
		const subject = tool("global_or_tool", "exec");
		expect(
			resolveApproval(subject, {}, "yolo", {}, rules({ tool: "bash", match: "*", approval: "deny" })),
		).toMatchObject({ policy: "allow", source: "mode" });
	});

	it("keeps per-tool policy authoritative over mode when no rule matches", () => {
		const subject = tool("write", "write");
		expect(
			resolveApproval(
				subject,
				{ path: "a.txt" },
				"yolo",
				{ write: "deny" },
				rules({ tool: "bash", approval: "allow" }),
			),
		).toMatchObject({ policy: "deny", source: "user" });
	});

	it("reports rule-denies distinctly from user-policy denies in denyError", () => {
		const subject = tool("write", "write");
		const resolved = resolveApproval(
			subject,
			{ path: "node_modules/x" },
			"yolo",
			{},
			rules({ tool: "write", match: "node_modules/*", approval: "deny" }),
		);
		const message = (() => {
			try {
				throw denyError(resolved, "write");
			} catch (error) {
				return (error as Error).message;
			}
		})();
		expect(message).toContain("blocked by an approval rule");
		expect(message).toContain('"tools.approvalRules"');
		expect(message).not.toContain("tools.approval.write");
	});
});

describe("tools.approvalRules matching per tool kind", () => {
	const alwaysEnableRule = { tool: "grep", match: "does-not-matter", approval: "allow" } as const;

	it("matches bash rules against the command with shell-aware semantics", () => {
		const subject = tool("bash", "exec");
		// deny fires on a matching segment of a compound line.
		expect(
			resolveApproval(
				subject,
				{ command: "cd /tmp && rm -rf /var/x" },
				"yolo",
				{},
				rules({ tool: "bash", match: "rm -rf /var/*", approval: "deny" }),
			).policy,
		).toBe("deny");
		// allow must vouch for the entire command, never ride a compound line:
		// the rule must NOT fire here, so the resolution falls through to mode.
		expect(
			resolveApproval(
				subject,
				{ command: "git status; rm file.txt" },
				"yolo",
				{},
				rules({ tool: "bash", match: "git *", approval: "allow" }),
			),
		).toMatchObject({ policy: "allow", source: "mode" });
		// A matching segment does not fire a deny rule.
		expect(
			resolveApproval(
				subject,
				{ command: "cd /tmp && ls -la" },
				"yolo",
				{},
				rules({ tool: "bash", match: "rm -rf /var/*", approval: "deny" }),
			).policy,
		).toBe("allow");
	});

	it("matches write rules against the path argument", () => {
		const subject = tool("write", "write");
		expect(
			resolveApproval(
				subject,
				{ path: "src/generated.ts", content: "x" },
				"always-ask",
				{},
				rules({ tool: "write", match: "src/generated.*", approval: "allow" }),
			).policy,
		).toBe("allow");
		expect(
			resolveApproval(
				subject,
				{ path: "lib/other.ts", content: "x" },
				"always-ask",
				{},
				rules({ tool: "write", match: "src/*", approval: "deny" }),
			).policy,
		).toBe("prompt");
	});

	it("matches write rules against the file_path fallback", () => {
		const subject = tool("write", "write");
		expect(
			resolveApproval(
				subject,
				{ file_path: "docs/api.md", content: "x" },
				"always-ask",
				{},
				rules({ tool: "write", match: "docs/*", approval: "allow" }),
			).policy,
		).toBe("allow");
	});

	it("matches edit rules against the path argument", () => {
		const subject = tool("edit", "write");
		expect(
			resolveApproval(
				subject,
				{ path: "src/App.tsx" },
				"always-ask",
				{},
				rules({ tool: "edit", match: "src/App.*", approval: "allow" }),
			).policy,
		).toBe("allow");
	});

	it("ignores the match field for tools without a primary string argument", () => {
		const subject = tool("grep", "read");
		// `grep` has no primary-arg mapping, so anything — including the carried
		// `match` — is ignored and the tool name match alone applies.
		expect(resolveApproval(subject, {}, "always-ask", {}, rules(alwaysEnableRule)).policy).toBe("allow");
	});

	it("skips a match-scoped rule when a primary-arg tool call carries no primary string", () => {
		const subject = tool("edit", "exec");
		// Sloppy edit input-only call: the match-scoped rule cannot be evaluated,
		// so mode governs.
		expect(
			resolveApproval(
				subject,
				{ input: "§src/a.ts\n§\nold\n»\nnew" },
				"write",
				{},
				rules({ tool: "edit", match: "src/generated.*", approval: "allow" }),
			).policy,
		).toBe("prompt");
	});

	it("parses the primary string per the documented mapping", () => {
		expect(primaryStringArgForTool("bash", { command: "echo hi" })).toBe("echo hi");
		expect(primaryStringArgForTool("write", { path: "a.ts", content: "x" })).toBe("a.ts");
		expect(primaryStringArgForTool("write", { file_path: "b.ts", content: "x" })).toBe("b.ts");
		expect(primaryStringArgForTool("edit", { file_path: "c.ts" })).toBe("c.ts");
		expect(primaryStringArgForTool("grep", { path: "d.ts" })).toBeUndefined();
		expect(primaryStringArgForTool("bash", {})).toBeUndefined();
	});
});

describe("approval rule normalization", () => {
	it("drops malformed rules while keeping ordering of valid ones", () => {
		const parsed = normalizeApprovalRules(
			rules(
				{ tool: "bash", approval: "allow" },
				{ tool: "", approval: "deny" },
				{ tool: "write", approval: "maybe" },
				{ tool: "edit" },
				"not-an-object",
				{ tool: "grep", match: "src/*", approval: "prompt", reason: "  review me  " },
				{ tool: "read", match: "", approval: "deny" },
			),
		);
		expect(parsed).toEqual([
			{ tool: "bash", approval: "allow" },
			{ tool: "grep", match: "src/*", approval: "prompt", reason: "review me" },
			{ tool: "read", approval: "deny" },
		]);
	});

	it("normalizes whitespace inside match globs", () => {
		const parsed = normalizeApprovalRules(rules({ tool: "bash", match: "  rm   -rf   *  ", approval: "allow" }));
		expect(parsed[0]?.match).toBe("rm -rf *");
	});

	it("treats non-array approvalRules config as empty", () => {
		expect(normalizeApprovalRules(undefined)).toEqual([]);
		expect(normalizeApprovalRules({ tool: "bash", approval: "deny" })).toEqual([]);
	});

	it("keeps bash.patterns normalization semantics in the shared module", () => {
		const parsed = normalizeApprovalPatternRules([
			{ match: "git *", approval: "allow" },
			{ match: "", approval: "deny" },
			{ match: "rm -rf *", approval: "maybe" },
		]);
		expect(parsed).toEqual([{ match: "git *", approval: "allow" }]);
	});

	it("finds the first matching bash-style pattern with shell-aware semantics", () => {
		const parsed = normalizeApprovalPatternRules([
			{ match: "rm -rf /*", approval: "deny" },
			{ match: "git *", approval: "allow" },
		]);
		expect(findApprovalPatternRule("cd /tmp && rm -rf /var/x", parsed, true)).toEqual({
			match: "rm -rf /*",
			approval: "deny",
		});
		expect(findApprovalPatternRule("git status", parsed, true)).toEqual({ match: "git *", approval: "allow" });
		expect(findApprovalPatternRule("echo hi", parsed, true)).toBeUndefined();
	});
});

// Regression parity with the pre-extraction bash.patterns behavior (the vectors
// from test/tools/approval.test.ts, rerun against the shared matcher that now
// backs BashTool.approval). These run without the native addon, so they double
// as natives-free coverage for the lifted shell-aware matching.
describe("bash.patterns matcher parity (lifted from bash.ts)", () => {
	const allowOnly = normalizeApprovalPatternRules([
		{ match: "git *", approval: "allow" },
		{ match: "rm -rf *", approval: "deny" },
		{ match: "*", approval: "prompt" },
	]);

	it("classifies configured patterns exactly as before", () => {
		for (const command of ["git diff packages/coding-agent/src/tools/bash.ts", "git status", "git log --oneline"]) {
			expect(findApprovalPatternRule(command, allowOnly, true)).toEqual({ match: "git *", approval: "allow" });
		}
		expect(findApprovalPatternRule("rm -rf build", allowOnly, true)).toEqual({
			match: "rm -rf *",
			approval: "deny",
		});
		expect(
			findApprovalPatternRule("git diff packages/coding-agent/src/tools/bash.ts && rm file.txt", allowOnly, true),
		).toEqual({
			match: "*",
			approval: "prompt",
		});
		expect(findApprovalPatternRule("echo hello", allowOnly, true)).toEqual({ match: "*", approval: "prompt" });
	});

	it("applies the first matching pattern", () => {
		const firstWins = normalizeApprovalPatternRules([
			{ match: "*", approval: "allow" },
			{ match: "git *", approval: "deny" },
		]);
		expect(findApprovalPatternRule("git status", firstWins, true)).toEqual({ match: "*", approval: "allow" });
	});

	it("denies a dangerous command buried in a compound line", () => {
		const denied = normalizeApprovalPatternRules([{ match: "rm -rf /*", approval: "deny" }]);
		for (const command of [
			"rm -rf /tmp/scratch-a",
			"cd /tmp && rm -rf /tmp/scratch-b && echo done",
			"echo start; rm -rf /var/x",
			"cat f | rm -rf /var/x",
			"sleep 1 & rm -rf /tmp/scratch-b",
			"(rm -rf /tmp/scratch-b)",
			'cd /tmp && "rm" -rf /tmp/scratch-b',
		]) {
			expect(findApprovalPatternRule(command, denied, true)).toEqual({ match: "rm -rf /*", approval: "deny" });
		}
		// Segments that do not match the glob must not be denied by it.
		expect(findApprovalPatternRule("cd /tmp && rm -rf relative-dir", denied, true)).toBeUndefined();
		expect(findApprovalPatternRule("cd /tmp && ls -la /nope", denied, true)).toBeUndefined();
	});

	it("never auto-approves a command that only prefixes an allow pattern", () => {
		const gitAllow = normalizeApprovalPatternRules([{ match: "git *", approval: "allow" }]);
		for (const command of [
			"git status; rm file.txt",
			"git status && rm file.txt",
			"git status | sh",
			"git status\nrm file.txt",
			"git status\r\nrm file.txt",
			"git $(rm file.txt)",
			"git `rm file.txt` status",
			"git status > /etc/passwd",
			"git -c alias.x='!touch /tmp/pwn; printf ok' x",
			"git status < seed",
			"FOO=1 git status",
			"/usr/bin/git status",
			'"git" status',
			"gitx status",
			"git",
			"",
		]) {
			expect(findApprovalPatternRule(command, gitAllow, true)).toBeUndefined();
		}
		for (const command of ["git status", "git status --short", "git  status", "git\tstatus"]) {
			expect(findApprovalPatternRule(command, gitAllow, true)).toEqual({ match: "git *", approval: "allow" });
		}
	});

	it("allows literal shell metacharacters in quoted arguments", () => {
		const cargoAllow = normalizeApprovalPatternRules([{ match: "cargo *", approval: "allow" }]);
		const command =
			"cargo bench --manifest-path layers/layer3/Cargo.toml --bench standardized_criterion -- --full '^layer3/write/file-wal/batch-(10|1000|10000)$'";
		expect(findApprovalPatternRule(command, cargoAllow, true)).toEqual({ match: "cargo *", approval: "allow" });
	});
});
