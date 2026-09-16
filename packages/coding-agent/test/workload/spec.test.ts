import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
	discoverWorkloads,
	loadWorkload,
	parseWorkloadSpec,
	resolveWorkloadArgs,
	WorkloadSpecError,
} from "@oh-my-pi/pi-coding-agent/workload/spec";

// Contract: a workload file is rejected before anything spawns when it cannot
// finish — unknown/duplicate ids, cycles, an unrunnable step shape — and its
// execution waves are the topological grouping the runner then walks.

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workload-spec-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

const MINIMAL = `
name: probe
steps:
  - id: only
    prompt: do the thing
`;

describe("parseWorkloadSpec", () => {
	it("defaults version, agent, concurrency, retries, and failure policy", () => {
		const spec = parseWorkloadSpec(MINIMAL, "/tmp/probe.yml");
		expect(spec.version).toBe(1);
		expect(spec.steps[0]?.agent).toBe("task");
		expect(spec.steps[0]?.concurrency).toBe(8);
		expect(spec.steps[0]?.retries).toBe(0);
		expect(spec.steps[0]?.onFailure).toBe("abort");
		expect(spec.steps[0]?.effort).toBeUndefined();
		expect(spec.waves).toEqual([["only"]]);
	});

	it("folds defaults into every step while per-step values still win", () => {
		const spec = parseWorkloadSpec(
			`
name: probe
defaults:
  agent: scout
  model: "@smol"
  effort: lo
  concurrency: 2
  on_failure: continue
steps:
  - id: inherits
    prompt: a
  - id: overrides
    prompt: b
    agent: reviewer
    model: "openai/gpt-5.4:high"
    effort: hi
    concurrency: 5
    on_failure: abort
`,
			"/tmp/probe.yml",
		);
		expect(spec.steps[0]).toMatchObject({
			agent: "scout",
			model: "@smol",
			effort: "lo",
			concurrency: 2,
			onFailure: "continue",
		});
		expect(spec.steps[1]).toMatchObject({
			agent: "reviewer",
			model: "openai/gpt-5.4:high",
			effort: "hi",
			concurrency: 5,
			onFailure: "abort",
		});
	});

	it("groups independent steps into one wave and dependents into later waves", () => {
		const spec = parseWorkloadSpec(
			`
name: probe
steps:
  - id: a
    prompt: a
  - id: b
    prompt: b
  - id: c
    prompt: c
    needs: [a, b]
  - id: d
    prompt: d
    needs: [c]
`,
			"/tmp/probe.yml",
		);
		expect(spec.waves).toEqual([["a", "b"], ["c"], ["d"]]);
	});

	it("rejects a step that is neither a prompt nor a run, and one that is both", () => {
		expect(() => parseWorkloadSpec(`name: p\nsteps:\n  - id: x\n`, "/tmp/p.yml")).toThrow(/neither was set/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: x\n    prompt: a\n    run: ["echo", "hi"]\n`, "/tmp/p.yml"),
		).toThrow(/both were set/);
	});

	it("rejects agent-only fields on a run step", () => {
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: x\n    run: ["echo"]\n    model: "@smol"\n`, "/tmp/p.yml"),
		).toThrow(/is a `run` step/);
	});

	it("rejects a dependency cycle, a self-dependency, an unknown need, and a duplicate id", () => {
		expect(() =>
			parseWorkloadSpec(
				`name: p\nsteps:\n  - id: a\n    prompt: a\n    needs: [b]\n  - id: b\n    prompt: b\n    needs: [a]\n`,
				"/tmp/p.yml",
			),
		).toThrow(/dependency cycle among steps a, b/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    needs: [a]\n`, "/tmp/p.yml"),
		).toThrow(/depends on itself/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    needs: [nope]\n`, "/tmp/p.yml"),
		).toThrow(/needs unknown step "nope"/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n  - id: a\n    prompt: b\n`, "/tmp/p.yml"),
		).toThrow(/duplicate step id "a"/);
	});

	it("rejects invalid enums, identifiers, counts, versions, and empty step lists", () => {
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    effort: extreme\n`, "/tmp/p.yml"),
		).toThrow(/invalid `effort` value "extreme"/);
		for (const effort of ["low", "medium", "high", "xhigh"]) {
			expect(() =>
				parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    effort: ${effort}\n`, "/tmp/p.yml"),
			).toThrow(/invalid `effort` value/);
		}
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    effort: null\n`, "/tmp/p.yml"),
		).toThrow(/invalid `effort` value|invalid workload/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    on_failure: maybe\n`, "/tmp/p.yml"),
		).toThrow(/invalid `on_failure` value "maybe"/);
		expect(() => parseWorkloadSpec(`name: p\nsteps:\n  - id: Bad_Id\n    prompt: a\n`, "/tmp/p.yml")).toThrow(
			/step id "Bad_Id" must match/,
		);
		expect(() => parseWorkloadSpec(`name: Probe\nsteps:\n  - id: a\n    prompt: a\n`, "/tmp/p.yml")).toThrow(
			/workload name "Probe" must match/,
		);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    concurrency: 0\n`, "/tmp/p.yml"),
		).toThrow(/invalid `concurrency` value 0/);
		expect(() =>
			parseWorkloadSpec(`name: p\nsteps:\n  - id: a\n    prompt: a\n    retries: -1\n`, "/tmp/p.yml"),
		).toThrow(/invalid `retries` value -1/);
		expect(() => parseWorkloadSpec(`version: 2\nname: p\nsteps:\n  - id: a\n    prompt: a\n`, "/tmp/p.yml")).toThrow(
			/unsupported workload version 2/,
		);
		expect(() => parseWorkloadSpec(`name: p\nsteps: []\n`, "/tmp/p.yml")).toThrow(/has no steps/);
	});

	it("reports malformed YAML and schema violations with the file name", () => {
		expect(() => parseWorkloadSpec(`name: p\nsteps:\n  - id: [\n`, "/tmp/broken.yml")).toThrow(/broken\.yml/);
		expect(() => parseWorkloadSpec(`steps:\n  - id: a\n    prompt: a\n`, "/tmp/broken.yml")).toThrow(
			/broken\.yml: invalid workload/,
		);
	});
});

