import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bunFloor } from "./check-bun-floor";

const REPO_ROOT = path.join(import.meta.dir, "..");
const ACTION_FILE = path.join(REPO_ROOT, ".github/actions/bun-install/action.yml");
const GUARD_FILE = path.join(REPO_ROOT, "scripts/check-bun-floor.ts");

interface ActionStep {
	id?: string;
	run?: string;
}

interface SetupOutcome {
	exitCode: number;
	outputs: Record<string, string>;
	log: string;
}

/** The Bun floor the repo declares, i.e. the version the gate accepts. */
const FLOOR = await (async () => {
	const manifest = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as { packageManager?: unknown };
	const floor = bunFloor(manifest.packageManager);
	if (floor === undefined) throw new Error("root package.json declares no bun floor");
	return floor;
})();

const [MAJOR, MINOR, PATCH] = FLOOR.split(".").map(part => Number.parseInt(part, 10) || 0);
/** The newest release that no longer satisfies the floor. */
const BELOW_FLOOR = PATCH > 0 ? `${MAJOR}.${MINOR}.${PATCH - 1}` : `${MAJOR}.${Math.max(MINOR - 1, 0)}.0`;
/** A release that satisfies the floor. */
const ABOVE_FLOOR = `${MAJOR}.${MINOR + 1}.0`;
/** A prerelease of the floor: newer than the floor by build number, older by semver. */
const CANARY_FLOOR = `${FLOOR}-canary.1`;

/** The composite action's "Detect environment" step, as the shell GitHub runs it. */
async function readDetectStep(): Promise<string> {
	const action = Bun.YAML.parse(await Bun.file(ACTION_FILE).text()) as { runs?: { steps?: ActionStep[] } };
	const step = action.runs?.steps?.find(candidate => candidate.id === "env");
	if (step?.run === undefined) throw new Error("bun-install action has no runnable 'env' step");
	return step.run;
}

/**
 * Run the detect step against a runner that already ships `version`.
 *
 * The fake Bun reports the fixture version for `--version` and hands every
 * other invocation to the real Bun, so the guard's own comparison decides the
 * outcome exactly as it would on a runner.
 */
async function runDetectStep(version: string, cwd: string = REPO_ROOT): Promise<SetupOutcome> {
	const script = await readDetectStep();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-install-"));
	try {
		const binDir = path.join(dir, "bin");
		await fs.mkdir(binDir);
		await fs.writeFile(
			path.join(binDir, "bun"),
			[
				"#!/usr/bin/env bash",
				'if [ "$1" = "--version" ]; then',
				"  printf '%s\\n' \"$FAKE_BUN_VERSION\"",
				"  exit 0",
				"fi",
				'exec "$FAKE_BUN_REAL" "$@"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const outputFile = path.join(dir, "github_output");
		await fs.writeFile(outputFile, "");
		const proc = Bun.spawn(["bash", "-c", script], {
			cwd,
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				GITHUB_OUTPUT: outputFile,
				FAKE_BUN_VERSION: version,
				FAKE_BUN_REAL: process.execPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		const outputs: Record<string, string> = {};
		for (const line of (await Bun.file(outputFile).text()).split("\n")) {
			const separator = line.indexOf("=");
			if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
		}
		return { exitCode, outputs, log: `${stdout}${stderr}` };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function runGuard(args: string[]): Promise<number> {
	const proc = Bun.spawn([process.execPath, GUARD_FILE, ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return await proc.exited;
}

describe("bun-install setup decision", () => {
	// A runner whose Bun satisfies the declared floor is reused as-is: installing
	// a fresh Bun would only cost the job a download.
	test("keeps a preloaded Bun that satisfies the declared floor", async () => {
		const outcome = await runDetectStep(FLOOR);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.outputs.setup_bun).toBe("false");
	});

	test("keeps a preloaded Bun newer than the declared floor", async () => {
		const outcome = await runDetectStep(ABOVE_FLOOR);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.outputs.setup_bun).toBe("false");
	});

	// A Bun below the floor cannot run `bun --check`; the job would report a
	// green type check without checking a file.
	test("installs a preloaded Bun below the declared floor", async () => {
		const outcome = await runDetectStep(BELOW_FLOOR);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.outputs.setup_bun).toBe("true");
	});

	// A prerelease of the floor sorts below the floor, so the gate rejects the
	// runtime it would keep — the setup must not hand the job a runtime the
	// gate then refuses.
	test("installs a prerelease of the declared floor", async () => {
		const outcome = await runDetectStep(CANARY_FLOOR);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.outputs.setup_bun).toBe("true");
		expect(outcome.log).toContain("does not satisfy");
	});

	// An exact pin is a different contract: only that build is acceptable, and
	// the install carries the release tag.
	test("keeps the exact pinned Bun and installs every other build", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-install-pin-"));
		try {
			await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ packageManager: `bun@${FLOOR}` }));
			const keep = await runDetectStep(FLOOR, dir);
			expect(keep.exitCode).toBe(0);
			expect(keep.outputs.setup_bun).toBe("false");

			const replace = await runDetectStep(ABOVE_FLOOR, dir);
			expect(replace.exitCode).toBe(0);
			expect(replace.outputs.setup_bun).toBe("true");
			expect(replace.outputs.bun_install).toBe(`bun-v${FLOOR}`);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("check-bun-floor --satisfies", () => {
	// The setup step reads the guard's answer through its exit code, so the
	// guard has to answer for the candidate runtime and never fall through to
	// the check it runs for the Bun that is executing it.
	test("answers for the candidate runtime and fails loudly on a usage error", async () => {
		expect(await runGuard(["--satisfies", FLOOR])).toBe(0);
		expect(await runGuard(["--satisfies", ABOVE_FLOOR])).toBe(0);
		expect(await runGuard(["--satisfies", BELOW_FLOOR])).toBe(1);
		expect(await runGuard(["--satisfies", CANARY_FLOOR])).toBe(1);
		expect(await runGuard(["--satisfies"])).toBe(2);
		expect(await runGuard(["--unknown-flag", FLOOR])).toBe(2);
	});
});
