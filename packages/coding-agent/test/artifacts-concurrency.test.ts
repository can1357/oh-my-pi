import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries, spillFileName } from "@oh-my-pi/pi-utils";

describe("ArtifactManager spill ids", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "local");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	async function contentOf(mgr: ArtifactManager, id: string): Promise<string> {
		const filePath = await mgr.getPath(id);
		expect(filePath).not.toBeNull();
		return Bun.file(filePath as string).text();
	}

	// First-use init (dir scan → #nextId seed) must run exactly once. Two callers
	// racing a fresh manager both yield inside #scanExistingIds before either
	// marks init done; if the second re-seeds #nextId after the first consumed an
	// id, both allocate the same numeric id and the second write clobbers the first.
	it("hands concurrent savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir(), null);
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A"), mgr.save("CONTENT-B")]);

		expect(idA).not.toBe(idB);
		expect(await contentOf(mgr, idA)).toBe("CONTENT-A");
		expect(await contentOf(mgr, idB)).toBe("CONTENT-B");
	});

	// A fresh manager over a root that already holds spills (a resumed session)
	// seeds from the highest id; concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated root", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir, null);
		const oldId = await seed.save("OLD");

		const mgr = new ArtifactManager(dir, null);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A"), mgr.save("NEW-B")]);

		expect(new Set([oldId, idA, idB]).size).toBe(3);
		expect(await contentOf(mgr, oldId)).toBe("OLD");
		expect(await contentOf(mgr, idA)).toBe("NEW-A");
		expect(await contentOf(mgr, idB)).toBe("NEW-B");
	});

	// Spills share the `local://` root with the model's own writes. A `<N>.log`
	// the model writes after the id scan must be skipped, not clobbered.
	it("never overwrites a model-written <N>.log at the local:// root", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir, null);
		const firstId = await mgr.save("FIRST SPILL");
		const nextId = String(Number(firstId) + 1);
		const modelFile = path.join(dir, spillFileName(nextId));
		await Bun.write(modelFile, "MODEL NOTES");

		const spillId = await mgr.save("SECOND SPILL");

		expect(spillId).not.toBe(nextId);
		expect(await Bun.file(modelFile).text()).toBe("MODEL NOTES");
		expect(await contentOf(mgr, spillId)).toBe("SECOND SPILL");
		expect((await fs.readdir(dir)).sort()).toEqual(
			[spillFileName(firstId), spillFileName(nextId), spillFileName(spillId)].sort(),
		);
	});
});
