import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillshareClient } from "@oh-my-pi/pi-coding-agent/skillshare/client";
import {
	computeIntegrity,
	installSkillPackages,
	resolveSkillVersion,
	type SkillInstallHooks,
	uninstallSkillPackages,
	updateSkillPackages,
} from "@oh-my-pi/pi-coding-agent/skillshare/installer";
import {
	getSkillStorePath,
	getSkillshareStoreDir,
	readSkillsLock,
	readSkillsManifest,
	type SkillsLock,
	writeSkillsLock,
	writeSkillsManifest,
} from "@oh-my-pi/pi-coding-agent/skillshare/manifest";
import { writeTar } from "@oh-my-pi/pi-coding-agent/skillshare/tar";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { SkillPackument, SkillVersionManifest, SkillVersionSummary } from "@oh-my-pi/pi-wire/skillshare";

const SCOPE = "alice";
const NAME = "pdf-tools";
const ID = `@${SCOPE}/${NAME}`;

function packTgz(files: Record<string, string>, executable: string[] = []): Uint8Array {
	const encoder = new TextEncoder();
	const entries = Object.keys(files)
		.sort()
		.map(file => ({ path: file, content: encoder.encode(files[file]), executable: executable.includes(file) }));
	return Bun.gzipSync(new Uint8Array(writeTar(entries)));
}

function skillTgz(version: string, extra: Record<string, string> = {}, executable: string[] = []): Uint8Array {
	return packTgz(
		{ "SKILL.md": `---\nname: ${NAME}\ndescription: PDF helpers ${version}\n---\n# PDF ${version}\n`, ...extra },
		executable,
	);
}

function summary(version: string, tgz: Uint8Array, extra: Partial<SkillVersionSummary> = {}): SkillVersionSummary {
	return {
		version,
		publishedAt: 0,
		publisher: { username: SCOPE, avatar: "00" },
		integrity: computeIntegrity(tgz),
		size: tgz.length,
		unpackedSize: 0,
		fileCount: 1,
		hasScripts: false,
		yanked: false,
		...extra,
	};
}

function packument(versions: SkillVersionSummary[], distTags: Record<string, string>): SkillPackument {
	const byVersion: Record<string, SkillVersionSummary> = {};
	for (const version of versions) byVersion[version.version] = version;
	return {
		scope: SCOPE,
		name: NAME,
		description: "PDF helpers",
		keywords: [],
		owners: [{ username: SCOPE, avatar: "00" }],
		distTags,
		versions: byVersion,
		createdAt: 0,
		updatedAt: 0,
		downloads: { weekly: 0, total: 0, daily: [] },
		canManage: false,
	};
}

describe("resolveSkillVersion", () => {
	const tgz = skillTgz("x");
	const pk = packument(
		[
			summary("1.0.0", tgz),
			summary("1.1.0", tgz, { deprecated: "use 2.x" }),
			summary("1.2.0", tgz, { yanked: true }),
			summary("2.0.0-beta.1", tgz),
		],
		{ latest: "1.1.0", next: "2.0.0-beta.1" },
	);

	it("follows dist-tags rather than picking the highest version", () => {
		expect(resolveSkillVersion(pk, "next").version).toBe("2.0.0-beta.1");
		expect(resolveSkillVersion(pk, "latest").version).toBe("1.1.0");
	});

	it("returns an exact yanked version with a warning", () => {
		const resolved = resolveSkillVersion(pk, "1.2.0");
		expect(resolved.version).toBe("1.2.0");
		expect(resolved.warnings).toEqual([`${ID}@1.2.0 is yanked`]);
	});

	it("skips yanked versions when resolving a range and warns about deprecation", () => {
		const resolved = resolveSkillVersion(pk, "^1.0.0");
		expect(resolved.version).toBe("1.1.0");
		expect(resolved.warnings).toEqual([`${ID}@1.1.0 is deprecated: use 2.x`]);
	});

	it("rejects ranges that only yanked or missing versions satisfy", () => {
		expect(() => resolveSkillVersion(pk, ">=1.2.0 <2.0.0-0")).toThrow(/No non-yanked version/);
		expect(() => resolveSkillVersion(pk, "3.0.0")).toThrow(/does not exist/);
	});
});

