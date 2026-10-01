import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";

describe("loadPuppeteer cwd restoration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces a restore failure after the import succeeds", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { loadPuppeteer } from "./src/tools/browser/launch.ts";
const previousCwd = process.cwd();
const originalCwd = process.cwd;
const originalDefineProperty = Object.defineProperty;
Object.defineProperty = (target, property, descriptor) => {
	if (target === process && property === "cwd" && descriptor.value === originalCwd) {
		throw new Error("restore denied");
	}
	return originalDefineProperty(target, property, descriptor);
};
try {
	await loadPuppeteer();
	process.exit(2);
} catch (error) {
	if (error instanceof Error && error.message === "restore denied" && process.cwd() !== previousCwd) {
		try {
			await loadPuppeteer();
			process.exit(3);
		} catch (retryError) {
			if (retryError === error) process.exit(0);
		}
	}
	process.stderr.write(String(error));
	process.exit(1);
}`,
			],
			{ cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	});

	it("surfaces both import and restore failures", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { loadPuppeteer } from "./src/tools/browser/launch.ts";
const previousCwd = process.cwd();
const originalCwd = process.cwd;
const originalDefineProperty = Object.defineProperty;
const versionDescriptor = Object.getOwnPropertyDescriptor(process, "version");
Object.defineProperty(process, "version", {
	configurable: versionDescriptor?.configurable,
	enumerable: versionDescriptor?.enumerable,
	get: () => { throw new Error("import denied"); },
});
Object.defineProperty = (target, property, descriptor) => {
	if (target === process && property === "cwd" && descriptor.value === originalCwd) {
		throw new Error("restore denied");
	}
	return originalDefineProperty(target, property, descriptor);
};
try {
	await loadPuppeteer();
	process.exit(2);
} catch (error) {
	if (!(error instanceof AggregateError)) {
		process.stderr.write(String(error));
		process.exit(1);
	}
	const messages = error.errors.map(error => String(error));
	if (messages.includes("Error: import denied") && messages.includes("Error: restore denied") && process.cwd() !== previousCwd) {
		try {
			await loadPuppeteer();
			process.exit(3);
		} catch (retryError) {
			if (retryError === error) process.exit(0);
		}
	}
	process.stderr.write(String(error));
	process.exit(1);
}`,
			],
			{ cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	});
});
