import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager tool-type sanitization", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	// External tool names (MCP servers, extensions, RPC hosts) are arbitrary; the
	// artifact filename is `${id}.${toolType}.log`. Path separators or traversal
	// in the name must never let the file escape the artifacts directory.
	it("never lets a path-hostile tool name escape the artifacts directory", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		for (const hostile of ["../../etc/passwd", "mcp__srv/peek", "a\\b\\c", "..", "./escape", "tool name"]) {
			const { path: filePath } = await mgr.allocatePath(hostile);
			expect(path.dirname(filePath)).toBe(dir);
			expect(path.basename(filePath)).toMatch(/^\d+\.[A-Za-z0-9_-]+\.log$/);
		}
	});

	it("caps very long tool names so the filename stays within filesystem limits", async () => {
		const mgr = new ArtifactManager(freshDir());
		const { path: filePath } = await mgr.allocatePath("x".repeat(500));
		const segment = path
			.basename(filePath)
			.replace(/^\d+\./, "")
			.replace(/\.log$/, "");
		expect(segment.length).toBeLessThanOrEqual(64);
	});

	it("falls back to a stable segment when nothing survives sanitization", async () => {
		const mgr = new ArtifactManager(freshDir());
		const { path: filePath } = await mgr.allocatePath("/../");
		expect(path.basename(filePath)).toMatch(/^\d+\.tool\.log$/);
	});

	// Recovery is keyed on the numeric id, so sanitizing the type segment must not
	// break round-tripping the full content back through getPath.
	it("round-trips full content through save/getPath despite a hostile name", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		const id = await mgr.save("FULL-ORIGINAL-CONTENT", "mcp__srv/peek_topic");
		const filePath = await mgr.getPath(id);
		expect(filePath).not.toBeNull();
		expect(path.dirname(filePath as string)).toBe(dir);
		expect(await Bun.file(filePath as string).text()).toBe("FULL-ORIGINAL-CONTENT");
	});
});
