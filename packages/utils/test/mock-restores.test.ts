import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installMockRestores, type TestLifetime, testLifetime } from "./helpers/mock-restores";

const originalDateNow = Date.now;
const afterEachSawSpy: boolean[] = [];

describe("installMockRestores", () => {
	installMockRestores();

	afterEach(() => {
		afterEachSawSpy.push(Date.now !== originalDateNow);
	});

	it("keeps mocks available to afterEach and restores them before the next test", () => {
		vi.spyOn(Date, "now").mockReturnValue(12345);
		expect(Date.now()).toBe(12345);
	});

	it("restores the preceding test's mock after its afterEach hooks", () => {
		expect(afterEachSawSpy).toEqual([true]);
		expect(Date.now).toBe(originalDateNow);
	});

	it("leaves the final test's mock for afterAll to restore", () => {
		vi.spyOn(Date, "now").mockReturnValue(67890);
		expect(Date.now()).toBe(67890);
	});
});

it("restores the final mock when the helper scope ends", () => {
	expect(Date.now).toBe(originalDateNow);
});

let finishedLifetime: TestLifetime | undefined;

it("lets a live test body continue after an await", async () => {
	finishedLifetime = testLifetime();
	await Promise.resolve();
	finishedLifetime.assertLive();
	expect(finishedLifetime.ended).toBe(false);
});

it("ends a lifetime once its test finishes", () => {
	expect(finishedLifetime?.ended).toBe(true);
	expect(() => finishedLifetime?.assertLive()).toThrow("test body resumed after its test ended");
});

const helperPath = JSON.stringify(path.join(import.meta.dir, "helpers", "mock-restores.ts"));

/**
 * Runs `source` as its own `bun test` file from this package, so the package preload applies.
 * Each child forces a timeout in its first test; the returned output belongs to the second.
 */
async function runChildTest(source: string): Promise<{ exitCode: number; output: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mock-restores-"));
	const child = path.join(dir, "child.test.ts");
	await Bun.write(child, source);
	try {
		const proc = Bun.spawn([process.execPath, "test", child], {
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		return { exitCode, output: `${stdout}\n${stderr}` };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

it("stops a timed-out test body that resumes", async () => {
	const { exitCode, output } = await runChildTest(`import { expect, it } from "bun:test";
import { testLifetime } from ${helperPath};

const resume = Promise.withResolvers<void>();
const staleBodyStopped = Promise.withResolvers<void>();

it("times out", async () => {
	const life = testLifetime();
	await resume.promise;
	expect(() => life.assertLive()).toThrow("test body resumed after its test ended");
	staleBodyStopped.resolve();
	console.log("STALE_BODY_STOPPED");
}, { timeout: 50 });

it("releases the timed-out body", async () => {
	resume.resolve();
	await staleBodyStopped.promise;
});
`);
	// The first child test fails by timing out; the second sees the resumed body stop.
	expect(exitCode).toBe(1);
	expect(output).toContain("STALE_BODY_STOPPED");
	expect(output).toContain("1 pass");
});

it("stops a resumed body after its afterEach timed out, in a file without installMockRestores()", async () => {
	// Bun skips onTestFinished after an afterEach timeout, so only the preload's
	// per-test generation tells the resumed body that a later test has started.
	const { exitCode, output } = await runChildTest(`import { afterEach, expect, it, spyOn } from "bun:test";
import { testLifetime } from ${helperPath};

const original = Date.now;
const never = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const resumed = Promise.withResolvers<void>();
let first = true;
let stopped = false;

afterEach(async () => {
	if (first) {
		first = false;
		await never.promise;
	}
}, { timeout: 50 });

it("times out in its body and its afterEach", async () => {
	const life = testLifetime();
	await release.promise;
	try {
		life.assertLive();
		spyOn(Date, "now").mockReturnValue(12345);
	} catch {
		stopped = true;
	} finally {
		resumed.resolve();
	}
}, { timeout: 50 });

it("releases the stale body", async () => {
	release.resolve();
	await resumed.promise;
	console.log("STALE_BODY_STOPPED", stopped, "ORIGINAL_CLOCK", Date.now === original);
	expect(stopped).toBe(true);
	expect(Date.now).toBe(original);
});
`);
	expect(exitCode).toBe(1);
	expect(output).toContain("STALE_BODY_STOPPED true ORIGINAL_CLOCK true");
	expect(output).toContain("1 pass");
});

it("restores the mocks of a test whose afterEach timed out before the next test", async () => {
	// Bun skips onTestFinished after an afterEach timeout; the helper's beforeEach restore covers it.
	const { exitCode, output } = await runChildTest(`import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { installMockRestores } from ${helperPath};

const original = Date.now;
const never = Promise.withResolvers<void>();
let first = true;

describe("scope", () => {
	installMockRestores();
	afterEach(async () => {
		if (first) {
			first = false;
			await never.promise;
		}
	}, { timeout: 50 });
	it("leaves a spy behind a timed-out afterEach", () => {
		spyOn(Date, "now").mockReturnValue(12345);
	});
	it("starts with that spy restored", () => {
		console.log("NEXT_RESTORED", Date.now === original);
		expect(Date.now).toBe(original);
	});
});
`);
	expect(exitCode).toBe(1);
	expect(output).toContain("NEXT_RESTORED true");
	expect(output).toContain("1 pass");
});

it("restores the mocks of a scope's last test whose afterEach timed out when the scope ends", async () => {
	// No later test in the scope runs the helper's beforeEach; its afterAll restore covers the exit.
	const { exitCode, output } = await runChildTest(`import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { installMockRestores } from ${helperPath};

const original = Date.now;
const never = Promise.withResolvers<void>();

describe("scope", () => {
	installMockRestores();
	afterEach(async () => {
		await never.promise;
	}, { timeout: 50 });
	it("leaves a spy as the scope's last test", () => {
		spyOn(Date, "now").mockReturnValue(12345);
	});
});

it("runs after the scope", () => {
	console.log("SCOPE_RESTORED", Date.now === original);
	expect(Date.now).toBe(original);
});
`);
	expect(exitCode).toBe(1);
	expect(output).toContain("SCOPE_RESTORED true");
	expect(output).toContain("1 pass");
});

const hookOrder: string[] = [];

describe("Bun hook order", () => {
	beforeEach(() => {
		hookOrder.push("outer beforeEach");
	});
	afterEach(() => {
		hookOrder.push("outer afterEach first");
	});
	afterEach(() => {
		hookOrder.push("outer afterEach second");
	});

	describe("nested scope", () => {
		beforeEach(() => {
			hookOrder.push("inner beforeEach");
		});
		afterEach(() => {
			hookOrder.push("inner afterEach");
		});

		it("runs nested afterEach hooks before enclosing ones, each scope in registration order", () => {
			hookOrder.push("test");
		});
	});

	afterAll(() => {
		expect(hookOrder).toEqual([
			"outer beforeEach",
			"inner beforeEach",
			"test",
			"inner afterEach",
			"outer afterEach first",
			"outer afterEach second",
		]);
	});
});
