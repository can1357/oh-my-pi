import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { parseWorkloadSpec, resolveWorkloadArgs } from "@oh-my-pi/pi-coding-agent/workload/spec";
import { runWorkload } from "@oh-my-pi/pi-coding-agent/workload/runner";

// Contract: the engine walks the planned waves, threads each step's output into
// the next step's templates, fans `for_each` out one execution per element, and
// applies `retries` / `on_failure` before deciding the run's exit status.
// Shell (`run`) steps need no model, so the whole engine is exercised here
// without a provider: a workload with no `prompt` step never creates a session.

const roots: string[] = [];

async function tempCwd(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workload-run-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

async function run(yaml: string, options: { set?: string[]; cwd?: string; concurrency?: number } = {}) {
	const spec = parseWorkloadSpec(yaml, "/tmp/test.yml");
	const args = resolveWorkloadArgs(spec, options.set ?? []);
	const cwd = options.cwd ?? (await tempCwd());
	return runWorkload(spec, args, {
		cwd,
		...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
	});
}

describe("runWorkload", () => {
	it("threads one step's stdout into a later step's arguments", async () => {
		const result = await run(`
name: chain
args:
  who: { default: "world" }
steps:
  - id: greet
    run: ["echo", "hello \${args.who}"]
  - id: echo_back
    needs: [greet]
    run: ["echo", "saw: \${steps.greet.stdout}"]
`);
		expect(result.status).toBe("ok");
		expect(result.steps.map(step => step.id)).toEqual(["greet", "echo_back"]);
		expect(result.steps.every(step => step.kind === "shell")).toBe(true);
		// No prompt step, so no session and no ledger were created.
		expect(result.sessionFile).toBeUndefined();
	});

	it("exposes exit_code and treats a non-zero shell step as a failure", async () => {
		const result = await run(`
name: gate
steps:
  - id: fails
    run: ["false"]
    on_failure: continue
  - id: report
    needs: [fails]
    run: ["echo", "code=\${steps.fails.exit_code}"]
`);
		expect(result.status).toBe("failed");
		const failed = result.steps.find(step => step.id === "fails");
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toMatch(/exit 1/);
		// `continue` keeps the run going, but a dependent of a failed step is
		// still skipped: its inputs never materialized.
		const report = result.steps.find(step => step.id === "report");
		expect(report?.status).toBe("skipped");
		expect(report?.skipReason).toMatch(/needs "fails"/);
	});

	it("fans a for_each step out over a JSON list produced by an earlier step", async () => {
		const cwd = await tempCwd();
		const result = await run(
			`
name: fanout
steps:
  - id: list
    run: ["echo", "[\\"alpha\\",\\"beta\\",\\"gamma\\"]"]
  - id: touch_each
    needs: [list]
    for_each: "\${steps.list.output}"
    concurrency: 2
    run: ["touch", "\${item}-\${item_index}.txt"]
`,
			{ cwd },
		);
		expect(result.status).toBe("ok");
		const fan = result.steps.find(step => step.id === "touch_each");
		expect(fan?.items).toBe(3);
		expect((await fs.readdir(cwd)).sort()).toEqual(["alpha-0.txt", "beta-1.txt", "gamma-2.txt"]);
	});

	it("fails the whole fan-out step when one item fails, naming the count", async () => {
		const result = await run(`
name: partial
steps:
  - id: list
    run: ["echo", "[\\"ok\\",\\"\\"]"]
  - id: check
    needs: [list]
    for_each: "\${steps.list.output}"
    run: ["test", "-n", "\${item}"]
`);
		expect(result.status).toBe("failed");
		expect(result.steps.find(step => step.id === "check")?.error).toMatch(/1\/2 items failed/);
	});

	it("retries a failing step up to its retry budget", async () => {
		const result = await run(`
name: retry
steps:
  - id: doomed
    run: ["false"]
    retries: 2
`);
		expect(result.status).toBe("failed");
		expect(result.steps[0]?.attempts).toBe(3);
	});

	it("aborts downstream waves on failure but lets independent branches finish", async () => {
		const cwd = await tempCwd();
		const result = await run(
			`
name: abort
steps:
  - id: broken
    run: ["false"]
  - id: sibling
    run: ["touch", "sibling.txt"]
  - id: downstream
    needs: [broken]
    run: ["touch", "downstream.txt"]
`,
			{ cwd },
		);
		expect(result.status).toBe("failed");
		// Same wave as the failure: it was already launched, so it completes.
		expect(result.steps.find(step => step.id === "sibling")?.status).toBe("ok");
		const downstream = result.steps.find(step => step.id === "downstream");
		expect(downstream?.status).toBe("skipped");
		expect(downstream?.skipReason).toMatch(/on_failure: abort/);
		expect(await fs.readdir(cwd)).toEqual(["sibling.txt"]);
	});

	it("reports a for_each expression that is not a list instead of spawning", async () => {
		const result = await run(`
name: badfan
steps:
  - id: text
    run: ["echo", "not a list"]
  - id: fan
    needs: [text]
    for_each: "\${steps.text.output}"
    run: ["echo", "\${item}"]
`);
		expect(result.status).toBe("failed");
		expect(result.steps.find(step => step.id === "fan")?.error).toMatch(/fan-out needs a list/);
	});

	it("reports an unknown template reference as a step failure, not a crash", async () => {
		const result = await run(`
name: badref
steps:
  - id: oops
    run: ["echo", "\${args.nope}"]
`);
		expect(result.status).toBe("failed");
		expect(result.steps[0]?.error).toMatch(/args\.nope/);
	});
});
