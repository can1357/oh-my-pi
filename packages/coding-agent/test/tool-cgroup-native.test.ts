import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_CGROUP_ENV } from "@oh-my-pi/pi-utils/tool-cgroup";
import { PtySession } from "@oh-my-pi/pi-natives";
import { executeBash } from "../src/exec/bash-executor";

/**
 * The delegated cgroup-v2 leaf used by these cases, supplied by the disposable
 * fixture (`scripts/check_agent_tool_isolation.py` in the deployment repo).
 * Real placement needs a delegated hierarchy that ordinary CI does not have, so
 * these report as skipped rather than passing vacuously.
 */
const leaf = process.env.OMP_TEST_TOOL_CGROUP;
const hierarchyPath = leaf?.replace(/^\/sys\/fs\/cgroup/, "");
const originalPolicy = process.env[TOOL_CGROUP_ENV];

afterEach(() => {
	if (originalPolicy === undefined) delete process.env[TOOL_CGROUP_ENV];
	else process.env[TOOL_CGROUP_ENV] = originalPolicy;
});

describe.skipIf(!leaf)("native shell placement", () => {
	it("runs external children inside the leaf and leaves this process outside", async () => {
		process.env[TOOL_CGROUP_ENV] = leaf;
		const cwd = mkdtempSync(path.join(os.tmpdir(), "omp-native-placement-"));
		try {
			// Absolute paths bypass brush's builtin lookup on purpose: builtins run
			// in-process by design, so only an external program exercises the
			// placement hook that prepares the child before it is spawned.
			const first = await executeBash("/bin/cat /proc/self/cgroup", { cwd, timeout: 30_000 });
			const second = await executeBash("/bin/cat /proc/self/cgroup", { cwd, timeout: 30_000 });

			expect(first.exitCode).toBe(0);
			expect(first.output).toContain(hierarchyPath!);
			expect(second.exitCode).toBe(0);
			expect(readFileSync("/proc/self/cgroup", "utf8")).not.toContain(hierarchyPath!);
			// A second call reuses the session created under the same policy, so it
			// must land in the same leaf rather than falling back to the caller's.
			expect(second.output).toContain(hierarchyPath!);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("places a PTY argv launch in the leaf", async () => {
		process.env[TOOL_CGROUP_ENV] = leaf;
		const session = new PtySession();
		let output = "";
		const result = await session.startArgv(
			{
				application: "/bin/cat",
				args: ["/proc/self/cgroup"],
				cwd: os.tmpdir(),
				// portable-pty cannot extend pre_exec, so this path relies on the
				// same argv bootstrap and must land in the same leaf.
				workloadCgroup: leaf,
				timeoutMs: 30_000,
				cols: 80,
				rows: 24,
			},
			(_error, chunk) => {
				if (chunk) output += chunk;
			},
		);
		expect(result.exitCode).toBe(0);
		expect(output).toContain(hierarchyPath!);
	});

	it("keeps arguments literal and preserves the payload's exit status", async () => {
		process.env[TOOL_CGROUP_ENV] = leaf;
		const cwd = mkdtempSync(path.join(os.tmpdir(), "omp-native-args-"));
		try {
			const result = await executeBash("/bin/sh -c \"printf '%s|' a b '*'; printf '\\n'; exit 125\"", {
				cwd,
				timeout: 30_000,
			});
			expect(result.exitCode).toBe(125);
			expect(result.output).toContain("a|b|*");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
