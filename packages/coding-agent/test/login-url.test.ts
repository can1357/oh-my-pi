import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { persistLoginUrl } from "@oh-my-pi/pi-coding-agent/utils/login-url";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const path = join(getAgentDir(), "login-url.txt");

afterEach(() => {
	rmSync(path, { force: true });
});

describe("persistLoginUrl", () => {
	it("writes the URL byte-exact to a one-row path, mode 600", () => {
		const url = `https://auth.example.com/oauth/authorize?code_challenge=${"B".repeat(43)}&state=${"s".repeat(64)}`;
		const returned = persistLoginUrl(url);
		expect(returned).toBe(path);
		// Byte-exact: the whole point is that no terminal artifact touches it.
		expect(readFileSync(path, "utf8")).toBe(`${url}\n`);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("overwrites the previous login's URL", () => {
		persistLoginUrl("https://first.example/a");
		persistLoginUrl("https://second.example/b");
		expect(readFileSync(path, "utf8")).toBe("https://second.example/b\n");
	});
});
