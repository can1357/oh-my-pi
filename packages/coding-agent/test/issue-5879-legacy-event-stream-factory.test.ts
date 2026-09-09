import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("issue #5879: legacy provider compatibility", () => {
	it("creates a fresh agent database while loading historical auth exports", async () => {
		const projectDir = TempDir.createSync("@issue-5879-");
		const freshAgentDir = projectDir.join("fresh", "agent");
		const originalDirEnv: Record<string, string | undefined> = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			OMP_PROFILE: process.env.OMP_PROFILE,
			PI_PROFILE: process.env.PI_PROFILE,
		};
		const extensionPath = path.join(projectDir.path(), "pi-provider-like-plugin", "index.ts");
		await Bun.write(
			extensionPath,
			[
				'import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";',
				'import { AuthStorage } from "@earendil-works/pi-coding-agent";',
				"",
				"export default function() {",
				"\tconst stream = createAssistantMessageEventStream();",
				'\tconst credential = AuthStorage.create().get("issue-5879-missing-provider");',
				'\tif (credential !== undefined) throw new Error("Unexpected test credential");',
				'\tif (typeof stream.push !== "function") throw new Error("Invalid assistant message event stream");',
				"}",
			].join("\n"),
		);

		setAgentDir(freshAgentDir);

		try {
			const result = await loadExtensions([extensionPath], projectDir.path());

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(await Bun.file(path.join(freshAgentDir, "agent.db")).exists()).toBe(true);
		} finally {
			for (const key in originalDirEnv) {
				const value = originalDirEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			projectDir.removeSync();
		}
	});
});
