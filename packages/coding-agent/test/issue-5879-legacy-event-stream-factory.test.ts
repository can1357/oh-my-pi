import { describe, expect, it, onTestFinished } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { testLifetime } from "../../utils/test/helpers/mock-restores";

describe("issue #5879: legacy provider compatibility", () => {
	it("creates a fresh agent database while loading historical auth exports", async () => {
		const projectDir = TempDir.createSync("@issue-5879-");
		const freshAgentDir = projectDir.join("fresh", "agent");
		const originalDirEnv: Record<string, string | undefined> = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			OMP_PROFILE: process.env.OMP_PROFILE,
			PI_PROFILE: process.env.PI_PROFILE,
		};
		const life = testLifetime();
		onTestFinished(() => {
			if (originalDirEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalDirEnv.PI_CODING_AGENT_DIR;
			if (originalDirEnv.OMP_PROFILE === undefined) delete process.env.OMP_PROFILE;
			else process.env.OMP_PROFILE = originalDirEnv.OMP_PROFILE;
			if (originalDirEnv.PI_PROFILE === undefined) delete process.env.PI_PROFILE;
			else process.env.PI_PROFILE = originalDirEnv.PI_PROFILE;
			__resetDirsFromEnvForTests();
		});
		const extensionPath = path.join(projectDir.path(), "pi-provider-like-plugin", "index.ts");
		try {
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
			life.assertLive();
			setAgentDir(freshAgentDir);
			const result = await loadExtensions([extensionPath], projectDir.path());
			life.assertLive();

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(await Bun.file(path.join(freshAgentDir, "agent.db")).exists()).toBe(true);
		} finally {
			projectDir.removeSync();
		}
	});
});
