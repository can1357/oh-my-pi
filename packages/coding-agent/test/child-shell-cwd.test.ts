import { expect, it } from "bun:test";
import { resolveLeadingCdChain } from "../src/tools/shell-tokenize";
import { isTautologicalParentVerifyCommand } from "../src/session/settle-gates";

it("does not clear verification for status-masked child-shell checks", () => {
	expect(isTautologicalParentVerifyCommand("bash -c 'bun test || true'")).toBe(true);
	expect(isTautologicalParentVerifyCommand("bash -c 'true'")).toBe(true);
	expect(isTautologicalParentVerifyCommand("bash -c '! bun test'")).toBe(true);
	expect(isTautologicalParentVerifyCommand("bash -c 'bun test &'")).toBe(true);
	expect(isTautologicalParentVerifyCommand("bash -c \"sh -c 'bun test | cat'\"")).toBe(true);
	expect(isTautologicalParentVerifyCommand("bash -c 'bun test'")).toBe(false);
});

it("declines verifier-local cwd overrides instead of crediting the parent repository", () => {
	for (const command of [
		"bun --cwd /tmp test",
		"npm --prefix=/tmp test",
		"make -C/tmp test",
		"bash -c 'bun --cwd /tmp test'",
	]) {
		expect(resolveLeadingCdChain(command)).toEqual({ unresolvable: true });
	}
	expect(resolveLeadingCdChain("bun test packages/ai/test/example.test.ts")).toEqual({});
});

it("declines a cwd-changing child script instead of trusting the parent cwd", () => {
	expect(resolveLeadingCdChain("bash -c 'cd /tmp && bun test'")).toEqual({ unresolvable: true });
});

it("finds cwd changes behind a login shell and env wrapper", () => {
	expect(resolveLeadingCdChain('env FOO=1 /bin/zsh -lc "cd /tmp && bun test"')).toEqual({ unresolvable: true });
});

it("finds cwd changes inside nested child-shell scripts", () => {
	expect(resolveLeadingCdChain("bash -c \"sh -c 'cd /tmp && bun test'\"")).toEqual({ unresolvable: true });
});

it("allows a child shell whose script does not change directories", () => {
	expect(resolveLeadingCdChain("bash -c 'bun test'")).toEqual({});
});

it("finds an immediately grouped cwd change inside a child shell", () => {
	expect(resolveLeadingCdChain("bash -c '(cd /tmp && bun test)'")).toEqual({ unresolvable: true });
});
