import { describe, expect, test } from "bun:test";
import { buildBunCommand, rustTestCommand, workspaceTestCommand } from "./ci-test-ts";
import { requireBunVersion } from "./require-bun";

// INF-2, part (b): every child process the test runner spawns must run under
// the same Bun executable that started the runner (process.execPath), never a
// PATH-resolved "bun". The consumer contract: the command array the runner
// hands to Bun.spawn. Regression: the array was ["bun", ...], so a runner
// started with an explicit binary (CI matrix, ~/.bun/bin vs /usr/local/bin)
// silently switched tools on every chunk — including spawning a 1.3.x `bun`
// that recurses into `check` (exit 23) while the parent was 1.4.4.
describe("buildBunCommand", () => {
	test("builds every child argv from process.execPath, not a PATH lookup", () => {
		expect(buildBunCommand(["test", "--parallel=1"])).toEqual([process.execPath, "test", "--parallel=1"]);
	});

	test("returns the bare executable when no args follow", () => {
		expect(buildBunCommand([])).toEqual([process.execPath]);
	});

	// The two command factories that carry a spawn argv: one proves the `bun
	// test` shape, the other the script-delegate shape (`bun scripts/…`).
	test("workspace test commands run the running executable", () => {
		const command = workspaceTestCommand("packages/utils", 8);
		expect(command.command).toEqual([process.execPath, "test"]);
	});

	test("the rust delegate command runs the running executable", () => {
		const command = rustTestCommand();
		expect(command.command).toEqual([process.execPath, "scripts/run-rs-task.ts", "test:rs"]);
	});
});

// INF-2, part (a): the version guard. The repo's minimum Bun is the root
// `packageManager` field; under an older Bun the guard must fail naming the
// found version, the required version, and the executable that is too old —
// the message a developer sees when `bun check` would instead recurse into
// the package `check` script and die with exit 23.
describe("requireBunVersion", () => {
	test("throws naming found version, required version, and the executable path", () => {
		const executable = "/usr/local/bin/bun";
		let thrown: unknown;
		try {
			requireBunVersion({ foundVersion: "1.3.14", requiredVersion: "1.4.4", executablePath: executable });
		} catch (err) {
			thrown = err;
		}
		// The whole contract is the message: it names what was found (1.3.14),
		// what the repo requires (1.4.4), and which binary is too old.
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("1.3.14");
		expect((thrown as Error).message).toContain("1.4.4");
		expect((thrown as Error).message).toContain(executable);
	});

	test("passes at the required version and above", () => {
		expect(() =>
			requireBunVersion({ foundVersion: "1.4.4", requiredVersion: "1.4.4", executablePath: process.execPath }),
		).not.toThrow();
		expect(() =>
			requireBunVersion({ foundVersion: "1.5.0", requiredVersion: "1.4.4", executablePath: process.execPath }),
		).not.toThrow();
	});
});
