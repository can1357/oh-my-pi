import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { devinCliCredentialPaths, readDevinCliCredentials } from "@oh-my-pi/pi-ai/registry/oauth/devin-cli";

let tempDir = "";

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-cli-login-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function credentialsFile(content: string, name = "credentials.toml"): Promise<string> {
	const file = path.join(tempDir, name);
	await Bun.write(file, content);
	return file;
}

describe("readDevinCliCredentials", () => {
	it("skips missing candidates and returns the trimmed key from the first existing file", async () => {
		const file = await credentialsFile(
			'windsurf_api_key = "  sk-ws-01-abc  "\napi_server_url = "https://server.enterprise.windsurf.com"\n',
		);
		expect(await readDevinCliCredentials([path.join(tempDir, "missing.toml"), file])).toBe("sk-ws-01-abc");
	});

	it("names every probed path when no candidate exists", async () => {
		const missing = path.join(tempDir, "missing.toml");
		await expect(readDevinCliCredentials([missing])).rejects.toThrow(`probed: ${missing}`);
	});

	it("surfaces a read failure other than not-found instead of probing on", async () => {
		const valid = await credentialsFile('windsurf_api_key = "sk-ws-01-abc"\n');
		await expect(readDevinCliCredentials([tempDir, valid])).rejects.toThrow(/Cannot read Devin CLI credentials/);
	});

	it("rejects malformed TOML", async () => {
		const file = await credentialsFile("windsurf_api_key = [not, valid");
		await expect(readDevinCliCredentials([file])).rejects.toThrow(/not valid TOML/);
	});

	it.each([
		["absent", 'api_server_url = "https://server.codeium.com"\n'],
		["blank", 'windsurf_api_key = "   "\n'],
	])("rejects a %s windsurf_api_key", async (_case, content) => {
		const file = await credentialsFile(content);
		await expect(readDevinCliCredentials([file])).rejects.toThrow(/no windsurf_api_key/);
	});

	it.each(["https://dev.tenant.example.com", "not a url"])("rejects api_server_url %p", async serverUrl => {
		const file = await credentialsFile(`windsurf_api_key = "sk-ws-01-abc"\napi_server_url = "${serverUrl}"\n`);
		await expect(readDevinCliCredentials([file])).rejects.toThrow(/unsupported API server/);
	});
});

describe("devinCliCredentialPaths", () => {
	it("probes XDG_DATA_HOME, then ~/.local/share, then the macOS Library on Unix", () => {
		expect(devinCliCredentialPaths("/home/dev", { XDG_DATA_HOME: "/xdg" }, "linux")).toEqual([
			"/xdg/devin/credentials.toml",
			"/home/dev/.local/share/devin/credentials.toml",
			"/home/dev/Library/Application Support/devin/credentials.toml",
		]);
	});

	it("probes APPDATA first on Windows and skips the macOS Library", () => {
		expect(
			devinCliCredentialPaths("C:\\Users\\dev", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }, "win32"),
		).toEqual([
			"C:\\Users\\dev\\AppData\\Roaming\\devin\\credentials.toml",
			"C:\\Users\\dev\\.local\\share\\devin\\credentials.toml",
		]);
	});
});
