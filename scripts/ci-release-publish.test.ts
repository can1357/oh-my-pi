import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createKeyedMutex,
	legalPayloadFiles,
	npmDistTag,
	type PublishJob,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
	runPublishJobs,
	stageLegalPayloads,
} from "./ci-release-publish";

describe("npm dist-tags", () => {
	it("routes canaries while rejecting other prereleases", () => {
		expect(npmDistTag("0.13.0-canary.2")).toBe("canary");
		expect(npmDistTag("0.13.0")).toBe("latest");
		expect(() => npmDistTag("0.13.0-rc.1")).toThrow("Unsupported prerelease version");
	});
});

describe("concurrent publish runner", () => {
	it("runs every job past a failing sibling, keeps output grouped, and reports failures", async () => {
		const names = ["a", "b", "c", "d", "e"];
		const failing = ["b", "d"];
		const started: Record<string, PromiseWithResolvers<void>> = {};
		const gates: Record<string, PromiseWithResolvers<void>> = {};
		for (const name of names) {
			started[name] = Promise.withResolvers<void>();
			gates[name] = Promise.withResolvers<void>();
		}
		let inFlight = 0;
		let peak = 0;
		const jobs: PublishJob[] = names.map(name => ({
			name,
			async run(log) {
				inFlight++;
				peak = Math.max(peak, inFlight);
				log(`${name} start`);
				started[name].resolve();
				await gates[name].promise;
				log(`${name} end`);
				inFlight--;
				if (failing.includes(name)) throw new Error(`${name} exploded`);
			},
		}));
		const blocks: string[] = [];
		const run = runPublishJobs(jobs, 2, block => blocks.push(block));

		// Finish out of start order so a's lines straddle b's whole lifetime.
		await Promise.all([started.a.promise, started.b.promise]);
		gates.b.resolve();
		await started.c.promise;
		gates.a.resolve();
		await started.d.promise;
		gates.d.resolve();
		await started.e.promise;
		gates.c.resolve();
		gates.e.resolve();

		expect(await run).toEqual(["b", "d"]);
		expect(peak).toBe(2);
		expect(blocks).toEqual([
			"── b ──\nb start\nb end\nFAILED b: b exploded\n",
			"── a ──\na start\na end\n",
			"── d ──\nd start\nd end\nFAILED d: d exploded\n",
			"── c ──\nc start\nc end\n",
			"── e ──\ne start\ne end\n",
		]);
	});

	it("serializes sections sharing a pack lock while unlocked sections run immediately", async () => {
		const lock = createKeyedMutex();
		const events: string[] = [];
		const statsGate = Promise.withResolvers<void>();
		const stats = lock("stats-client", async () => {
			events.push("stats+");
			await statsGate.promise;
			events.push("stats-");
		});
		const codingAgent = lock("stats-client", async () => {
			events.push("coding-agent");
		});
		await lock(undefined, async () => {
			events.push("utils");
		});
		await Promise.resolve();

		expect(events).toContain("stats+");
		expect(events).toContain("utils");
		expect(events).not.toContain("coding-agent");

		statsGate.resolve();
		await Promise.all([stats, codingAgent]);
		expect(events.slice(-2)).toEqual(["stats-", "coding-agent"]);
	});

	it("releases a pack lock after a failing section", async () => {
		const lock = createKeyedMutex();
		await expect(lock("stats-client", () => Promise.reject(new Error("pack failed")))).rejects.toThrow("pack failed");
		expect(await lock("stats-client", async () => "packed")).toBe("packed");
	});
});

describe("published legal payloads", () => {
	it("selects the exact payload for MIT packages", () => {
		expect(legalPayloadFiles("MIT")).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
		expect(() => legalPayloadFiles("MIT OR Apache-2.0")).toThrow("Unsupported package license: MIT OR Apache-2.0");
		expect(() => legalPayloadFiles(undefined)).toThrow("Unsupported package license: <missing>");
	});

	it("stages missing legal files without replacing package-local text", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publish-legal-"));
		const pkgDir = path.join(root, "package");
		await fs.mkdir(pkgDir);
		try {
			await Promise.all([
				Bun.write(path.join(root, "LICENSE"), "root MIT\n"),
				Bun.write(path.join(root, "THIRD-PARTY-NOTICES.txt"), "notices\n"),
				Bun.write(path.join(pkgDir, "LICENSE"), "package MIT\n"),
			]);

			const files = await stageLegalPayloads(pkgDir, "MIT", true, root);
			expect(files).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
			expect(await Bun.file(path.join(pkgDir, "LICENSE")).text()).toBe("package MIT\n");
			expect(await Bun.file(path.join(pkgDir, "THIRD-PARTY-NOTICES.txt")).text()).toBe("notices\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("lists every legal file explicitly in the native core package", async () => {
		const pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-core-"));
		try {
			await Bun.write(
				path.join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-natives",
					version: "15.5.15",
					license: "MIT",
				}),
			);
			const manifest = await prepareNativeCorePackage(pkgDir, false);
			expect(manifest.files).toEqual([
				"native/index.js",
				"native/index.d.ts",
				"native/clipboard.js",
				"native/clipboard.d.ts",
				"native/desktop.js",
				"native/desktop.d.ts",
				"native/desktop-adapter.js",
				"native/desktop-adapter.d.ts",
				"native/version-sentinel.js",
				"native/version-sentinel.d.ts",
				"native/loader-state.js",
				"native/loader-state.d.ts",
				"native/vcs.js",
				"native/vcs.d.ts",
				"native/embedded-addon.js",
				"README.md",
				"LICENSE",
				"THIRD-PARTY-NOTICES.txt",
			]);
		} finally {
			await fs.rm(pkgDir, { recursive: true, force: true });
		}
	});
});

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.txt"]));
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
			"./ar": {
				types: "./dist/types/ar/index.d.ts",
				import: "./src/ar/index.ts",
			},
		});
	});
});