describe("resolveWorkloadArgs", () => {
	const spec = parseWorkloadSpec(
		`
name: p
args:
  target: { required: true }
  depth: { default: "2" }
steps:
  - id: a
    prompt: "\${args.target}"
`,
		"/tmp/p.yml",
	);

	it("applies declared defaults and provided values", () => {
		expect(resolveWorkloadArgs(spec, ["target=src/api"])).toEqual({ target: "src/api", depth: "2" });
		expect(resolveWorkloadArgs(spec, ["target=x", "depth=5"])).toEqual({ target: "x", depth: "5" });
	});

	it("keeps a value containing '=' intact", () => {
		expect(resolveWorkloadArgs(spec, ["target=a=b"]).target).toBe("a=b");
	});

	it("rejects a missing required arg, an undeclared arg, and a malformed assignment", () => {
		expect(() => resolveWorkloadArgs(spec, [])).toThrow(/requires `target`/);
		expect(() => resolveWorkloadArgs(spec, ["target=x", "nope=1"])).toThrow(/does not declare `nope`/);
		expect(() => resolveWorkloadArgs(spec, ["bare"])).toThrow(/Invalid --set "bare"/);
	});
});

describe("workload discovery", () => {
	it("finds project workloads and resolves a duplicate name to the closest one", async () => {
		const root = await tempRoot();
		const nested = path.join(root, "packages", "inner");
		await fs.mkdir(path.join(root, ".omp", "workloads"), { recursive: true });
		await fs.mkdir(path.join(nested, ".omp", "workloads"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".omp", "workloads", "shared.yml"),
			`name: shared\nsteps:\n  - id: outer\n    prompt: outer\n`,
		);
		await fs.writeFile(
			path.join(root, ".omp", "workloads", "outer-only.yaml"),
			`name: outer-only\nsteps:\n  - id: a\n    prompt: a\n`,
		);
		await fs.writeFile(
			path.join(nested, ".omp", "workloads", "shared.yml"),
			`name: shared\nsteps:\n  - id: inner\n    prompt: inner\n`,
		);

		const found = await discoverWorkloads(nested, path.join(root, "no-user-dir"));
		const names = found.map(candidate => candidate.name).sort();
		expect(names).toEqual(["outer-only", "shared"]);
		const shared = found.find(candidate => candidate.name === "shared");
		expect(shared?.path.startsWith(nested)).toBe(true);

		const loaded = await loadWorkload("shared", nested, path.join(root, "no-user-dir"));
		expect(loaded.steps[0]?.id).toBe("inner");
	});

	it("loads an explicit path and rejects an unknown name with the available list", async () => {
		const root = await tempRoot();
		await fs.mkdir(path.join(root, ".omp", "workloads"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".omp", "workloads", "known.yml"),
			`name: known\nsteps:\n  - id: a\n    prompt: a\n`,
		);
		const direct = path.join(root, "loose.yml");
		await fs.writeFile(direct, `name: loose\nsteps:\n  - id: a\n    prompt: a\n`);

		expect((await loadWorkload(direct, root, path.join(root, "none"))).name).toBe("loose");
		expect((await loadWorkload("./loose.yml", root, path.join(root, "none"))).name).toBe("loose");
		await expect(loadWorkload("missing", root, path.join(root, "none"))).rejects.toThrow(
			/Unknown workload "missing".*Available: known/s,
		);
	});

	it("rejects a file whose declared name disagrees with its filename", async () => {
		const root = await tempRoot();
		await fs.mkdir(path.join(root, ".omp", "workloads"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".omp", "workloads", "filename.yml"),
			`name: declared\nsteps:\n  - id: a\n    prompt: a\n`,
		);
		await expect(loadWorkload("filename", root, path.join(root, "none"))).rejects.toThrow(
			/does not match its filename/,
		);
	});

	it("surfaces a spec error as WorkloadSpecError, not a raw throw", async () => {
		const root = await tempRoot();
		await expect(loadWorkload(path.join(root, "absent.yml"), root)).rejects.toBeInstanceOf(WorkloadSpecError);
	});
});
