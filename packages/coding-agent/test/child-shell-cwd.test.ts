import { expect, it } from "bun:test";
import { resolveLeadingCdChain } from "../src/tools/shell-tokenize";

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
