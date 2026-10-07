import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { registerArtifactsDir, sessionFilesFromDisk } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("sessionFilesFromDisk", () => {
	it("resolves a repeated id to the caller's preferred dir even when its copy is nested deeper", async () => {
		using tempDir = TempDir.createSync("session-files-");
		const preferred = path.join(tempDir.path(), "preferred");
		const registered = path.join(tempDir.path(), "registered");
		// The registered copy is top-level, so its listing lands first; the preferred dir still wins.
		const deepPreferred = path.join(preferred, "a", "b", "c", "Worker.jsonl");
		await Bun.write(deepPreferred, "");
		await Bun.write(path.join(registered, "Worker.jsonl"), "");
		cleanups.push(registerArtifactsDir(registered));

		const found = await sessionFilesFromDisk(preferred);

		expect(found.get("Worker")).toBe(deepPreferred);
	});
});
