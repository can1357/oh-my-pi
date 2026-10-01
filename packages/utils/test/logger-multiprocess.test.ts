import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { localDay } from "../src/dirs";

const loggerModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/logger.ts")).href;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** Local `YYYY-MM-DD` of the day `daysAgo` days before `base`, as the sink names its files. */
function localDayBefore(base: Date, daysAgo: number): string {
	const date = new Date(base);
	date.setDate(date.getDate() - daysAgo);
	return localDay(date);
}

async function makeProbe(logsDir: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-probe-"));
	roots.push(root);
	const releasePath = path.join(logsDir, ".release");
	const probePath = path.join(root, "probe.ts");
	await Bun.write(
		probePath,
		`import * as fs from "node:fs";\n` +
			`import { info, setTransports } from ${JSON.stringify(loggerModuleUrl)};\n` +
			`setTransports({ file: ${JSON.stringify(logsDir)} });\n` +
			`info("multiprocess probe");\n` +
			`await new Promise<void>(resolve => setImmediate(resolve));\n` +
			`fs.writeSync(1, "ready\\n");\n` +
			`await new Promise<void>(resolve => {\n` +
			`\tconst watcher = fs.watch(${JSON.stringify(logsDir)}, (_event, name) => {\n` +
			`\t\tif (name !== ".release") return;\n` +
			`\t\twatcher.close();\n` +
			`\t\tresolve();\n` +
			`\t});\n` +
			`\tif (fs.existsSync(${JSON.stringify(releasePath)})) {\n` +
			`\t\twatcher.close();\n` +
			`\t\tresolve();\n` +
			`\t}\n` +
			`});\n` +
			`setTransports({ file: false });\n`,
	);
	return probePath;
}

describe("multiprocess file logging", () => {
	it("prunes completed PID namespaces across short-lived invocations", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-retention-"));
		roots.push(logsDir);
		// macOS process identifiers are far below these values, so the fixtures
		// are deterministically completed rather than briefly lingering as zombies.
		const exitedPids = [9_000_001, 9_000_002];

		await Bun.write(path.join(logsDir, ".release"), "");
		const probePath = await makeProbe(logsDir);
		const seed = Bun.spawn([process.execPath, probePath], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		});
		seed.stdin.end();
		expect(await seed.exited).toBe(0);
		const seedLog = (await fs.readdir(logsDir)).find(name => name.endsWith(`.${seed.pid}.log`));
		const seedDate = seedLog?.match(/^omp\.(\d{4}-\d{2}-\d{2})\./)?.[1];
		if (!seedDate) throw new Error("probe did not create a dated log");
		const baseDate = new Date(`${seedDate}T12:00:00`);
		const localDate = (daysAgo: number): string => localDayBefore(baseDate, daysAgo);
		const retainedNames: string[] = [];
		const expiredNames: string[] = [];
		for (const pid of exitedPids) {
			for (let daysAgo = -1; daysAgo <= 5; daysAgo++) {
				const name = `omp.${localDate(daysAgo)}.${pid}.log`;
				await Bun.write(path.join(logsDir, name), name);
				await fs.utimes(path.join(logsDir, name), 2, 2);
				(daysAgo > 0 && daysAgo < 5 ? retainedNames : expiredNames).push(name);
			}
			const rolloverName = `omp.${localDate(0)}.${pid}.log.1`;
			await Bun.write(path.join(logsDir, rolloverName), rolloverName);
			await fs.utimes(path.join(logsDir, rolloverName), 2, 2);
			retainedNames.push(rolloverName);
			await Bun.write(path.join(logsDir, `.omp.${pid}-audit.json`), "{}");
		}

		for (let restart = 0; restart < 2; restart++) {
			const current = Bun.spawn([process.execPath, probePath], {
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
			});
			current.stdin.end();
			expect(await current.exited).toBe(0);
		}

		const entries = await fs.readdir(logsDir);
		for (const expected of retainedNames) expect(entries).toContain(expected);
		for (const expired of expiredNames) expect(entries).not.toContain(expired);
		expect(entries.filter(name => name.endsWith(".log.1"))).toHaveLength(exitedPids.length);
		// Completed-process audits from earlier releases are removed, and the
		// current sink tracks its rotations in memory without writing one.
		expect(entries.filter(name => name.endsWith("-audit.json"))).toEqual([]);
	});

	it("ages out legacy shared daily logs and hash-named audits past the retention window", async () => {
		const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-legacy-"));
		roots.push(logsDir);
		const now = new Date();
		const localDate = (daysAgo: number): string => localDayBefore(now, daysAgo);
		const expired = [
			`omp.${localDate(30)}.log`,
			`omp.${localDate(30)}.log.1`,
			`omp.${localDate(30)}.log.gz`,
			`omp.${localDate(30)}.log.2.gz`,
			".0123456789abcdef0123456789abcdef01234567-audit.json",
		];
		const retained = [`omp.${localDate(1)}.log`, `omp.${localDate(1)}.log.gz`, ".fedcba9876543210-audit.json"];
		for (const name of [...expired, ...retained]) await Bun.write(path.join(logsDir, name), name);
		const thirtyDaysAgoSec = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
		await fs.utimes(path.join(logsDir, expired[4]!), thirtyDaysAgoSec, thirtyDaysAgoSec);

		await Bun.write(path.join(logsDir, ".release"), "");
		const probe = Bun.spawn([process.execPath, await makeProbe(logsDir)], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		});
		probe.stdin.end();
		expect(await probe.exited).toBe(0);

		const entries = await fs.readdir(logsDir);
		for (const name of expired) expect(entries).not.toContain(name);
		for (const name of retained) expect(entries).toContain(name);
	});
});
