import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectCheckJobs, runCheckJobs } from "./ci-check-ts";

const tempDirs: string[] = [];

async function fixtureDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ci-check-"));
	tempDirs.push(dir);
	return dir;
}

test("runs fast failure, slow failure and pass jobs, and retains attributed diagnostics", async () => {
	const dir = await fixtureDir();
	const started = path.join(dir, "started");
	await fs.mkdir(started);
	const jobs = [
		{
			name: "tool lint (oxlint)",
			command: [
				"bun",
				"-e",
				`await Bun.write(${JSON.stringify(path.join(started, "fast"))}, "started"); console.error('src/fast.ts:4:7: expected: "green"'); console.error('received: "red"'); process.exit(2)`,
			],
			cwd: dir,
		},
		{
			name: "slow package type check",
			command: [
				"bun",
				"-e",
				`await Bun.write(${JSON.stringify(path.join(started, "slow"))}, "started"); await Bun.sleep(30); console.error("src/slow.ts:9:2: expected 2, received 3"); process.exit(3)`,
			],
			cwd: dir,
		},
		{
			name: "passing neighboring package type check",
			command: ["bun", "-e", `await Bun.write(${JSON.stringify(path.join(started, "pass"))}, "started")`],
			cwd: dir,
		},
	];
	const lines: string[] = [];

	const exitCode = await runCheckJobs(jobs, { concurrency: 2, emit: line => lines.push(line) });
	const report = lines.join("\n");

	expect(exitCode).toBe(1);
	expect(await Bun.file(path.join(started, "fast")).exists()).toBe(true);
	expect(await Bun.file(path.join(started, "slow")).exists()).toBe(true);
	expect(await Bun.file(path.join(started, "pass")).exists()).toBe(true);
	expect(report).toContain("tool lint (oxlint)");
	expect(report).toContain("slow package type check");
	expect(report).toContain("passing neighboring package type check");
	expect(report).toContain("(cd ");
	expect(report).toContain("src/fast.ts:4:7");
	expect(report).toContain('expected: "green"');
	expect(report).toContain('received: "red"');
	expect(report).toContain("src/slow.ts:9:2");
	expect(report).toContain("expected 2, received 3");
});

test("a failing linter does not prevent collected package type checks from running", async () => {
	const dir = await fixtureDir();
	const started = path.join(dir, "started");
	await fs.mkdir(path.join(dir, "packages", "first"), { recursive: true });
	await fs.mkdir(path.join(dir, "packages", "second"), { recursive: true });
	await fs.mkdir(started);
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({
			scripts: {
				"check:tools:lint": `bun -e 'await Bun.write(${JSON.stringify(path.join(started, "lint"))}, "ran"); console.error("scripts/example.ts:6:3: expected true, received false"); process.exit(2)'`,
				"check:tools:format": `bun -e 'await Bun.write(${JSON.stringify(path.join(started, "format"))}, "ran")'`,
			},
		}),
	);
	for (const name of ["first", "second"]) {
		await Bun.write(
			path.join(dir, "packages", name, "package.json"),
			JSON.stringify({
				name,
				scripts: { "check:types": `bun -e 'await Bun.write(${JSON.stringify(path.join(started, name))}, "ran")'` },
			}),
		);
	}
	const lines: string[] = [];
	const exitCode = await runCheckJobs(await collectCheckJobs(dir), {
		concurrency: 2,
		emit: line => lines.push(line),
	});
	const report = lines.join("\n");

	expect(exitCode).toBe(1);
	for (const name of ["lint", "format", "first", "second"]) {
		expect(await Bun.file(path.join(started, name)).exists()).toBe(true);
	}
	expect(report).toContain("tool lint (oxlint)");
	expect(report).toContain("first check:types");
	expect(report).toContain("second check:types");
	expect(report).toContain("scripts/example.ts:6:3");
	expect(report).toContain("expected true, received false");
});

