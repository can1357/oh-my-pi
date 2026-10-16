import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const script = path.join(import.meta.dir, "check-native-exports.mjs");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const INDEX_JS = "export const Foo = nativeBindings.Foo;\nexport const helper = nativeBindings.helper;\n";
const INDEX_DTS = `export declare class Foo {
  constructor(options?: string | undefined | null)
  get label(): string
  /** Run the thing. */
  run(input: string): Promise<string>
  run(input: string, extra: number): Promise<string>
  static open(path: string): Foo
  size: number
}
export declare function helper(): void
`;

interface AddonShape {
	run?: boolean;
	open?: boolean;
	label?: boolean;
	size?: boolean;
}

/** CommonJS source for a stand-in addon; each member can be left out. */
function addonSource(shape: AddonShape): string {
	const { run = true, open = true, label = true, size = true } = shape;
	return [
		"class Foo {",
		run ? "  run() {}" : "",
		open ? "  static open() {}" : "",
		label ? "  get label() { return ''; }" : "",
		"}",
		size ? "Object.defineProperty(Foo.prototype, 'size', { get() { return 0; } });" : "",
		"module.exports = { Foo, helper() {}, __piNativesV1_0_0: 1 };",
	].join("\n");
}

/** Run the checker in a throwaway workspace laid out like the repo's native package. */
async function check(shape: AddonShape): Promise<{ exitCode: number; stderr: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-native-exports-"));
	tempDirs.push(dir);
	const nativeDir = path.join(dir, "packages", "natives", "native");
	await mkdir(nativeDir, { recursive: true });
	const addon = path.join(dir, "addon.cjs");
	await Promise.all([
		writeFile(path.join(nativeDir, "index.js"), INDEX_JS),
		writeFile(path.join(nativeDir, "index.d.ts"), INDEX_DTS),
		writeFile(addon, addonSource(shape)),
	]);
	const result = await $`node ${script} ${addon}`.cwd(dir).quiet().nothrow();
	return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("check-native-exports class members", () => {
	// index.js keeps a single `nativeBindings.Foo` reference when a native PR adds a method to an
	// existing class, so only index.d.ts shows it. An addon that predates the method then passes
	// the gate and the consumer fails later with "... is not a function".
	it("passes an addon that carries every declared class member", async () => {
		const result = await check({});
		expect(result.exitCode).toBe(0);
	});

	it("reports an instance method the addon class lacks", async () => {
		const result = await check({ run: false });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Foo#run");
	});

	it("reports a static method the addon class lacks", async () => {
		const result = await check({ open: false });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Foo.open");
	});

	it("reports accessors and properties the addon class lacks", async () => {
		const result = await check({ label: false, size: false });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Foo#label");
		expect(result.stderr).toContain("Foo#size");
	});
});
