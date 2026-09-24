import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bumpVersion, packSkill } from "../../src/skillshare/pack";
import { readTar } from "../../src/skillshare/tar";

let tempDir: TempDir;

beforeEach(async () => {
	tempDir = await TempDir.create("@pi-skillshare-pack-");
});

afterEach(async () => {
	await tempDir.remove();
});

const SKILL_MD = `---
name: pdf-tools
description: Work with PDF files.
metadata:
  version: 1.2.3
  keywords: pdf, documents
---

# PDF tools
`;

async function writeFiles(files: Record<string, string>): Promise<void> {
	for (const relPath in files) {
		const absolute = tempDir.join(relPath);
		await fs.mkdir(path.dirname(absolute), { recursive: true });
		await Bun.write(absolute, files[relPath]);
	}
}

function skillMd(frontmatter: string): string {
	return `---\n${frontmatter}\n---\n\nbody\n`;
}

describe("packSkill", () => {
	test("honors default ignores and .skillignore, and packs a verifiable tarball", async () => {
		await writeFiles({
			"SKILL.md": SKILL_MD,
			"scripts/run.sh": "#!/bin/sh\necho run\n",
			"reference/guide.md": "guide",
			"notes.log": "log",
			"keep.log": "keep",
			"drafts/wip.md": "wip",
			"root-only.txt": "root",
			"reference/root-only.txt": "nested",
			".git/config": "[core]",
			"node_modules/dep/index.js": "x",
			"lib/__pycache__/mod.cpython-312.pyc": "x",
			"lib/mod.pyc": "x",
			"lib/mod.py": "print(1)",
			"evals/case.json": "{}",
			".DS_Store": "x",
			".skillignore": "# comment\n*.log\n!keep.log\ndrafts/\n/root-only.txt\n",
		});
		await fs.chmod(tempDir.join("scripts/run.sh"), 0o755);

		const pack = await packSkill(tempDir.path());
		expect(pack.name).toBe("pdf-tools");
		expect(pack.version).toBe("1.2.3");
		expect(pack.description).toBe("Work with PDF files.");
		expect(pack.files.map(file => file.path)).toEqual([
			"SKILL.md",
			"keep.log",
			"lib/mod.py",
			"reference/guide.md",
			"reference/root-only.txt",
			"scripts/run.sh",
		]);
		expect(pack.files.find(file => file.path === "scripts/run.sh")?.executable).toBe(true);
		expect(pack.files.find(file => file.path === "SKILL.md")?.executable).toBe(false);
		expect(pack.hasScripts).toBe(true);
		expect(pack.secrets).toEqual([]);

		const entries = readTar(Bun.gunzipSync(pack.tgz));
		expect(entries.map(entry => entry.path)).toEqual(pack.files.map(file => file.path));
		expect(new TextDecoder().decode(entries[0].content)).toBe(SKILL_MD);
		expect(pack.integrity).toBe(`sha512-${new Bun.CryptoHasher("sha512").update(pack.tgz).digest("base64")}`);

		const again = await packSkill(tempDir.path());
		expect(again.integrity).toBe(pack.integrity);
	});

	test("rejects symlinks", async () => {
		await writeFiles({ "SKILL.md": SKILL_MD, "real.md": "real" });
		await fs.symlink(tempDir.join("real.md"), tempDir.join("link.md"));
		await expect(packSkill(tempDir.path())).rejects.toThrow(/symlinks are not allowed.*link\.md/);
	});

	test("enforces file count and path length limits", async () => {
		await writeFiles({ "SKILL.md": SKILL_MD });
		const longDir = tempDir.join("a".repeat(100), "b".repeat(100));
		await fs.mkdir(longDir, { recursive: true });
		await Bun.write(path.join(longDir, "c".repeat(60)), "x");
		await expect(packSkill(tempDir.path())).rejects.toThrow(/path exceeds 255 bytes/);

		await fs.rm(tempDir.join("a".repeat(100)), { recursive: true });
		await fs.mkdir(tempDir.join("many"));
		await Promise.all(Array.from({ length: 1000 }, (_, i) => Bun.write(tempDir.join("many", `${i}.txt`), "x")));
		await expect(packSkill(tempDir.path())).rejects.toThrow(/exceeds 1000 files/);
	});

	test("rejects SKILL.md that violates the spec or registry rules", async () => {
		const cases: [frontmatter: string, error: RegExp][] = [
			["name: pdf-tools\ndescription: d", /metadata\.version" is required/],
			['name: pdf-tools\ndescription: d\nmetadata:\n  version: "1.2"', /must be a semantic version/],
			["name: pdf-tools\ndescription: d\nmetadata:\n  version: 01.2.3", /must be a semantic version/],
			["name: Pdf-Tools\ndescription: d\nmetadata:\n  version: 1.0.0", /lowercase/],
			["name: pdf-tööls\ndescription: d\nmetadata:\n  version: 1.0.0", /kebab-case/],
			[
				"name: pdf-tools\ndescription: d\nenabled: true\nmetadata:\n  version: 1.0.0",
				/unexpected frontmatter field "enabled"/,
			],
			["name: pdf-tools\nmetadata:\n  version: 1.0.0", /missing required "description"/],
			[
				"name: pdf-tools\ndescription: d\nmetadata:\n  version: 1.0.0\n  homepage: http://example.com",
				/metadata\.homepage" must be an https URL/,
			],
			[
				`name: pdf-tools\ndescription: d\nmetadata:\n  version: 1.0.0\n  keywords: ${Array.from({ length: 21 }, (_, i) => `k${i}`).join(", ")}`,
				/more than 20 keywords/,
			],
		];
		for (const [frontmatter, error] of cases) {
			await Bun.write(tempDir.join("SKILL.md"), skillMd(frontmatter));
			await expect(packSkill(tempDir.path())).rejects.toThrow(error);
		}
	});

	test("reports credential-shaped strings with their line", async () => {
		await writeFiles({
			"SKILL.md": SKILL_MD,
			"config/env.sh": "#!/bin/sh\n# setup\nexport AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
			"keys/id.pem":
				"notes\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\n",
			"clean.md": "token_expiry_seconds = 30 and sk-short\n",
		});
		const pack = await packSkill(tempDir.path());
		expect(pack.secrets).toEqual([
			{ path: "config/env.sh", line: 3, kind: "AWSAccessKey" },
			{ path: "keys/id.pem", line: 2, kind: "PrivateKey" },
		]);
	});
});

describe("bumpVersion", () => {
	const original = [
		"---",
		"# leading comment",
		"name: pdf-tools",
		"description: 'Work: with PDFs'",
		"metadata:",
		"    keywords: pdf",
		'    version: "1.2.3" # keep me',
		"    homepage: https://example.com",
		"allowed-tools: Read",
		"---",
		"",
		"version: 9.9.9 in the body stays",
		"",
	].join("\r\n");

	test("rewrites only the metadata version line", async () => {
		await Bun.write(tempDir.join("SKILL.md"), original);
		expect(await bumpVersion(tempDir.path(), "minor")).toBe("1.3.0");
		expect(await Bun.file(tempDir.join("SKILL.md")).text()).toBe(
			original.replace('    version: "1.2.3" # keep me', '    version: "1.3.0" # keep me'),
		);
	});

	test("applies npm-style increments and explicit versions", async () => {
		const withVersion = (version: string) =>
			skillMd(`name: pdf-tools\ndescription: d\nmetadata:\n  version: ${version}`);
		const cases: [from: string, kind: string, to: string][] = [
			["1.2.3", "patch", "1.2.4"],
			["1.2.3", "major", "2.0.0"],
			["1.2.3-beta.1", "patch", "1.2.3"],
			["1.3.0-rc.1", "minor", "1.3.0"],
			["2.0.0-rc.1", "major", "2.0.0"],
			["1.2.3", "2.0.0-beta.1", "2.0.0-beta.1"],
		];
		for (const [from, kind, to] of cases) {
			await Bun.write(tempDir.join("SKILL.md"), withVersion(from));
			expect(await bumpVersion(tempDir.path(), kind)).toBe(to);
			expect(await Bun.file(tempDir.join("SKILL.md")).text()).toBe(withVersion(to));
		}

		await Bun.write(tempDir.join("SKILL.md"), withVersion("1.2.3"));
		await expect(bumpVersion(tempDir.path(), "1.2.0")).rejects.toThrow(/must be greater/);
		await expect(bumpVersion(tempDir.path(), "banana")).rejects.toThrow(/expected patch, minor, major/);
	});

	test("inserts the version when metadata or its version is missing", async () => {
		const bare = "---\nname: pdf-tools\ndescription: d\n---\nbody\n";
		await Bun.write(tempDir.join("SKILL.md"), bare);
		expect(await bumpVersion(tempDir.path(), "patch")).toBe("0.0.1");
		expect(await Bun.file(tempDir.join("SKILL.md")).text()).toBe(
			"---\nname: pdf-tools\ndescription: d\nmetadata:\n  version: 0.0.1\n---\nbody\n",
		);

		const noVersion = "---\nname: pdf-tools\nmetadata:\n   keywords: pdf\ndescription: d\n---\nbody\n";
		await Bun.write(tempDir.join("SKILL.md"), noVersion);
		expect(await bumpVersion(tempDir.path(), "1.0.0")).toBe("1.0.0");
		expect(await Bun.file(tempDir.join("SKILL.md")).text()).toBe(
			"---\nname: pdf-tools\nmetadata:\n   version: 1.0.0\n   keywords: pdf\ndescription: d\n---\nbody\n",
		);
	});
});