test("returns success when every independent check passes", async () => {
	const dir = await fixtureDir();
	const jobs = ["one", "two", "three"].map(name => ({
		name,
		command: ["bun", "-e", "await Bun.sleep(5)"],
		cwd: dir,
	}));
	const exitCode = await runCheckJobs(jobs, { concurrency: 2, emit: () => {} });

	expect(exitCode).toBe(0);
});

test("keeps the production pool bounded to seven", async () => {
	const dir = await fixtureDir();
	const jobs = Array.from({ length: 10 }, (_, index) => ({
		name: `check ${index}`,
		command: ["bun", "-e", "await Bun.sleep(20)"],
		cwd: dir,
	}));
	let active = 0;
	let maximum = 0;

	const exitCode = await runCheckJobs(jobs, {
		emit: () => {},
		spawn: (command, options) => {
			active += 1;
			maximum = Math.max(maximum, active);
			const child = Bun.spawn(command, options);
			void child.exited.then(() => {
				active -= 1;
			});
			return child;
		},
	});

	expect(exitCode).toBe(0);
	expect(maximum).toBe(7);
	expect(active).toBe(0);
});

test("collects all package type checks independently from the tool checks", async () => {
	const dir = await fixtureDir();
	await fs.mkdir(path.join(dir, "packages", "first"), { recursive: true });
	await fs.mkdir(path.join(dir, "packages", "second"), { recursive: true });
	await fs.mkdir(path.join(dir, "packages", "no-types"), { recursive: true });
	await Bun.write(
		path.join(dir, "packages", "first", "package.json"),
		JSON.stringify({ name: "first", scripts: { "check:types": "tsgo" } }),
	);
	await Bun.write(
		path.join(dir, "packages", "second", "package.json"),
		JSON.stringify({ name: "second", scripts: { "check:types": "tsgo" } }),
	);
	await Bun.write(
		path.join(dir, "packages", "no-types", "package.json"),
		JSON.stringify({ name: "no-types", scripts: { lint: "oxlint" } }),
	);

	const jobs = await collectCheckJobs(dir);

	expect(jobs.map(job => job.name)).toEqual([
		"tool lint (oxlint)",
		"tool format (oxfmt)",
		"first check:types",
		"second check:types",
	]);
	expect(jobs[0]?.name).toBe("tool lint (oxlint)");
	expect(jobs.slice(2).every(job => job.command.at(-1) === "check:types")).toBe(true);
});
test("records a process-start error as a failure and still prints the summary", async () => {
	const dir = await fixtureDir();
	const missing = path.join(dir, "definitely-not-an-executable");
	const jobs = [
		{ name: "broken launcher", command: [missing], cwd: dir },
		{ name: "passing neighboring check", command: ["bun", "-e", "process.exit(0)"], cwd: dir },
	];
	const lines: string[] = [];

	const exitCode = await runCheckJobs(jobs, { concurrency: 2, emit: line => lines.push(line) });
	const report = lines.join("\n");

	expect(exitCode).toBe(1);
	expect(report).toContain("broken launcher");
	expect(report).toContain("failed to start");
	expect(report).toContain("passing neighboring check");
	expect(report).toContain("1/2 checks passed; 1 failed");
});

test("keeps warnings from passing checks and prints a copy-pasteable rerun command", async () => {
	const parent = await fixtureDir();
	const dir = path.join(parent, "path with space");
	await fs.mkdir(dir);
	const lines: string[] = [];

	const exitCode = await runCheckJobs(
		[
			{ name: "warns", command: ["bun", "-e", "console.error('warning: kept'); "], cwd: dir },
			{ name: "fails", command: ["bun", "-e", "process.exit(4)"], cwd: dir },
		],
		{ concurrency: 2, emit: line => lines.push(line) },
	);
	const report = lines.join("\n");

	expect(exitCode).toBe(1);
	expect(report).toContain("warning: kept");
	expect(report).toContain(`$ (cd '${dir}' && bun -e 'process.exit(4)')`);
});

afterAll(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
