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

it("stops a timed-out test body that resumes", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-lifetime-"));
	const child = path.join(dir, "lifetime.test.ts");
	await Bun.write(
		child,
		`import { expect, it } from "bun:test";
import { testLifetime } from ${JSON.stringify(path.join(import.meta.dir, "helpers", "mock-restores.ts"))};

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
`,
	);
	try {
		const proc = Bun.spawn([process.execPath, "test", child], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		// The first child test fails by timing out; the second sees the resumed body stop.
		expect(exitCode).toBe(1);
		expect(`${stdout}\n${stderr}`).toContain("STALE_BODY_STOPPED");
		expect(`${stdout}\n${stderr}`).toContain("1 pass");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
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
