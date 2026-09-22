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
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
		await Bun.write(path.join(dir, `${childId}.md`), "numeric-named child transcript");
		await Bun.write(path.join(dir, "99.jsonl"), "numeric-named unrelated transcript");
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

	it.each(["fork", "forkFrom"] as const)("%s preserves child provenance in shared artifact storage", async kind => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-fork-producers-"));
		roots.push(root);
		const parent = SessionManager.create(root, root);
		parent.appendMessage({ role: "user", content: "fork me", timestamp: 1 });
		await parent.ensureOnDisk();
		const parentId = await parent.saveArtifact("parent output", "read");
		if (!parentId) throw new Error("Expected parent artifact");
		const shared = parent.getArtifactManager()!;
		const childId = await shared.save("child secret", "read", "child-session");
		const source = parent.getSessionFile()!;
		const forked =
			kind === "fork" ? (await parent.fork(), parent) : await SessionManager.forkFrom(source, root, root);
		try {
			const dir = forked.getSessionFile()!.slice(0, -".jsonl".length);
			const handler = new ArtifactProtocolHandler();
			const context = {
				sessionId: forked.getSessionId(),
				localProtocolOptions: {
					getArtifactsDir: () => dir,
					artifactResolutionScope: "producer" as const,
				},
			};
			expect((await handler.resolve(parseInternalUrl(`artifact://${parentId}`), context)).content).toBe(
				"parent output",
			);
			await expect(handler.resolve(parseInternalUrl(`artifact://${childId}`), context)).rejects.toThrow("not found");
			expect(await handler.complete("", context)).toEqual([{ value: parentId }]);
			expect(
				(
					await handler.resolve(parseInternalUrl(`artifact://${childId}`), {
						...context,
						sessionId: "child-session",
					})
				).content,
			).toBe("child secret");
		} finally {
			await forked.close();
			if (forked !== parent) await parent.close();
		}
	});

	it("does not resolve or enumerate numeric-named non-artifact files in shared scope", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-shared-filename-"));
		roots.push(root);
		await Bun.write(path.join(root, "0.md"), "subagent output");
		await Bun.write(path.join(root, "1.jsonl"), "subagent transcript");
		registerArtifactsDir(root);

		const handler = new ArtifactProtocolHandler();
		await expect(handler.resolve(parseInternalUrl("artifact://0"))).rejects.toThrow(
			"Artifact 0 not found. Available: none",
		);
		expect(await handler.complete()).toEqual([]);
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
