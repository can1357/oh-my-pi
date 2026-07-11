import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getConfigDirName,
	getDocumentConversionCacheDir,
	getProfileRootDir,
	setAgentDir,
} from "@pk-nerdsaver-ai/pi-utils/dirs";
import { Snowflake } from "@pk-nerdsaver-ai/pi-utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("document conversion cache directory", () => {
	let tempRoot = "";
	let originalPiCodingAgentDir: string | undefined;
	let originalOmpProfile: string | undefined;
	let originalPiProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfile = process.env.OMP_PROFILE;
		originalPiProfile = process.env.PI_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-document-cache", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME for the default agent dir when $XDG_CACHE_HOME/omp exists", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "omp"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(
			path.join(process.env.XDG_CACHE_HOME, "omp", "cache", "document-conversions"),
		);
	});

	it("stays under a custom PI_CODING_AGENT_DIR", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(path.join(customAgentDir, "cache", "document-conversions"));
	});
});

describe("test directory state cleanup", () => {
	it("restores the active profile from the current env after setAgentDir mutations", () => {
		const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalOmpProfile = process.env.OMP_PROFILE;
		const originalPiProfile = process.env.PI_PROFILE;
		const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		try {
			process.env.OMP_PROFILE = "cache-profile";
			delete process.env.PI_PROFILE;
			delete process.env.PI_CODING_AGENT_DIR;
			delete process.env.XDG_CACHE_HOME;
			__resetDirsFromEnvForTests();

			setAgentDir(path.join(os.tmpdir(), "pi-utils-document-cache", Snowflake.next(), "agent"));
			expect(getActiveProfile()).toBeUndefined();

			process.env.OMP_PROFILE = "cache-profile";
			delete process.env.PI_PROFILE;
			delete process.env.PI_CODING_AGENT_DIR;
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("cache-profile");
			expect(getDocumentConversionCacheDir()).toBe(
				path.join(getProfileRootDir("cache-profile"), "agent", "cache", "document-conversions"),
			);
		} finally {
			restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
			restoreEnv("OMP_PROFILE", originalOmpProfile);
			restoreEnv("PI_PROFILE", originalPiProfile);
			restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
			__resetDirsFromEnvForTests();
		}
	});
});
