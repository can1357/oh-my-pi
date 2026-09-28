/**
 * `!command` values are cached for the process lifetime by default; a caller
 * that needs rotation (OTLP export headers) passes `commandTtlMs`. The cache is
 * keyed by command, so a counter file the command increments is the oracle for
 * "how many times did it actually run".
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateAllCommandConfigs, resolveConfigValue } from "../src/config/resolve-config-value";

const tempDirs: string[] = [];

/** A fresh `!command` that prints and bumps its own run count; a new dir per call defeats the cache key. */
function countingCommand(): { value: string; runs: () => number } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-ttl-"));
	tempDirs.push(dir);
	const counter = path.join(dir, "count");
	const helper = path.join(dir, "count.ts");
	fs.writeFileSync(
		helper,
		[
			'import * as fs from "node:fs";',
			"const file = process.argv[2];",
			"const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;",
			"fs.writeFileSync(file, String(n));",
			'console.log("token-" + n);',
		].join("\n"),
	);
	return {
		value: `!"${process.execPath}" "${helper}" "${counter}"`,
		runs: () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0),
	};
}

afterEach(() => {
	invalidateAllCommandConfigs();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveConfigValue commandTtlMs", () => {
	it("reuses a result for the process lifetime when no TTL is given", async () => {
		const command = countingCommand();
		expect(await resolveConfigValue(command.value)).toBe("token-1");
		expect(await resolveConfigValue(command.value)).toBe("token-1");
		expect(command.runs()).toBe(1);
	});

	it("re-runs once the TTL has elapsed, and on every call at TTL 0", async () => {
		const command = countingCommand();
		expect(await resolveConfigValue(command.value, { commandTtlMs: 0 })).toBe("token-1");
		expect(await resolveConfigValue(command.value, { commandTtlMs: 0 })).toBe("token-2");
		expect(command.runs()).toBe(2);
	});

	it("shares one run between concurrent resolutions even at TTL 0", async () => {
		const command = countingCommand();
		const results = await Promise.all([
			resolveConfigValue(command.value, { commandTtlMs: 0 }),
			resolveConfigValue(command.value, { commandTtlMs: 0 }),
			resolveConfigValue(command.value, { commandTtlMs: 0 }),
		]);
		expect(results).toEqual(["token-1", "token-1", "token-1"]);
		expect(command.runs()).toBe(1);
	});

	it("keeps a result within its TTL", async () => {
		const command = countingCommand();
		expect(await resolveConfigValue(command.value, { commandTtlMs: 60_000 })).toBe("token-1");
		expect(await resolveConfigValue(command.value, { commandTtlMs: 60_000 })).toBe("token-1");
		expect(command.runs()).toBe(1);
	});

	it("lets a rotating caller and a process-lifetime caller share one command without affecting each other", async () => {
		// The same token script can back a models.yml header (cached for the process)
		// and an OTLP header (rotated). Neither caller's policy may leak into the other's reads.
		const command = countingCommand();
		expect(await resolveConfigValue(command.value)).toBe("token-1");
		// A rotating reader must not be pinned by the process-lifetime write above.
		expect(await resolveConfigValue(command.value, { commandTtlMs: 0 })).toBe("token-2");
		// ...and its re-run refreshes what the process-lifetime reader sees, without forcing another run.
		expect(await resolveConfigValue(command.value)).toBe("token-2");
		expect(command.runs()).toBe(2);
	});
});
