import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readClientTokens } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("auth-broker client tokens", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-auth-broker-clients-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("reads one token per <name>.token, sorted by name, skipping blank files and other names", async () => {
		const dir = tempDir.join("auth-broker.tokens");
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, "nova.token"), "nova-client-secret\n");
		await fs.writeFile(path.join(dir, "atlas.token"), "  atlas-client-secret  ");
		await fs.writeFile(path.join(dir, "revoked.token"), "\n");
		await fs.writeFile(path.join(dir, "notes.txt"), "not-a-token");

		expect(await readClientTokens(dir)).toEqual([
			{ name: "atlas", token: "atlas-client-secret" },
			{ name: "nova", token: "nova-client-secret" },
		]);
	});

	it("treats a missing directory as no client tokens", async () => {
		expect(await readClientTokens(tempDir.join("absent"))).toEqual([]);
	});
});