describe("skills manifest and lock", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skillshare-manifest-"));
	});
	afterEach(async () => {
		await removeWithRetries(dir);
	});

	it("round-trips entries with sorted keys", async () => {
		const manifestPath = path.join(dir, "skills.json");
		const lockPath = path.join(dir, "skills.lock.json");
		const lock: SkillsLock = {
			version: 1,
			skills: {
				"@zed/zz": { version: "1.0.0", integrity: "sha512-b", resolved: "/b" },
				"@abc/aa": { version: "2.0.0", integrity: "sha512-a", resolved: "/a" },
			},
		};
		await writeSkillsManifest(manifestPath, { skills: { "@zed/zz": "^1.0.0", "@abc/aa": "next" } });
		await writeSkillsLock(lockPath, lock);

		expect(await readSkillsManifest(manifestPath)).toEqual({ skills: { "@abc/aa": "next", "@zed/zz": "^1.0.0" } });
		expect(await readSkillsLock(lockPath)).toEqual(lock);
		expect(Object.keys(JSON.parse(await Bun.file(lockPath).text()).skills)).toEqual(["@abc/aa", "@zed/zz"]);
	});

	it("rejects unscoped ids and unknown lockfile versions", async () => {
		const manifestPath = path.join(dir, "skills.json");
		const lockPath = path.join(dir, "skills.lock.json");
		await Bun.write(manifestPath, JSON.stringify({ skills: { "pdf-tools": "^1.0.0" } }));
		await Bun.write(lockPath, JSON.stringify({ version: 2, skills: {} }));
		await expect(readSkillsManifest(manifestPath)).rejects.toThrow(/invalid skill id "pdf-tools"/);
		await expect(readSkillsLock(lockPath)).rejects.toThrow(lockPath);
	});
});

