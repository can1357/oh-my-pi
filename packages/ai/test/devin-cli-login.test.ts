import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { readDevinCliCredentials } from "@oh-my-pi/pi-ai/registry/oauth/devin-cli";

let tempDir = "";

afterEach(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

async function writeCredentialsFile(content: string): Promise<string> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-cli-login-"));
	const filePath = path.join(tempDir, "credentials.toml");
	await fs.writeFile(filePath, content);
	return filePath;
}

describe("readDevinCliCredentials", () => {
	it("returns the raw key from a well-formed credential file", async () => {
		const filePath = await writeCredentialsFile(
			'windsurf_api_key = "sk-ws-01-abc123"\napi_server_url = "https://server.enterprise.windsurf.com"\n',
		);
		expect(readDevinCliCredentials(filePath)).toBe("sk-ws-01-abc123");
	});

	it("trims whitespace around the key", async () => {
		const filePath = await writeCredentialsFile('windsurf_api_key = "  sk-ws-01-padded  "\n');
		expect(readDevinCliCredentials(filePath)).toBe("sk-ws-01-padded");
	});

	it("fails with an actionable error when the file is missing", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-cli-login-"));
		const missing = path.join(tempDir, "credentials.toml");
		expect(() => readDevinCliCredentials(missing)).toThrow(/No Devin CLI credentials found.*devin auth login/s);
	});

	it("reports malformed TOML instead of crashing the parser", async () => {
		const filePath = await writeCredentialsFile("windsurf_api_key = [not, valid");
		expect(() => readDevinCliCredentials(filePath)).toThrow(/not valid TOML/);
	});

	it("fails when windsurf_api_key is absent from an otherwise valid file", async () => {
		const filePath = await writeCredentialsFile('api_server_url = "https://server.enterprise.windsurf.com"\n');
		expect(() => readDevinCliCredentials(filePath)).toThrow(/carry no windsurf_api_key/);
	});

	it("treats an empty windsurf_api_key like an absent one", async () => {
		const filePath = await writeCredentialsFile('windsurf_api_key = ""\n');
		expect(() => readDevinCliCredentials(filePath)).toThrow(/carry no windsurf_api_key/);
	});

	it("ignores unrelated keys in the file", async () => {
		const filePath = await writeCredentialsFile(
			'api_server_url = "https://server.enterprise.windsurf.com"\nwindsurf_api_key = "sk-ws-01-only-key"\nother_setting = "ignored"\n',
		);
		expect(readDevinCliCredentials(filePath)).toBe("sk-ws-01-only-key");
	});
});
