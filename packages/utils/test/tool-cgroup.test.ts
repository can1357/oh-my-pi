import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	configureToolCgroup,
	PLACEMENT_FAILURE_PREFIX,
	resolveToolCgroup,
	TOOL_CGROUP_ENV,
	wrapToolCommand,
} from "@oh-my-pi/pi-utils/tool-cgroup";

/**
 * A delegated cgroup-v2 leaf, provided by the disposable fixture. Real
 * placement cannot be asserted portably — ordinary CI has no delegated
 * hierarchy — so those cases report as skipped rather than passing vacuously.
 */
const leaf = process.env.OMP_TEST_TOOL_CGROUP;

const temporary: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	temporary.push(dir);
	return dir;
}

/** Drop both the configured state and the inherited variable. */
function resetPlacement(): void {
	delete process.env[TOOL_CGROUP_ENV];
	configureToolCgroup(undefined);
}

beforeEach(resetPlacement);
afterEach(() => {
	resetPlacement();
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("placement off", () => {
	it("leaves argv and resolution untouched", () => {
		expect(resolveToolCgroup()).toBeUndefined();
		expect(wrapToolCommand(["echo", "hi"])).toEqual(["echo", "hi"]);
	});

	it("does not treat a blank variable as a target", () => {
		process.env[TOOL_CGROUP_ENV] = "   ";
		expect(resolveToolCgroup()).toBeUndefined();
		expect(wrapToolCommand(["echo", "hi"])).toEqual(["echo", "hi"]);
	});
});

describe("rejected targets", () => {
	it("names the path when the target does not exist", () => {
		expect(() => configureToolCgroup("/nonexistent/omp-tool-cgroup")).toThrow(/\/nonexistent\/omp-tool-cgroup/);
	});

	it("rejects a relative path", () => {
		expect(() => configureToolCgroup("relative/leaf")).toThrow(/must be absolute/);
	});

	it("rejects an ordinary directory that merely contains cgroup.procs", () => {
		const payload = path.join(scratch("omp-fake-cgroup-"), "payload");
		mkdirSync(payload);
		writeFileSync(path.join(payload, "cgroup.procs"), "");
		expect(() => configureToolCgroup(payload)).toThrow(/not under the cgroup-v2 mount/);
	});

	it.skipIf(process.platform !== "linux")("rejects a file that is itself named cgroup.procs", () => {
		const [, , own] = readFileSync("/proc/self/cgroup", "utf8").trim().split(":");
		expect(() => configureToolCgroup(path.join("/sys/fs/cgroup", own!, "cgroup.procs"))).toThrow(/not a directory/);
	});

	it("refuses to contradict an inherited policy instead of widening it", () => {
		process.env[TOOL_CGROUP_ENV] = "/inherited/leaf";
		expect(() => configureToolCgroup("/cli/leaf")).toThrow(/contradicts inherited/);
	});

	it("fails closed when only the variable names a non-cgroup path", () => {
		const dir = scratch("omp-env-cgroup-");
		process.env[TOOL_CGROUP_ENV] = dir;
		expect(() => resolveToolCgroup()).toThrow(/not under the cgroup-v2 mount/);
	});
});

describe.skipIf(!leaf)("delegated leaf", () => {
	it("moves the payload in, keeps the control process out, and lets grandchildren inherit", () => {
		configureToolCgroup(leaf);
		const canonical = resolveToolCgroup();
		expect(canonical).toBeString();
		expect(readFileSync("/proc/self/cgroup", "utf8")).not.toContain(within(canonical!));

		const dir = scratch("omp-placement-");
		const marker = path.join(dir, "child");
		const grandchildMarker = path.join(dir, "grandchild");
		const script = [
			`const fs = require("node:fs")`,
			`const shell = require("node:child_process")`,
			`shell.spawnSync("/bin/sh", ["-c", ${JSON.stringify(`cat /proc/self/cgroup > ${grandchildMarker}`)}])`,
			`fs.writeFileSync(${JSON.stringify(marker)}, fs.readFileSync("/proc/self/cgroup", "utf8"))`,
		].join(";");

		const argv = wrapToolCommand([process.execPath, "-e", script]);
		expect(argv.slice(0, 5)).toEqual(["/bin/sh", "-p", "-c", expect.any(String), "omp-workload"]);
		expect(argv[5]).toBe(canonical!);

		const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(0);
		expect(readFileSync(marker, "utf8")).toContain(within(canonical!));
		expect(existsSync(grandchildMarker)).toBe(true);
		expect(readFileSync(grandchildMarker, "utf8")).toContain(within(canonical!));
	});

	it("keeps arguments literal, cwd, stdio and a payload's own exit status", () => {
		configureToolCgroup(leaf);
		const dir = scratch("omp-argv-");
		const script = `process.stdout.write(process.argv.slice(1).join("\\n") + "\\n" + process.cwd())`;
		const result = Bun.spawnSync(wrapToolCommand([process.execPath, "-e", script, "--", "-x", "a b", "*", "$(id)"]), {
			cwd: dir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(0);
		const [lines] = [result.stdout.toString("utf8").trimEnd().split("\n")];
		expect(lines.slice(0, -1)).toEqual(["-x", "a b", "*", "$(id)"]);
		expect(lines.at(-1)).toBe(realpathSync(dir));

		const payload = Bun.spawnSync(wrapToolCommand([process.execPath, "-e", "process.exit(125)"]));
		expect(payload.exitCode).toBe(125);
	});

	it("reports a placement failure with its literal prefix rather than running anything", () => {
		configureToolCgroup(leaf);
		// No program after the target: the bootstrap must refuse, not exec.
		const result = Bun.spawnSync(wrapToolCommand([]), { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(125);
		expect(result.stderr.toString("utf8")).toContain(PLACEMENT_FAILURE_PREFIX);
	});
});

/** The hierarchy-relative portion of a filesystem cgroup path. */
function within(canonical: string): string {
	return canonical.replace(/^\/sys\/fs\/cgroup/, "");
}
