import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { validateToolArguments } from "@pk-nerdsaver-ai/pi-ai/utils/validation";
import {
	type BashInterceptorRule,
	DEFAULT_BASH_INTERCEPTOR_RULES,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@pk-nerdsaver-ai/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@pk-nerdsaver-ai/pi-coding-agent/tools/bash-interceptor";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: {
			get(key: string) {
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
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

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
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

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
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

describe("BashTool head/tail stripping", () => {
	function createBashToolWithStrip(stripEnabled: boolean): BashTool {
		const session = {
			cwd: process.cwd(),
			settings: {
				get(key: string) {
					if (key === "bashInterceptor.enabled") return false;
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bash.autoBackground.thresholdMs") return 60_000;
					if (key === "bash.stripTrailingHeadTail") return stripEnabled;
					return undefined;
				},
				getBashInterceptorRules() {
					return [];
				},
			},
		} as unknown as ToolSession;
		return new BashTool(session);
	}

	it("executes the stripped command", async () => {
		const tool = createBashToolWithStrip(true);
		// `seq 1 100 | head -3` would emit "1\n2\n3"; stripped, it emits 1..100.
		// We assert on the tail of the output rather than head, so a successful
		// strip is observable: line "100" only appears when head is gone.
		const result = await tool.execute("tool-call", { command: "seq 1 100 | head -3" }, undefined, undefined, {
			toolNames: ["bash"],
		} as AgentToolContext);
		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("100");
	});

	it("does not strip when the setting is disabled", async () => {
		const tool = createBashToolWithStrip(false);
		const result = await tool.execute("tool-call", { command: "seq 1 100 | head -3" }, undefined, undefined, {
			toolNames: ["bash"],
		} as AgentToolContext);
		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("1\n2\n3");
		expect(text).not.toContain("100");
	});
});
