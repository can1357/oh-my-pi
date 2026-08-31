import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	extractLeadingCdTarget,
	hasTopLevelShellBackground,
	hasTopLevelStatusMaskingOperator,
	hasUnresolvableLeadingCdPrefix,
	resolveLeadingCdChain,
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

	it("accepts top-level && or ; separators", () => {
		expect(extractLeadingCdTarget("cd /tmp; echo ok")).toEqual({ path: "/tmp", rest: "echo ok" });
		expect(extractLeadingCdTarget("cd /tmp;bun test")).toEqual({ path: "/tmp", rest: "bun test" });
		expect(extractLeadingCdTarget("cd /tmp ; bun test")).toEqual({ path: "/tmp", rest: "bun test" });
		expect(extractLeadingCdTarget("cd /foo || echo fail")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp &echo")).toBeNull();
	});

	it("bails when there is no cd target", () => {
		expect(extractLeadingCdTarget("cd  && echo")).toBeNull();
		expect(extractLeadingCdTarget("ls -la")).toBeNull();
		expect(extractLeadingCdTarget("cdx /tmp && ls")).toBeNull();
	});
});

describe("hasUnresolvableLeadingCdPrefix", () => {
	it("is true when cd is present but extractLeadingCdTarget declines", () => {
		expect(hasUnresolvableLeadingCdPrefix("cd /tmp 2>/dev/null && bun test")).toBe(true);
		expect(hasUnresolvableLeadingCdPrefix("cd $HOME && bun test")).toBe(true);
		expect(hasUnresolvableLeadingCdPrefix("FOO=1 cd /tmp >/dev/null && bun test")).toBe(true);
	});

	it("is false for clean extractable cd or commands without cd", () => {
		expect(hasUnresolvableLeadingCdPrefix("cd /tmp && bun test")).toBe(false);
		expect(hasUnresolvableLeadingCdPrefix("cd /tmp; bun test")).toBe(false);
		expect(hasUnresolvableLeadingCdPrefix("FOO=1 cd /tmp && bun test")).toBe(false);
		expect(hasUnresolvableLeadingCdPrefix("bun test")).toBe(false);
		expect(hasUnresolvableLeadingCdPrefix("pwd")).toBe(false);
	});
});

describe("resolveLeadingCdChain", () => {
	it("strips env/sudo and uses the last cd in a chain", () => {
		expect(resolveLeadingCdChain("FOO=1 cd /repo && cd /tmp && bun test")).toEqual({ path: "/tmp" });
		expect(resolveLeadingCdChain("sudo cd /tmp && bun test")).toEqual({ path: "/tmp" });
		expect(resolveLeadingCdChain("  cd /tmp && bun test")).toEqual({ path: "/tmp" });
	});

	it("resolves relative cd targets against the preceding cwd", () => {
		expect(resolveLeadingCdChain("cd /tmp && cd project && bun test")).toEqual({
			path: path.join("/tmp", "project"),
		});
		expect(resolveLeadingCdChain("cd packages && cd foo && bun test")).toEqual({
			path: path.join("packages", "foo"),
		});
		expect(resolveLeadingCdChain("cd /tmp && cd /other && bun test")).toEqual({ path: "/other" });
	});

	it("marks unresolvable when any leading cd cannot be extracted", () => {
		expect(resolveLeadingCdChain("cd /repo && cd /tmp 2>/dev/null && bun test")).toEqual({
			unresolvable: true,
		});
	});

	it("marks unresolvable when cwd changes hide inside a shell group", () => {
		expect(resolveLeadingCdChain("(cd /tmp && bun test)")).toEqual({ unresolvable: true });
		expect(resolveLeadingCdChain("{ cd /tmp; bun test; }")).toEqual({ unresolvable: true });
		expect(resolveLeadingCdChain("bun test")).toEqual({});
	});
});

describe("hasTopLevelShellBackground", () => {
	it("detects a top-level background operator", () => {
		expect(hasTopLevelShellBackground("bun test & true")).toBe(true);
		expect(hasTopLevelShellBackground("bun test&")).toBe(true);
		expect(hasTopLevelShellBackground("bun test && true")).toBe(false);
		expect(hasTopLevelShellBackground('echo "a & b" && bun test')).toBe(false);
	});
});

describe("hasTopLevelStatusMaskingOperator", () => {
	it("detects status-masking operators but not &&", () => {
		expect(hasTopLevelStatusMaskingOperator("bun test || true")).toBe(true);
		expect(hasTopLevelStatusMaskingOperator("bun test; true")).toBe(true);
		expect(hasTopLevelStatusMaskingOperator("bun test | cat")).toBe(true);
		expect(hasTopLevelStatusMaskingOperator("bun test && true")).toBe(false);
		expect(hasTopLevelStatusMaskingOperator('echo "a | b" && bun test')).toBe(false);
	});
});
