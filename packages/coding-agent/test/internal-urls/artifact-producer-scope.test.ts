import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { ArtifactManager, readArtifactProvenance } from "@oh-my-pi/pi-coding-agent/session/artifacts";

describe("artifact:// producer scope", () => {
	const roots: string[] = [];

	afterEach(async () => {
		resetRegisteredArtifactDirsForTests();
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	});

	it("records producer provenance and prevents a child from resolving or enumerating parent artifacts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-producer-scope-"));
		roots.push(root);
		const dir = path.join(root, "artifacts");
		const manager = new ArtifactManager(dir);
		const parentId = await manager.save("parent secret", "read", "parent-session");
		const childId = await manager.save("child output", "bash", "child-session");
		registerArtifactsDir(dir);

		expect(await readArtifactProvenance(dir, parentId)).toEqual({
			version: 1,
			producerSessionId: "parent-session",
		});

		const handler = new ArtifactProtocolHandler();
		const context = {
			sessionId: "child-session",
			localProtocolOptions: {
				getArtifactsDir: () => dir,
				artifactResolutionScope: "producer" as const,
			},
		};
		const own = await handler.resolve(parseInternalUrl(`artifact://${childId}`), context);
		expect(own.content).toBe("child output");
		expect(own.sourcePath).toBe(path.join(dir, `${childId}.bash.log`));

		const crossRead = handler.resolve(parseInternalUrl(`artifact://${parentId}`), context);
		await expect(crossRead).rejects.toThrow(`Artifact ${parentId} not found`);
		await expect(crossRead).rejects.not.toThrow("Available:");
		await expect(handler.resolve(parseInternalUrl("artifact://999"), context)).rejects.not.toThrow("Available:");
		expect(await handler.complete("", context)).toEqual([{ value: childId }]);
	});

	it("fails closed for legacy artifacts without producer metadata", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-producer-legacy-"));
		roots.push(root);
		const dir = path.join(root, "artifacts");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "0.read.log"), "legacy output");
		registerArtifactsDir(dir);

		const handler = new ArtifactProtocolHandler();
		await expect(
			handler.resolve(parseInternalUrl("artifact://0"), {
				sessionId: "child-session",
				localProtocolOptions: {
					getArtifactsDir: () => dir,
					artifactResolutionScope: "producer",
				},
			}),
		).rejects.toThrow("Artifact 0 not found");
	});
});
