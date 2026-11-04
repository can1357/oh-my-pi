import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { OAUTH_REFRESH_SKEW_MS } from "@oh-my-pi/pi-ai/auth/refresh";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	clearConfigValueCache,
	configureCommandRefreshMs,
	resolveConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgProvidersCommandRefreshSeconds } from "@oh-my-pi/pi-coding-agent/session/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const HOUR_MS = 60 * 60_000;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Prints the current first line of `tokenFile`, appends one byte to `counterFile` per run, exits 1 on `FAIL`. */
function trackedTokenCommand(tokenFile: string, counterFile: string): string {
	if (process.platform !== "win32") {
		return `IFS= read -r token < ${shellQuote(tokenFile)}; printf 1 >> ${shellQuote(counterFile)}; [ "$token" = FAIL ] && exit 1; printf %s "$token"`;
	}
	const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(counterFile)}, "1");const token=fs.readFileSync(${JSON.stringify(tokenFile)}, "utf8").trim();if(token==="FAIL")process.exit(1);process.stdout.write(token);`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** An unsigned JWT whose `exp` claim is `expiresAtMs` (seconds since the epoch on the wire). */
function jwt(subject: string, expiresAtMs: number): string {
	return [
		{ alg: "RS256", typ: "JWT" },
		{ sub: subject, exp: Math.floor(expiresAtMs / 1000) },
	]
		.map(part => Buffer.from(JSON.stringify(part)).toString("base64url"))
		.concat("c2ln")
		.join(".");
}

describe("command-backed config value lifetime", () => {
	let tempDir = "";
	let tokenFile = "";
	let counterFile = "";
	let config = "";
	let now = 0;

	const runs = () => fs.readFileSync(counterFile, "utf8").length;

	beforeEach(() => {
		clearConfigValueCache();
		tempDir = path.join(os.tmpdir(), `pi-test-command-lifetime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		tokenFile = path.join(tempDir, "token.txt");
		counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		config = `!${trackedTokenCommand(tokenFile, counterFile)}`;
		// Whole seconds, so a JWT `exp` built from it round-trips exactly.
		now = Math.floor(Date.now() / 1000) * 1000;
		spyOn(Date, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		mock.restore();
		configureCommandRefreshMs(0);
		clearConfigValueCache();
		removeSyncWithRetries(tempDir);
	});

	test("a JWT is re-minted inside the OAuth refresh skew before its exp, not after a 401", async () => {
		const expiresAt = now + HOUR_MS;
		const first = jwt("first", expiresAt);
		const second = jwt("second", now + 2 * HOUR_MS);
		fs.writeFileSync(tokenFile, first);
		expect(await resolveConfigValue(config)).toBe(first);

		fs.writeFileSync(tokenFile, second);
		// Outside the skew the cached token is served without a process per request.
		now = expiresAt - OAUTH_REFRESH_SKEW_MS - 1_000;
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(1);

		// Inside the skew the command runs again while the old token is still valid.
		now = expiresAt - OAUTH_REFRESH_SKEW_MS + 1_000;
		expect(await resolveConfigValue(config)).toBe(second);
		expect(runs()).toBe(2);
	});

	test("concurrent resolves of a value due for refresh share one command run", async () => {
		const expiresAt = now + HOUR_MS;
		fs.writeFileSync(tokenFile, jwt("first", expiresAt));
		await resolveConfigValue(config);
		const second = jwt("second", now + 2 * HOUR_MS);
		fs.writeFileSync(tokenFile, second);
		now = expiresAt - 1_000;

		const values = await Promise.all(Array.from({ length: 8 }, () => resolveConfigValue(config)));

		expect(values).toEqual(Array.from({ length: 8 }, () => second));
		expect(runs()).toBe(2);
	});

	test("a failed refresh keeps serving the previous JWT until its exp, then drops it", async () => {
		const expiresAt = now + HOUR_MS;
		const first = jwt("first", expiresAt);
		fs.writeFileSync(tokenFile, first);
		await resolveConfigValue(config);

		fs.writeFileSync(tokenFile, "FAIL");
		now = expiresAt - 10_000;
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(2);
		// The failure backoff holds: no process per request while the old token serves.
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(2);

		// Past exp the token is never served, even though the refresh still fails.
		now = expiresAt + 30_000;
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(runs()).toBe(3);
	});

	test("a value without an expiry is kept until invalidated unless providers.commandRefreshSeconds is set", async () => {
		fs.writeFileSync(tokenFile, "opaque-1");
		expect(await resolveConfigValue(config)).toBe("opaque-1");
		fs.writeFileSync(tokenFile, "opaque-2");
		now += 30 * 24 * HOUR_MS;
		expect(await resolveConfigValue(config)).toBe("opaque-1");
		expect(runs()).toBe(1);

		const release = bindEffects(Settings.isolated({ [cfgProvidersCommandRefreshSeconds.id]: 300 }));
		try {
			// The lifetime counts from the last successful run, so the 30-day-old value is due now.
			expect(await resolveConfigValue(config)).toBe("opaque-2");
			fs.writeFileSync(tokenFile, "opaque-3");
			now += 299_000;
			expect(await resolveConfigValue(config)).toBe("opaque-2");
			now += 2_000;
			expect(await resolveConfigValue(config)).toBe("opaque-3");
			expect(runs()).toBe(3);

			// Without an expiry, a failed refresh keeps the last value: only a 401 proves it stale.
			fs.writeFileSync(tokenFile, "FAIL");
			now += 301_000;
			expect(await resolveConfigValue(config)).toBe("opaque-3");
			expect(runs()).toBe(4);
		} finally {
			release();
		}
	});

	test("a provider 401 still re-runs a JWT command before its refresh point", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const modelsPath = path.join(tempDir, "models.json");
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"custom-proxy": {
							baseUrl: "https://custom-proxy.example.com/v1",
							api: "openai-completions",
							apiKey: config,
							authHeader: true,
							models: [{ id: "custom-model", name: "Custom Model" }],
						},
					},
				}),
			);
			const rejected = jwt("revoked", now + HOUR_MS);
			const accepted = jwt("accepted", now + HOUR_MS);
			fs.writeFileSync(tokenFile, rejected);
			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			expect(await registry.getApiKey(model)).toBe(rejected);
			fs.writeFileSync(tokenFile, accepted);

			const attempted: string[] = [];
			const result = await withAuth(registry.resolver(model), async key => {
				attempted.push(key);
				if (key === rejected) throw Object.assign(new Error("401 authentication_error"), { status: 401 });
				return "ok";
			});

			expect(result).toBe("ok");
			expect(attempted).toEqual([rejected, accepted]);
			expect(runs()).toBe(2);
			expect((await registry.resolveModelHeaders(model))?.Authorization).toBe(`Bearer ${accepted}`);
		} finally {
			authStorage.close();
		}
	});
});
