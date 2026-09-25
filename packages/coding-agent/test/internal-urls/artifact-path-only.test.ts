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
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Path consumers (search/grep, the bash shell filesystem) only need the artifact's
 * filesystem path. Blocking them for large artifacts would break `search`
 * against MCP results and `bash` commands that reference the file — the very
 * workflows the read-tool guidance points users toward.
 */
describe("artifact:// locate vs content resolution", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;
	const handler = new ArtifactProtocolHandler();

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-path-only-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		// 9 MiB — larger than the 8 MiB inline cap so `resolve` refuses to
		// materialize while `locate` still returns the backing file.
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

describe("resolveToolSearchScope locates large artifacts", () => {
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

	it("resolves ast_grep/ast_edit search scope for large artifacts without the inline-content cap", async () => {
		// The URL stays the search root; its stat must reach the backing file, not
		// InternalUrlRouter's capped content resolution.
		const scope = await resolveToolSearchScope({
			rawPaths: ["artifact://0"],
			cwd: testDir,
			internalUrlAction: "search",
			filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
		});
		expect(scope.searchPath).toBe("artifact://0");
		expect(scope.isDirectory).toBe(false);
	});
});
