import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager concurrent first-use", () => {
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

	// First-use init (dir scan → #nextId seed) must run exactly once. Two callers
	// racing a fresh manager both yield inside #scanExistingIds before either
	// marks init done; if the second re-seeds #nextId after the first consumed an
	// id, both allocate the same numeric id and the second write clobbers the
	// first. Same toolType => file overwrite; the first id resolves to B's bytes.
	it("hands concurrent same-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A", "bash"), mgr.save("CONTENT-B", "bash")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(pathA).not.toBeNull();
		expect(pathB).not.toBeNull();
		expect(await Bun.file(pathA as string).text()).toBe("CONTENT-A");
		expect(await Bun.file(pathB as string).text()).toBe("CONTENT-B");
	});

	// Different toolTypes turn a duplicate id into two coexisting files
	// (`{id}.bash.log` + `{id}.async.log`); getPath's startsWith(`${id}.`) then
	// resolves ambiguously in unspecified readdir order. Distinct ids keep each
	// artifact:// pointing at the content its caller wrote.
	it("hands concurrent different-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("BASH-BYTES", "bash"), mgr.save("ASYNC-BYTES", "async")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(await Bun.file(pathA as string).text()).toBe("BASH-BYTES");
		expect(await Bun.file(pathB as string).text()).toBe("ASYNC-BYTES");
	});

	// The race also re-opens on a fresh manager over a directory that already
	// holds artifacts (e.g. after a `#artifactManager = null` reset): the scan
	// seeds from maxId, and concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated directory", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.save("OLD", "bash");

		const mgr = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A", "bash"), mgr.save("NEW-B", "bash")]);

		expect(idA).not.toBe(idB);
		expect(await Bun.file((await mgr.getPath(idA)) as string).text()).toBe("NEW-A");
		expect(await Bun.file((await mgr.getPath(idB)) as string).text()).toBe("NEW-B");
	});
});
