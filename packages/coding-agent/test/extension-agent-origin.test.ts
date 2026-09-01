import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { resolveAgentDefinitionIdentity } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("extension package agent origin", () => {
	let tempHome: string;
	let originalAgentDir: string;

	afterEach(async () => {
		clearOmpExtensionCliRoots();
		clearFsCache();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	test("exposes the current package origin matching its authoritative selected agent", async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-agent-origin-"));
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const projectDir = path.join(tempHome, "project");
		const packageRoot = path.join(tempHome, "extension-package");
		const extensionPath = path.join(packageRoot, "dist", "extension.ts");
		await fs.mkdir(path.dirname(extensionPath), { recursive: true });
		await fs.mkdir(path.join(packageRoot, "agents"), { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: "identity-extension", version: "1.0.0", omp: { extensions: ["./dist/extension.ts"] } }),
		);
		await fs.writeFile(
			extensionPath,
			"export default function extension(api) { api.setLabel(JSON.stringify(api.extensionOrigin)); }\n",
		);
		await fs.writeFile(
			path.join(packageRoot, "agents", "identity-extension-agent.md"),
			["---", "name: identity-extension-agent", "description: identity test", "---", "body"].join("\n"),
		);
		injectOmpExtensionCliRoots([packageRoot], tempHome, projectDir, { mode: "explicit-only" });

		const loaded = await loadExtensions([extensionPath], projectDir, new EventBus());
		expect(loaded.errors).toEqual([]);
		const currentOrigin = JSON.parse(loaded.extensions[0]?.label ?? "null") as unknown;
		const selected = await resolveAgentDefinitionIdentity(projectDir, "identity-extension-agent", tempHome);

		expect(currentOrigin).toEqual({
			schemaVersion: 1,
			originKind: "extension",
			originId: selected?.originId,
		});
		expect(selected?.originKind).toBe("extension");
	});

	test("does not assign package origin to an entry its ancestor manifest did not declare", async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-origin-negative-"));
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const packageRoot = path.join(tempHome, "extension-package");
		const declaredPath = path.join(packageRoot, "dist", "declared.ts");
		const loosePath = path.join(packageRoot, "dist", "loose.ts");
		await fs.mkdir(path.dirname(loosePath), { recursive: true });
		await fs.writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: "origin-negative", version: "1.0.0", omp: { extensions: ["./dist/declared.ts"] } }),
		);
		await Promise.all([
			fs.writeFile(declaredPath, "export default function declared() {}\n"),
			fs.writeFile(loosePath, "export default function loose(api) { api.setLabel(String(api.extensionOrigin)); }\n"),
		]);

		const loaded = await loadExtensions([loosePath], packageRoot, new EventBus());

		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions[0]?.origin).toBeUndefined();
		expect(loaded.extensions[0]?.label).toBe("undefined");
	});

	test("matches a manifest declaration and loaded entry through canonical directory aliases", async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-origin-alias-"));
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const packageRoot = path.join(tempHome, "extension-package");
		const realDist = path.join(packageRoot, "real-dist");
		const manifestDist = path.join(packageRoot, "manifest-dist");
		const realEntry = path.join(realDist, "extension.ts");
		await fs.mkdir(realDist, { recursive: true });
		await fs.symlink(realDist, manifestDist, process.platform === "win32" ? "junction" : "dir");
		await fs.writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "origin-alias",
				version: "1.0.0",
				omp: { extensions: ["./manifest-dist/extension.ts"] },
			}),
		);
		await fs.writeFile(
			realEntry,
			"export default function extension(api) { api.setLabel(api.extensionOrigin.originId); }\n",
		);

		const loaded = await loadExtensions([realEntry], packageRoot, new EventBus());

		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions[0]?.origin).toMatchObject({ schemaVersion: 1, originKind: "extension" });
		expect(loaded.extensions[0]?.label).toBe(loaded.extensions[0]?.origin?.originId);
	});

	test("resolves the selected definition from the supplied effective extension-root snapshot", async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-effective-agent-origin-"));
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const projectDir = path.join(tempHome, "project");
		const packageRoot = path.join(tempHome, "explicit-extension");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(path.join(packageRoot, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(packageRoot, "agents", "scoped-agent.md"),
			["---", "name: scoped-agent", "description: scoped identity", "---", "body"].join("\n"),
		);
		const extensionRoots: EffectiveExtensionRoots = {
			explicit: [packageRoot],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};

		const selected = await resolveAgentDefinitionIdentity(projectDir, "scoped-agent", tempHome, extensionRoots);

		expect(selected).toMatchObject({ schemaVersion: 1, originKind: "extension" });
		expect(selected?.definitionId).toStartWith("sha256:");
	});

	test("keeps manifest origin when a prepared extension is rebound after package metadata changes", async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepared-agent-origin-"));
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		const packageRoot = path.join(tempHome, "extension-package");
		const parentDir = path.join(tempHome, "parent");
		const childDir = path.join(tempHome, "child");
		const extensionPath = path.join(packageRoot, "dist", "extension.ts");
		const manifestPath = path.join(packageRoot, "package.json");
		await Promise.all([
			fs.mkdir(path.dirname(extensionPath), { recursive: true }),
			fs.mkdir(parentDir, { recursive: true }),
			fs.mkdir(childDir, { recursive: true }),
		]);
		await fs.writeFile(
			manifestPath,
			JSON.stringify({ name: "prepared-origin", version: "1.0.0", omp: { extensions: ["./dist/extension.ts"] } }),
		);
		await fs.writeFile(
			extensionPath,
			"export default function extension(api) { api.setLabel(JSON.stringify(api.extensionOrigin)); }\n",
		);

		const parent = await loadExtensions([extensionPath], parentDir, new EventBus());
		const parentOrigin = parent.extensions[0]?.origin;
		expect(parentOrigin).toMatchObject({ schemaVersion: 1, originKind: "extension" });
		expect(parent.preparedExtensions).toHaveLength(1);

		await fs.rm(manifestPath);
		const child = await bindPreparedExtensions(parent.preparedExtensions ?? [], childDir, new EventBus());

		expect(child.errors).toEqual([]);
		expect(child.extensions[0]?.origin).toEqual(parentOrigin);
		expect(JSON.parse(child.extensions[0]?.label ?? "null")).toEqual(parentOrigin);
	});
});
