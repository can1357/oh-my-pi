import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("rejects a short write instead of publishing an unreadable artifact id", async () => {
		const manager = new ArtifactManager(freshDir());
		vi.spyOn(Bun, "write").mockResolvedValue(1);

		await expect(manager.save("complete report", "task")).rejects.toThrow(
			"Artifact write incomplete: wrote 1 of 15 bytes",
		);
	});

	it("leaves no discoverable file when the staged write falls short", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		// Faithfully model a short write: partial bytes land on the staging file,
		// and Bun.write reports fewer bytes than requested.
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 3));
			return 3;
		});

		await expect(writeArtifact(destination, "full report body")).rejects.toThrow("Artifact write incomplete");

		// Neither the destination nor a leftover staging file survives, so
		// agent:// / artifact:// scans cannot resolve a truncated artifact.
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("preserves the prior artifact when a follow-up write fails", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 2));
			return 2;
		});

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");

		expect(await Bun.file(destination).text()).toBe("original valid report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});

	it("replaces an existing artifact when Windows rejects rename-over-target", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original report");

		const rename = fs.rename.bind(fs);
		let injected = false;
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(source).includes(".tmp-") && String(target) === destination) {
				injected = true;
				throw Object.assign(new Error("injected Windows replacement failure"), { code: "EEXIST" });
			}
			await rename(source, target);
		});

		await writeArtifact(destination, "replacement report");

		expect(injected).toBe(true);
		expect(await Bun.file(destination).text()).toBe("replacement report");
		expect(await fs.readdir(dir)).toEqual(["Worker.md"]);
	});
});
