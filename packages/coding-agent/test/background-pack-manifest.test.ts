import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	type BackgroundPackWarningCode,
	MAX_BACKGROUND_PACK_DECODED_BYTES,
	MAX_BACKGROUND_PACK_MANIFEST_BYTES,
	MAX_BACKGROUND_PACK_MANIFESTS,
	MAX_BACKGROUND_PACK_SOURCE_BYTES,
	MAX_BACKGROUND_PACK_SOURCES_PER_MANIFEST,
	resolveBackgroundPackManifests,
} from "../src/context/background-packs";

async function writeManifest(packDir: string, sources: string[], name = "General reference"): Promise<string> {
	await fs.mkdir(packDir, { recursive: true });
	const manifestPath = path.join(packDir, "pack.json");
	await Bun.write(manifestPath, JSON.stringify({ version: 1, name, sources }));
	return manifestPath;
}

describe("background-pack manifest resolver", () => {
	it("reads only explicitly listed sources in manifest order", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-manifest-");
		const root = tempDir.path();
		const workspace = path.join(root, "workspace");
		const packDir = path.join(root, "pack");
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(packDir, { recursive: true });
		await Bun.write(path.join(packDir, "first.md"), "FIRST");
		await Bun.write(path.join(packDir, "second.txt"), "SECOND");
		await Bun.write(path.join(packDir, "unlisted.md"), "MUST NOT APPEAR");
		const manifestPath = await writeManifest(packDir, ["second.txt", "first.md"]);

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [workspace],
		});

		expect(result.warnings).toEqual([]);
		expect(result.packs).toHaveLength(1);
		expect(result.packs[0]?.text).toBe("SECOND\n\nFIRST");
		expect(result.packs[0]?.sourceCount).toBe(2);
		expect(result.packs[0]?.text).not.toContain("MUST NOT APPEAR");
	});

	it("rejects URLs, globs, traversal, unsupported files, and workspace sources", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-unsafe-");
		const root = tempDir.path();
		const packDir = path.join(root, "pack");
		const workspace = path.join(packDir, "workspace");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, "secret.md"), "workspace secret");
		await Bun.write(path.join(packDir, "binary.exe"), "not supported");

		const urlResult = await resolveBackgroundPackManifests(["https://example.test/pack.json"], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(urlResult.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);

		const globResult = await resolveBackgroundPackManifests([path.join(packDir, "*.json")], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(globResult.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);

		const cases: Array<{ source: string; code: BackgroundPackWarningCode }> = [
			{ source: "../workspace/secret.md", code: "source-invalid" },
			{ source: ["nested", "..", "workspace", "secret.md"].join(String.fromCharCode(92)), code: "source-invalid" },
			{ source: "binary.exe", code: "source-unsupported" },
			{ source: "workspace/secret.md", code: "source-unsafe" },
		];
		for (const testCase of cases) {
			const manifestPath = await writeManifest(packDir, [testCase.source]);
			const result = await resolveBackgroundPackManifests([manifestPath], {
				agentDir: root,
				workspaceRoots: [workspace],
			});
			expect(result.packs).toEqual([]);
			expect(result.warnings.map(warning => warning.code)).toEqual([testCase.code]);
		}
	});

	it("reports missing manifests and missing listed sources without falling back", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-missing-");
		const root = tempDir.path();
		const workspace = path.join(root, "workspace");
		const packDir = path.join(root, "pack");
		await fs.mkdir(workspace, { recursive: true });
		const missingManifest = await resolveBackgroundPackManifests([path.join(root, "missing.json")], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(missingManifest.warnings.map(warning => warning.code)).toEqual(["manifest-missing"]);

		const manifestPath = await writeManifest(packDir, ["missing.md"]);
		const missingSource = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(missingSource.packs).toEqual([]);
		expect(missingSource.warnings.map(warning => warning.code)).toEqual(["source-missing"]);
	});

	it("rejects a junction that resolves a listed source into the workspace", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-junction-");
		const root = tempDir.path();
		const workspace = path.join(root, "workspace");
		const packDir = path.join(root, "pack");
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(packDir, { recursive: true });
		await Bun.write(path.join(workspace, "secret.md"), "workspace secret");
		await fs.symlink(
			workspace,
			path.join(packDir, "linked-workspace"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const manifestPath = await writeManifest(packDir, ["linked-workspace/secret.md"]);

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [workspace],
		});

		expect(result.packs).toEqual([]);
		expect(result.warnings.map(warning => warning.code)).toEqual(["source-unsafe"]);
	});

	it("rejects manifests located inside the active workspace", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-workspace-");
		const workspace = path.join(tempDir.path(), "workspace");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, "source.md"), "active task material");
		const manifestPath = await writeManifest(workspace, ["source.md"]);

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: tempDir.path(),
			workspaceRoots: [workspace],
		});

		expect(result.packs).toEqual([]);
		expect(result.warnings.map(warning => warning.code)).toEqual(["manifest-unsafe"]);
	});

	it("fails closed for malformed persisted manifest configuration", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-config-");
		const options = {
			agentDir: tempDir.path(),
			workspaceRoots: [path.join(tempDir.path(), "workspace")],
		};

		for (const malformed of [null, "pack.json", { manifest: "pack.json" }]) {
			const result = await resolveBackgroundPackManifests(malformed, options);
			expect(result.packs).toEqual([]);
			expect(result.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);
			expect(result.warnings[0]?.message).not.toContain(tempDir.path());
		}

		const invalidEntry = await resolveBackgroundPackManifests([42], options);
		expect(invalidEntry.packs).toEqual([]);
		expect(invalidEntry.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);
		expect(invalidEntry.warnings[0]?.message).not.toContain("42");
	});

	it("caps configured manifests and explicitly listed sources", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-count-");
		const root = tempDir.path();
		const options = {
			agentDir: root,
			workspaceRoots: [path.join(root, "workspace")],
		};

		const tooManyManifests = await resolveBackgroundPackManifests(
			Array.from({ length: MAX_BACKGROUND_PACK_MANIFESTS + 1 }, () => "missing.json"),
			options,
		);
		expect(tooManyManifests.packs).toEqual([]);
		expect(tooManyManifests.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);
		expect(tooManyManifests.warnings[0]?.message).not.toContain("missing.json");

		const packDir = path.join(root, "pack");
		const manifestPath = await writeManifest(
			packDir,
			Array.from({ length: MAX_BACKGROUND_PACK_SOURCES_PER_MANIFEST + 1 }, (_, index) => `source-${index}.md`),
		);
		const tooManySources = await resolveBackgroundPackManifests([manifestPath], options);
		expect(tooManySources.packs).toEqual([]);
		expect(tooManySources.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);
		expect(tooManySources.warnings[0]?.message).not.toContain("source-0.md");
	});

	it("rejects oversized manifests before parsing their content", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-manifest-size-");
		const root = tempDir.path();
		const packDir = path.join(root, "pack");
		await fs.mkdir(packDir, { recursive: true });
		const manifestPath = path.join(packDir, "pack.json");
		const sensitiveText = "DO_NOT_DISCLOSE_MANIFEST_CONTENT";
		await Bun.write(manifestPath, sensitiveText + " ".repeat(MAX_BACKGROUND_PACK_MANIFEST_BYTES + 1));

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [path.join(root, "workspace")],
		});

		expect(result.packs).toEqual([]);
		expect(result.warnings.map(warning => warning.code)).toEqual(["manifest-invalid"]);
		expect(result.warnings[0]?.message).not.toContain(manifestPath);
		expect(result.warnings[0]?.message).not.toContain(sensitiveText);
	});

	it("rejects an oversized source without a text fallback", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-source-size-");
		const root = tempDir.path();
		const packDir = path.join(root, "pack");
		await fs.mkdir(packDir, { recursive: true });
		const sourceName = "large.md";
		const sensitiveText = "DO_NOT_DISCLOSE_SOURCE_CONTENT";
		await Bun.write(path.join(packDir, sourceName), sensitiveText + "x".repeat(MAX_BACKGROUND_PACK_SOURCE_BYTES + 1));
		const manifestPath = await writeManifest(packDir, [sourceName]);

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [path.join(root, "workspace")],
		});

		expect(result.packs).toEqual([]);
		expect(result.warnings.map(warning => warning.code)).toEqual(["source-invalid"]);
		expect(result.warnings[0]?.message).not.toContain(sourceName);
		expect(result.warnings[0]?.message).not.toContain(sensitiveText);
	});

	it("rejects packs whose decoded sources exceed the aggregate limit", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-aggregate-size-");
		const root = tempDir.path();
		const packDir = path.join(root, "pack");
		await fs.mkdir(packDir, { recursive: true });
		const chunkSize = Math.min(MAX_BACKGROUND_PACK_SOURCE_BYTES, Math.ceil(MAX_BACKGROUND_PACK_DECODED_BYTES / 4));
		const sourceCount = Math.floor(MAX_BACKGROUND_PACK_DECODED_BYTES / chunkSize) + 1;
		expect(sourceCount).toBeLessThanOrEqual(MAX_BACKGROUND_PACK_SOURCES_PER_MANIFEST);
		const sources = Array.from({ length: sourceCount }, (_, index) => `part-${index}.md`);
		for (const sourceName of sources) {
			await Bun.write(path.join(packDir, sourceName), "x".repeat(chunkSize));
		}
		const manifestPath = await writeManifest(packDir, sources);

		const result = await resolveBackgroundPackManifests([manifestPath], {
			agentDir: root,
			workspaceRoots: [path.join(root, "workspace")],
		});

		expect(result.packs).toEqual([]);
		expect(result.warnings.map(warning => warning.code)).toEqual(["source-invalid"]);
		expect(result.warnings[0]?.message).not.toContain(sources.at(-1) ?? "");
	});

	it("rejects hard-linked manifests and sources that alias workspace files", async () => {
		using tempDir = TempDir.createSync("@omp-background-pack-hardlink-");
		const root = tempDir.path();
		const workspace = path.join(root, "workspace");
		const manifestPackDir = path.join(root, "manifest-link-pack");
		const sourcePackDir = path.join(root, "source-link-pack");
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(manifestPackDir, { recursive: true });
		await fs.mkdir(sourcePackDir, { recursive: true });

		const workspaceManifest = path.join(workspace, "pack.json");
		await Bun.write(
			workspaceManifest,
			JSON.stringify({ version: 1, name: "Workspace alias", sources: ["source.md"] }),
		);
		const linkedManifest = path.join(manifestPackDir, "pack.json");
		await fs.link(workspaceManifest, linkedManifest);
		const manifestResult = await resolveBackgroundPackManifests([linkedManifest], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(manifestResult.packs).toEqual([]);
		expect(manifestResult.warnings.map(warning => warning.code)).toEqual(["manifest-unsafe"]);
		expect(manifestResult.warnings[0]?.message).not.toContain(workspaceManifest);

		const workspaceSource = path.join(workspace, "secret.md");
		const sensitiveText = "WORKSPACE_HARDLINK_SECRET";
		await Bun.write(workspaceSource, sensitiveText);
		const linkedSourceName = "reference.md";
		await fs.link(workspaceSource, path.join(sourcePackDir, linkedSourceName));
		const sourceManifest = await writeManifest(sourcePackDir, [linkedSourceName]);
		const sourceResult = await resolveBackgroundPackManifests([sourceManifest], {
			agentDir: root,
			workspaceRoots: [workspace],
		});
		expect(sourceResult.packs).toEqual([]);
		expect(sourceResult.warnings.map(warning => warning.code)).toEqual(["source-unsafe"]);
		expect(sourceResult.warnings[0]?.message).not.toContain(workspaceSource);
		expect(sourceResult.warnings[0]?.message).not.toContain(sensitiveText);
	});
});
