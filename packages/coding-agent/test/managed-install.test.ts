import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { managedInstallName } from "@oh-my-pi/pi-coding-agent/cli/managed-install";
import { TempDir } from "@oh-my-pi/pi-utils";

let temp: TempDir;

beforeEach(async () => {
	temp = await TempDir.create("@omp-managed-install-");
});

afterEach(async () => {
	await temp.remove();
});

/** A manager's root holding executable `versions/1.0.0` and engine directory `versions/engine-1.0.0`. */
async function managedRoot(): Promise<string> {
	const root = path.join(temp.path(), crypto.randomUUID());
	await Bun.write(path.join(root, "versions", "1.0.0"), "omp");
	await Bun.write(path.join(root, "versions", "engine-1.0.0", "ABHost"), "host");
	await fs.mkdir(path.join(root, "bin"));
	await Bun.write(path.join(root, "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
	return root;
}

describe("managedInstallName", () => {
	it.skipIf(process.platform === "win32")(
		"names the manager through the launcher symlink and a link outside the root",
		async () => {
			const root = await managedRoot();
			const launcher = path.join(root, "bin", "omp");
			await fs.symlink(path.join("..", "versions", "1.0.0"), launcher);
			const outside = path.join(temp.path(), "omp");
			await fs.symlink(launcher, outside);

			expect(await managedInstallName(launcher)).toBe("Tern");
			expect(await managedInstallName(outside)).toBe("Tern");
		},
	);

	it("names the manager of a copied launcher (Windows layout)", async () => {
		const root = await managedRoot();
		const copy = path.join(root, "bin", "omp.exe");
		await Bun.write(copy, "omp");

		expect(await managedInstallName(copy)).toBe("Tern");
	});

	it.skipIf(process.platform === "win32")(
		"names the manager of an engine directory linked from elsewhere",
		async () => {
			const root = await managedRoot();
			const engine = path.join(temp.path(), "lib", "abkit");
			await fs.mkdir(path.dirname(engine), { recursive: true });
			await fs.symlink(path.join(root, "versions", "engine-1.0.0"), engine);

			expect(await managedInstallName(engine)).toBe("Tern");
			// A host executable inside it sits one folder deeper: the engine directory is what is judged.
			expect(await managedInstallName(path.join(engine, "ABHost"))).toBeUndefined();
		},
	);

	it("treats an install without a readable manifest as unmanaged", async () => {
		const plain = path.join(temp.path(), "bin", "omp");
		await Bun.write(plain, "omp");
		expect(await managedInstallName(plain)).toBeUndefined();
		expect(await managedInstallName(path.join(temp.path(), "missing"))).toBeUndefined();

		const root = await managedRoot();
		await Bun.write(path.join(root, "manager.json"), "{not json");
		expect(await managedInstallName(path.join(root, "versions", "1.0.0"))).toBeUndefined();
	});
});
