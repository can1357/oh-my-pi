import { describe, expect, it } from "bun:test";
import { STRING_VALUE_FLAGS } from "../src/cli/flag-tables";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

const FLAG = "--tool-cgroup";
const LEAF = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/omp-workload-host.service/payload";

describe("--tool-cgroup bootstrap extraction", () => {
	it("captures a separate value and leaves it for the launch parser", () => {
		const extracted = extractProfileFlags([FLAG, LEAF, "explain this"]);
		expect(extracted.toolCgroup).toBe(LEAF);
		expect(extracted.argv).toEqual([FLAG, LEAF, "explain this"]);
	});

	it("captures an inline value", () => {
		const extracted = extractProfileFlags([`${FLAG}=${LEAF}`, "explain this"]);
		expect(extracted.toolCgroup).toBe(LEAF);
		expect(extracted.argv).toEqual([`${FLAG}=${LEAF}`, "explain this"]);
	});

	it("keeps a flag-looking value literal instead of treating it as another flag", () => {
		const extracted = extractProfileFlags([FLAG, "--weird-leaf"]);
		expect(extracted.toolCgroup).toBe("--weird-leaf");
	});

	it("requires a value", () => {
		expect(() => extractProfileFlags([FLAG])).toThrow(/requires a cgroup path/);
		expect(() => extractProfileFlags([`${FLAG}=`])).toThrow(/requires a cgroup path/);
	});

	it("does not steal the flag from a subcommand or from after --", () => {
		expect(extractProfileFlags(["grep", FLAG, LEAF]).toolCgroup).toBeUndefined();
		expect(extractProfileFlags(["--", FLAG, LEAF]).toolCgroup).toBeUndefined();
	});

	it("composes with profile selection and surrounding messages", () => {
		const extracted = extractProfileFlags([FLAG, LEAF, "--profile", "work", "--print", "fix the bug"]);
		expect(extracted.toolCgroup).toBe(LEAF);
		expect(extracted.profile).toBe("work");
		expect(extracted.argv).toEqual([FLAG, LEAF, "--print", "fix the bug"]);
	});

	it("is registered as a string-valued flag so parseArgs assigns it", () => {
		// `STRING_SETTERS`/`STRING_VALUE_FLAGS` are the single classification that
		// both the bootstrap and `parseArgs` read; membership here is what makes
		// `args.toolCgroup` populated for every call form.
		expect(STRING_VALUE_FLAGS.has(FLAG)).toBe(true);
	});
});

describe("fail-closed configuration", () => {
	it("rejects an unusable target before any payload can start", async () => {
		// A separate process: the module freezes its policy on first use, and the
		// contract that matters is the exit status and message an operator sees.
		const script = `
			import { configureToolCgroup } from "@oh-my-pi/pi-utils/tool-cgroup";
			configureToolCgroup("/nonexistent/omp-tool-cgroup");
			console.log("configured anyway");
		`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...Bun.env, OMP_TOOL_CGROUP: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).not.toBe(0);
		expect(proc.stderr.toString("utf8")).toContain("/nonexistent/omp-tool-cgroup");
		expect(proc.stdout.toString("utf8")).not.toContain("configured anyway");
	});
});
