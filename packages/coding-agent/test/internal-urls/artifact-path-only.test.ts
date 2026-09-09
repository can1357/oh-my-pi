import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Path-only callers (search/grep, bash URL expansion) only need the artifact's
 * filesystem path. Blocking them for large artifacts would break `search`
 * against MCP results and `bash` commands that reference the file — the very
 * workflows the read-tool guidance points users toward.
 */
describe("artifact:// path-only resolution", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;
	const handler = new ArtifactProtocolHandler();

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-path-only-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		// 9 MiB — larger than the 8 MiB inline cap so `pathOnly: false` refuses to
		// materialize while `pathOnly: true` returns the shape unchanged.
		const bytes = Buffer.alloc(9 * 1024 * 1024, 65);
		await Bun.write(path.join(artifactDir, "0.mcp.log"), bytes);
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("returns the artifact source path for large artifacts under pathOnly without reading its bytes", async () => {
		const url = parseInternalUrl("artifact://0");
		const resource = await handler.resolve(url, { pathOnly: true });

		expect(resource.sourcePath).toBe(path.join(artifactDir, "0.mcp.log"));
		expect(resource.size).toBe(9 * 1024 * 1024);
		// Content must NOT be materialized — that is the whole point of pathOnly.
		expect(resource.content).toBe("");
	});

	it("still rejects full content resolution for large artifacts (existing OOM guard)", async () => {
		const url = parseInternalUrl("artifact://0");
		await expect(handler.resolve(url)).rejects.toThrow(/full internal resolution is blocked/);
	});

	it("materializes small artifacts on ordinary resolution", async () => {
		const smallArtifactDir = path.join(testDir, "small-session");
		await fs.mkdir(smallArtifactDir, { recursive: true });
		await Bun.write(path.join(smallArtifactDir, "9.mcp.log"), "hello world\n");
		const unregisterSmall = registerArtifactsDir(smallArtifactDir);
		try {
			const url = parseInternalUrl("artifact://9");
			const resource = await handler.resolve(url);
			expect(resource.content).toBe("hello world\n");
			expect(resource.sourcePath).toBe(path.join(smallArtifactDir, "9.mcp.log"));
		} finally {
			unregisterSmall();
		}
	});
});

describe("resolveToolSearchScope handles large artifacts via pathOnly", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-scope-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		const bytes = Buffer.alloc(9 * 1024 * 1024, 65);
		await Bun.write(path.join(artifactDir, "0.mcp.log"), bytes);
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("resolves ast_grep/ast_edit search scope to the backing file for large artifacts", async () => {
		const scope = await resolveToolSearchScope({
			rawPaths: ["artifact://0"],
			cwd: testDir,
			internalUrlAction: "search",
		});
		// Scope resolution must reach the artifact's real path without going through
		// InternalUrlRouter's inline-content cap.
		expect(scope.searchPath).toBe(path.join(artifactDir, "0.mcp.log"));
	});
});
