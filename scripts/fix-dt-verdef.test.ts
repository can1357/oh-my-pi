import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const DT_VERDEF = 0x6ffffffcn;
const VERDEF_ADDRESS = 0x12345678n;
const STALE_ADDRESS = 0xdeadbeefn;
const SECTION_HEADER_OFFSET = 64;
const SECTION_HEADER_SIZE = 64;

let fixtureDirectory: string;

beforeAll(async () => {
	fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fix-dt-verdef-"));
});

afterAll(async () => {
	await fs.rm(fixtureDirectory, { recursive: true, force: true });
});

interface FixtureOptions {
	verdef?: boolean;
	dynamic?: boolean;
	verdefTag?: boolean;
}

async function createFixture(name: string, options: FixtureOptions = {}) {
	const hasVerdef = options.verdef ?? true;
	const hasDynamic = options.dynamic ?? true;
	const hasVerdefTag = options.verdefTag ?? true;
	const sectionCount = 1 + Number(hasDynamic) + Number(hasVerdef);
	const dynamicOffset = SECTION_HEADER_OFFSET + sectionCount * SECTION_HEADER_SIZE;

	const header = Buffer.alloc(64);
	header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	header.writeBigUInt64LE(BigInt(SECTION_HEADER_OFFSET), 40);
	header.writeUInt16LE(SECTION_HEADER_SIZE, 58);
	header.writeUInt16LE(sectionCount, 60);

	const sections = Buffer.alloc(sectionCount * SECTION_HEADER_SIZE);
	let index = 1;
	if (hasDynamic) {
		const base = index * SECTION_HEADER_SIZE;
		sections.writeUInt32LE(6, base + 4);
		sections.writeBigUInt64LE(BigInt(dynamicOffset), base + 24);
		sections.writeBigUInt64LE(32n, base + 32);
		index += 1;
	}
	if (hasVerdef) {
		const base = index * SECTION_HEADER_SIZE;
		sections.writeUInt32LE(0x6ffffffd, base + 4);
		sections.writeBigUInt64LE(VERDEF_ADDRESS, base + 16);
	}

	const dynamic = Buffer.alloc(hasDynamic ? 32 : 0);
	if (hasDynamic && hasVerdefTag) {
		dynamic.writeBigUInt64LE(DT_VERDEF, 0);
		dynamic.writeBigUInt64LE(STALE_ADDRESS, 8);
	}
	const bytes = Buffer.concat([header, sections, dynamic]);
	const file = path.join(fixtureDirectory, name);
	await Bun.write(file, bytes);
	return { bytes, dynamicOffset, file };
}

async function repair(file: string) {
	return await $`${process.execPath} ${path.join(import.meta.dir, "fix-dt-verdef.ts")} ${file}`.quiet().nothrow();
}

describe("fix-dt-verdef", () => {
	test("repoints stale DT_VERDEF without changing other bytes", async () => {
		const fixture = await createFixture("stale.elf");
		const result = await repair(fixture.file);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("DT_VERDEF 0xdeadbeef -> 0x12345678");
		const expected = Buffer.from(fixture.bytes);
		expected.writeBigUInt64LE(VERDEF_ADDRESS, fixture.dynamicOffset + 8);
		expect(await fs.readFile(fixture.file)).toEqual(expected);

		const secondResult = await repair(fixture.file);
		expect(secondResult.exitCode).toBe(0);
		expect(secondResult.stdout.toString()).toContain("DT_VERDEF already 0x12345678");
	});

	test("leaves binaries without version definitions unchanged", async () => {
		const fixture = await createFixture("no-verdef.elf", { verdef: false, verdefTag: false });
		const result = await repair(fixture.file);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("no .gnu.version_d, nothing to do");
		expect(await fs.readFile(fixture.file)).toEqual(fixture.bytes);
	});

	test("rejects a version-definition section without DT_VERDEF", async () => {
		const fixture = await createFixture("missing-tag.elf", { verdefTag: false });
		const result = await repair(fixture.file);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(".gnu.version_d present but no DT_VERDEF entry");
	});
});
