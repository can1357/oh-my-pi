import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type BinjaHost, binjaPythonDir, locateBinjaInstall } from "@oh-my-pi/pi-coding-agent/binja/install";
import { TempDir } from "@oh-my-pi/pi-utils";

const CORE_LIBRARY: Partial<Record<NodeJS.Platform, string>> = {
	linux: "libbinaryninjacore.so.1",
	darwin: "libbinaryninjacore.dylib",
	win32: "binaryninjacore.dll",
};

describe("locateBinjaInstall", () => {
	let root: TempDir;
	let serial = 0;

	beforeAll(() => {
		root = TempDir.createSync("@pi-binja-install-");
	});

	afterAll(() => {
		root.removeSync();
	});

	/** A fresh empty directory, so every case sees only what it created. */
	function scratch(): string {
		const dir = root.join(`case-${serial++}`);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	/** Drops `platform`'s core library into `dir` and returns `dir`. */
	function install(dir: string, platform: NodeJS.Platform): string {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, CORE_LIBRARY[platform] ?? ""), "");
		return dir;
	}

	function writeLastRun(userDir: string, installDir: string): void {
		fs.mkdirSync(userDir, { recursive: true });
		fs.writeFileSync(path.join(userDir, "lastrun"), `${installDir}\n`);
	}

	function host(platform: NodeJS.Platform, home: string, env: BinjaHost["env"] = {}): BinjaHost {
		return { platform, env, home };
	}

	it("returns undefined when nothing is installed", () => {
		expect(locateBinjaInstall(undefined, host("linux", scratch()))).toBeUndefined();
	});

	it("prefers the configured directory over every other source", () => {
		const dir = scratch();
		const configured = install(path.join(dir, "configured"), "linux");
		const fromEnv = install(path.join(dir, "env"), "linux");
		const home = path.join(dir, "home");
		writeLastRun(path.join(home, ".binaryninja"), install(path.join(dir, "lastrun"), "linux"));
		install(path.join(home, "binaryninja"), "linux");

		expect(locateBinjaInstall(configured, host("linux", home, { BN_INSTALL_DIR: fromEnv }))).toBe(configured);
	});

	it("treats a configured directory without a core library as final", () => {
		const dir = scratch();
		const empty = path.join(dir, "empty");
		fs.mkdirSync(empty);
		const fromEnv = install(path.join(dir, "env"), "linux");
		const home = path.join(dir, "home");
		writeLastRun(path.join(home, ".binaryninja"), install(path.join(dir, "lastrun"), "linux"));
		install(path.join(home, "binaryninja"), "linux");

		expect(locateBinjaInstall(empty, host("linux", home, { BN_INSTALL_DIR: fromEnv }))).toBeUndefined();
	});

	it("uses $BN_INSTALL_DIR ahead of lastrun and the default location", () => {
		const dir = scratch();
		const fromEnv = install(path.join(dir, "env"), "linux");
		const home = path.join(dir, "home");
		writeLastRun(path.join(home, ".binaryninja"), install(path.join(dir, "lastrun"), "linux"));
		install(path.join(home, "binaryninja"), "linux");

		expect(locateBinjaInstall(undefined, host("linux", home, { BN_INSTALL_DIR: fromEnv }))).toBe(fromEnv);
	});

	it("falls through a $BN_INSTALL_DIR that holds no core library", () => {
		const dir = scratch();
		const home = path.join(dir, "home");
		const recorded = install(path.join(dir, "lastrun"), "linux");
		writeLastRun(path.join(home, ".binaryninja"), recorded);

		expect(locateBinjaInstall(undefined, host("linux", home, { BN_INSTALL_DIR: path.join(dir, "missing") }))).toBe(
			recorded,
		);
	});

	it("uses the lastrun file ahead of the default location", () => {
		const dir = scratch();
		const home = path.join(dir, "home");
		const recorded = install(path.join(dir, "lastrun"), "linux");
		writeLastRun(path.join(home, ".binaryninja"), recorded);
		install(path.join(home, "binaryninja"), "linux");

		expect(locateBinjaInstall(undefined, host("linux", home))).toBe(recorded);
	});

	it("reads lastrun from $BN_USER_DIRECTORY instead of the default user folder", () => {
		const dir = scratch();
		const home = path.join(dir, "home");
		writeLastRun(path.join(home, ".binaryninja"), install(path.join(dir, "default-user"), "linux"));
		const relocated = install(path.join(dir, "relocated"), "linux");
		const userDir = path.join(dir, "user");
		writeLastRun(userDir, relocated);

		expect(locateBinjaInstall(undefined, host("linux", home, { BN_USER_DIRECTORY: userDir }))).toBe(relocated);
	});

	it("reads lastrun from the per-platform user folder", () => {
		const dir = scratch();
		const macHome = path.join(dir, "mac");
		const macInstall = install(path.join(dir, "Binary Ninja.app", "Contents", "MacOS"), "darwin");
		writeLastRun(path.join(macHome, "Library", "Application Support", "Binary Ninja"), macInstall);
		expect(locateBinjaInstall(undefined, host("darwin", macHome))).toBe(macInstall);

		const appData = path.join(dir, "roaming");
		const winInstall = install(path.join(dir, "win"), "win32");
		writeLastRun(path.join(appData, "Binary Ninja"), winInstall);
		expect(locateBinjaInstall(undefined, host("win32", path.join(dir, "winhome"), { APPDATA: appData }))).toBe(
			winInstall,
		);
	});

	it("falls back to ~/binaryninja on Linux", () => {
		const home = scratch();
		const fallback = install(path.join(home, "binaryninja"), "linux");

		expect(locateBinjaInstall(undefined, host("linux", home))).toBe(fallback);
	});

	it("tries the Windows default locations in the documented order", () => {
		const dir = scratch();
		const env = {
			ProgramFiles: path.join(dir, "pf"),
			LOCALAPPDATA: path.join(dir, "local"),
			APPDATA: path.join(dir, "roaming"),
		};
		const winHost = host("win32", path.join(dir, "home"), env);

		const perUserPrograms = install(path.join(env.LOCALAPPDATA, "Programs", "Vector35", "BinaryNinja"), "win32");
		expect(locateBinjaInstall(undefined, winHost)).toBe(perUserPrograms);
		const perUser = install(path.join(env.LOCALAPPDATA, "Vector35", "BinaryNinja"), "win32");
		expect(locateBinjaInstall(undefined, winHost)).toBe(perUser);
		const global = install(path.join(env.ProgramFiles, "Vector35", "BinaryNinja"), "win32");
		expect(locateBinjaInstall(undefined, winHost)).toBe(global);
	});

	it("resolves a macOS .app bundle to the directory holding the core library", () => {
		const dir = scratch();
		const bundle = path.join(dir, "Binary Ninja.app");
		const coreDir = install(path.join(bundle, "Contents", "MacOS"), "darwin");
		const home = path.join(dir, "home");

		expect(locateBinjaInstall(bundle, host("darwin", home))).toBe(coreDir);
		expect(locateBinjaInstall(undefined, host("darwin", home, { BN_INSTALL_DIR: bundle }))).toBe(coreDir);
		expect(locateBinjaInstall(coreDir, host("darwin", home))).toBe(coreDir);
	});

	it("does not unwrap an .app bundle on other platforms", () => {
		const dir = scratch();
		const bundle = path.join(dir, "Binary Ninja.app");
		install(path.join(bundle, "Contents", "MacOS"), "linux");

		expect(locateBinjaInstall(bundle, host("linux", path.join(dir, "home")))).toBeUndefined();
	});

	it("looks for the core library the host platform loads", () => {
		const dir = scratch();
		const linuxInstall = install(path.join(dir, "linux"), "linux");

		expect(locateBinjaInstall(linuxInstall, host("win32", path.join(dir, "home")))).toBeUndefined();
		expect(locateBinjaInstall(linuxInstall, host("darwin", path.join(dir, "home")))).toBeUndefined();
	});
});

describe("binjaPythonDir", () => {
	it("is the python directory beside the core library on Linux and Windows", () => {
		const installDir = path.join("opt", "binaryninja");
		expect(binjaPythonDir(installDir, "linux")).toBe(path.join(installDir, "python"));
		expect(binjaPythonDir(installDir, "win32")).toBe(path.join(installDir, "python"));
	});

	it("is Contents/Resources/python inside the bundle on macOS", () => {
		const contents = path.join("Applications", "Binary Ninja.app", "Contents");
		expect(binjaPythonDir(path.join(contents, "MacOS"), "darwin")).toBe(path.join(contents, "Resources", "python"));
	});
});
