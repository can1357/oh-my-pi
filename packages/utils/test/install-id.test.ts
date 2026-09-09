import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetInstallIdCacheForTests,
	getAgentDir,
	getConfigRootDir,
	getInstallId,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("getInstallId", () => {
	let tempRoot = "";
	let originalAgentDir = "";
	let originalConfigDir: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalConfigDir = process.env.PI_CONFIG_DIR;
		const slug = `omp-install-id-${Snowflake.next()}`;
		tempRoot = path.join(os.tmpdir(), slug);
		await fs.mkdir(tempRoot, { recursive: true });
		// Point the resolver's config root at the temp dir. Using PI_CONFIG_DIR
		// keeps the parent equal to os.homedir() but flips the basename, so the
		// install-id file lands inside our temp tree.
		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		setAgentDir(path.join(tempRoot, "agent"));
		__resetInstallIdCacheForTests();
	});

	afterEach(async () => {
		__resetInstallIdCacheForTests();
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("generates and persists a UUID on first call", async () => {
		const id = getInstallId();
		expect(id).toMatch(UUID_RE);

		const onDisk = (await fs.readFile(path.join(getConfigRootDir(), "install-id"), "utf8")).trim();
		expect(onDisk).toBe(id);
	});

	it("returns the cached value on subsequent calls without re-reading", async () => {
		const first = getInstallId();
		await fs.writeFile(path.join(getConfigRootDir(), "install-id"), "deadbeef-0000-0000-0000-000000000000\n");
		// Cache wins until reset.
		expect(getInstallId()).toBe(first);
	});

	it("loads an existing valid UUID instead of regenerating", async () => {
		const existing = "11111111-2222-3333-4444-555555555555";
		await fs.mkdir(getConfigRootDir(), { recursive: true });
		await fs.writeFile(path.join(getConfigRootDir(), "install-id"), `${existing}\n`);
		expect(getInstallId()).toBe(existing);
	});

	it("regenerates and persists when the on-disk contents are not a valid UUID", async () => {
		await fs.mkdir(getConfigRootDir(), { recursive: true });
		await fs.writeFile(path.join(getConfigRootDir(), "install-id"), "not-a-uuid\n");
		const id = getInstallId();
		expect(id).toMatch(UUID_RE);
		expect(id).not.toBe("not-a-uuid");

		const onDisk = (await fs.readFile(path.join(getConfigRootDir(), "install-id"), "utf8")).trim();
		expect(onDisk).toBe(id);
	});

	it("anchors the install id to the base config root regardless of active profile", async () => {
		// Default mode creates the id under the base config root.
		const baseId = getInstallId();
		const baseFile = path.join(getConfigRootDir(), "install-id");
		expect((await fs.readFile(baseFile, "utf8")).trim()).toBe(baseId);

		// Activating a profile must not relocate the id or mint a new one: install
		// identity is per-install, and the global cache must stay correct.
		__resetInstallIdCacheForTests();
		setProfile("work");
		try {
			const profileRoot = getConfigRootDir();
			expect(profileRoot).not.toBe(path.dirname(baseFile));
			expect(getInstallId()).toBe(baseId);
			expect(await Bun.file(path.join(profileRoot, "install-id")).exists()).toBe(false);
		} finally {
			setProfile(undefined);
		}
	});
});