describe("installer", () => {
	let tempHome: string;
	let project: string;
	let originalAgentDir: string;
	let client: SkillshareClient;
	let confirmations: string[];
	let approve: boolean;
	let hooks: SkillInstallHooks;
	/** What the spied client serves; tests swap it to publish new versions. */
	let registry: {
		pk: SkillPackument;
		tarballs: Record<string, Uint8Array>;
		files: SkillVersionManifest["files"];
	};

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skillshare-install-"));
		project = path.join(tempHome, "work", "proj");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		client = await SkillshareClient.create({ registryUrl: "https://skills.test" });
		registry = { pk: packument([], {}), tarballs: {}, files: [] };
		vi.spyOn(client, "packument").mockImplementation(async () => registry.pk);
		vi.spyOn(client, "version").mockImplementation(
			async (_scope, _name, version) =>
				({
					...registry.pk.versions[version]!,
					scope: SCOPE,
					name: NAME,
					files: registry.files,
				}) as SkillVersionManifest,
		);
		vi.spyOn(client, "tarball").mockImplementation(async (_scope, _name, version) => registry.tarballs[version]!);
		confirmations = [];
		approve = true;
		hooks = {
			warn: () => {},
			confirmScripts: async request => {
				confirmations.push(`${request.id}@${request.version}:${request.files.map(f => f.path).join(",")}`);
				return approve;
			},
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("installs latest with a caret range, locks it, and unpacks with exec bits", async () => {
		const tgz = skillTgz("1.1.0", { "scripts/run.sh": "#!/bin/sh\necho hi\n" }, ["scripts/run.sh"]);
		registry = {
			pk: packument([summary("1.1.0", tgz, { hasScripts: true })], { latest: "1.1.0" }),
			tarballs: { "1.1.0": tgz },
			files: [{ path: "scripts/run.sh", size: 20, sha256: "00", executable: true }],
		};

		const changes = await installSkillPackages(
			client,
			{ specs: [ID], global: false, yes: false, cwd: project },
			hooks,
		);

		expect(changes).toEqual([{ id: ID, from: undefined, to: "1.1.0", range: "^1.1.0", restored: false }]);
		expect(confirmations).toEqual([`${ID}@1.1.0:scripts/run.sh`]);
		expect(await readSkillsManifest(path.join(project, ".omp", "skills.json"))).toEqual({
			skills: { [ID]: "^1.1.0" },
		});
		const lock = await readSkillsLock(path.join(project, ".omp", "skills.lock.json"));
		expect(lock.skills[ID]).toEqual({
			version: "1.1.0",
			integrity: computeIntegrity(tgz),
			resolved: `/api/v1/skills/${ID}/versions/1.1.0/tarball`,
		});
		const store = getSkillStorePath(SCOPE, NAME, "1.1.0");
		expect(await Bun.file(path.join(store, "SKILL.md")).text()).toContain("# PDF 1.1.0");
		expect((await fs.stat(path.join(store, "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
	});

	it("aborts on an integrity mismatch before writing anything", async () => {
		const published = skillTgz("1.0.0");
		const tampered = skillTgz("1.0.0", { "extra.md": "surprise" });
		registry = {
			pk: packument([summary("1.0.0", published)], { latest: "1.0.0" }),
			tarballs: { "1.0.0": tampered },
			files: [],
		};

		await expect(
			installSkillPackages(client, { specs: [ID], global: false, yes: true, cwd: project }, hooks),
		).rejects.toThrow(/integrity mismatch/);

		await expect(fs.stat(getSkillshareStoreDir())).rejects.toThrow();
		expect(await Bun.file(path.join(project, ".omp", "skills.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(project, ".omp", "skills.lock.json")).exists()).toBe(false);
	});

	it("declining the scripts prompt downloads nothing", async () => {
		const tgz = skillTgz("1.0.0", { "scripts/run.sh": "echo" }, ["scripts/run.sh"]);
		registry = {
			pk: packument([summary("1.0.0", tgz, { hasScripts: true })], { latest: "1.0.0" }),
			tarballs: { "1.0.0": tgz },
			files: [{ path: "scripts/run.sh", size: 4, sha256: "00", executable: true }],
		};
		approve = false;

		await expect(
			installSkillPackages(client, { specs: [ID], global: true, yes: false, cwd: project }, hooks),
		).rejects.toThrow(/declined/);
		expect(confirmations).toEqual([`${ID}@1.0.0:scripts/run.sh`]);
		expect(client.tarball).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(getAgentDir(), "skills.lock.json")).exists()).toBe(false);
	});

	it("update moves to the newest in-range version, prunes the old one, and restores a missing store dir", async () => {
		const v1 = skillTgz("1.0.0");
		const v11 = skillTgz("1.1.0");
		const v2 = skillTgz("2.0.0");
		registry = { pk: packument([summary("1.0.0", v1)], { latest: "1.0.0" }), tarballs: { "1.0.0": v1 }, files: [] };
		await installSkillPackages(client, { specs: [`${ID}@^1.0.0`], global: false, yes: false, cwd: project }, hooks);

		registry = {
			pk: packument([summary("1.0.0", v1), summary("1.1.0", v11), summary("2.0.0", v2)], { latest: "2.0.0" }),
			tarballs: { "1.1.0": v11, "2.0.0": v2 },
			files: [],
		};
		const changes = await updateSkillPackages(client, { names: [], global: false, cwd: project }, hooks);

		expect(changes).toEqual([{ id: ID, from: "1.0.0", to: "1.1.0", range: "^1.0.0", restored: false }]);
		expect(await Bun.file(path.join(getSkillStorePath(SCOPE, NAME, "1.0.0"), "SKILL.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(getSkillStorePath(SCOPE, NAME, "1.1.0"), "SKILL.md")).exists()).toBe(true);

		await removeWithRetries(getSkillStorePath(SCOPE, NAME, "1.1.0"));
		const restored = await updateSkillPackages(client, { names: [ID], global: false, cwd: project }, hooks);
		expect(restored).toEqual([{ id: ID, from: "1.1.0", to: "1.1.0", range: "^1.0.0", restored: true }]);
		expect(await Bun.file(path.join(getSkillStorePath(SCOPE, NAME, "1.1.0"), "SKILL.md")).exists()).toBe(true);
	});

	it("uninstall drops manifest and lock entries and prunes the store", async () => {
		const tgz = skillTgz("1.0.0");
		registry = { pk: packument([summary("1.0.0", tgz)], { latest: "1.0.0" }), tarballs: { "1.0.0": tgz }, files: [] };
		await installSkillPackages(client, { specs: [ID], global: true, yes: false, cwd: project }, hooks);

		expect(await uninstallSkillPackages({ names: [ID], global: true, cwd: project })).toEqual([ID]);
		expect((await readSkillsManifest(path.join(getAgentDir(), "skills.json"))).skills).toEqual({});
		expect((await readSkillsLock(path.join(getAgentDir(), "skills.lock.json"))).skills).toEqual({});
		expect(await Bun.file(path.join(getSkillStorePath(SCOPE, NAME, "1.0.0"), "SKILL.md")).exists()).toBe(false);
		await expect(uninstallSkillPackages({ names: [ID], global: true, cwd: project })).rejects.toThrow(
			/not installed/,
		);
	});
});
