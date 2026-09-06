import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ESTATE_ROLE_COORDINATION_SCHEMA,
	loadEstateRoleCoordination,
	loadWorkspaceEstateRoleCoordination,
} from "../src/config/estate-role-coordination";

describe("estate-role-coordination", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("loads coordination roles without inventing entries", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-estate-roles-"));
		const filePath = path.join(tmpDir, "estate-roles.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				schema: ESTATE_ROLE_COORDINATION_SCHEMA,
				roles: [
					{
						role: "Device steward",
						thread: "01a073f9-3174-7881-bf97-568938487613",
						cmux: "workspace:15",
					},
				],
			}),
		);

		const registry = loadEstateRoleCoordination(filePath);
		expect(registry?.roles).toHaveLength(1);
		expect(registry?.byRole.get("Device steward")?.thread).toBe("01a073f9-3174-7881-bf97-568938487613");
		expect(registry?.byCmux.get("workspace:15")?.role).toBe("Device steward");
	});

	test("resolveWorkspace loads the first existing file only", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-estate-roles-"));
		fs.writeFileSync(
			path.join(tmpDir, "estate-roles.json"),
			JSON.stringify({
				schema: ESTATE_ROLE_COORDINATION_SCHEMA,
				roles: [{ role: "Transcript durability", thread: "01a073f0-333d-7321-90b8-a2eae14d8a83" }],
			}),
		);

		const registry = loadWorkspaceEstateRoleCoordination(tmpDir);
		expect(registry?.byThread.get("01a073f0-333d-7321-90b8-a2eae14d8a83")?.role).toBe("Transcript durability");
	});
});
