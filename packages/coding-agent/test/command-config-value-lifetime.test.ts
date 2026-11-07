import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { CredentialSourceError } from "@oh-my-pi/pi-ai/error";
import { OAUTH_REFRESH_SKEW_MS } from "@oh-my-pi/pi-ai/auth/refresh";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	clearConfigValueCache,
	configureCommandRefreshMs,
	resolveConfigValue,
	resolveCredentialConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgProvidersCommandRefreshSeconds } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ptree, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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

/** An unsigned JWT whose `exp` claim is exactly `exp`, including zero and negative values. */
function jwtWithExp(subject: string, exp: number): string {
	return [
		{ alg: "RS256", typ: "JWT" },
		{ sub: subject, exp },
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
	let mono = 0;

	const runs = () => fs.readFileSync(counterFile, "utf8").length;

	/**
	 * Let time pass: the wall clock moves to `next` and the monotonic clock moves
	 * with it. Used wherever a test means "an hour went by".
	 */
	function setWall(next: number): void {
		mono += Math.max(next - now, 0);
		now = next;
	}

	/**
	 * Step the wall clock without any time passing — an NTP correction, a VM
	 * resuming from a snapshot, a hand-set host clock. `performance.now()` does not
	 * move, which is what tells a step from an hour.
	 */
	function stepWall(next: number): void {
		now = next;
	}

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
		mono = performance.now();
		spyOn(Date, "now").mockImplementation(() => now);
		spyOn(performance, "now").mockImplementation(() => mono);
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
		setWall(expiresAt - OAUTH_REFRESH_SKEW_MS - 1_000);
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(1);

		// Inside the skew the command runs again while the old token is still valid.
		setWall(expiresAt - OAUTH_REFRESH_SKEW_MS + 1_000);
		expect(await resolveConfigValue(config)).toBe(second);
		expect(runs()).toBe(2);
	});

	test("concurrent resolves of a value due for refresh share one command run", async () => {
		const expiresAt = now + HOUR_MS;
		fs.writeFileSync(tokenFile, jwt("first", expiresAt));
		await resolveConfigValue(config);
		const second = jwt("second", now + 2 * HOUR_MS);
		fs.writeFileSync(tokenFile, second);
		setWall(expiresAt - 1_000);

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
		setWall(expiresAt - 10_000);
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(2);
		// The failure backoff holds: no process per request while the old token serves.
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(2);

		// Past exp the token is never served, even though the refresh still fails.
		setWall(expiresAt + 30_000);
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(runs()).toBe(3);
	});

	test("a value without an expiry is kept until invalidated unless providers.commandRefreshSeconds is set", async () => {
		fs.writeFileSync(tokenFile, "opaque-1");
		expect(await resolveConfigValue(config)).toBe("opaque-1");
		fs.writeFileSync(tokenFile, "opaque-2");
		setWall(now + 30 * 24 * HOUR_MS);
		expect(await resolveConfigValue(config)).toBe("opaque-1");
		expect(runs()).toBe(1);

		const release = bindEffects(Settings.isolated({ [cfgProvidersCommandRefreshSeconds.id]: 300 }));
		try {
			// The lifetime counts from the last successful run, so the 30-day-old value is due now.
			expect(await resolveConfigValue(config)).toBe("opaque-2");
			fs.writeFileSync(tokenFile, "opaque-3");
			setWall(now + 299_000);
			expect(await resolveConfigValue(config)).toBe("opaque-2");
			setWall(now + 2_000);
			expect(await resolveConfigValue(config)).toBe("opaque-3");
			expect(runs()).toBe(3);

			// Without an expiry, a failed refresh keeps the last value: only a 401 proves it stale.
			fs.writeFileSync(tokenFile, "FAIL");
			setWall(now + 301_000);
			expect(await resolveConfigValue(config)).toBe("opaque-3");
			expect(runs()).toBe(4);
		} finally {
			release();
		}
	});

	// The three halves of this change meet here, and only here: a command value has a
	// lifetime (JWT `exp`), a failed re-run keeps serving the last good value, and a
	// credential that resolves to nothing fails by name. Serving an expired token
	// through the last-good path would hand the provider a credential it has already
	// stopped accepting — the 401 this whole change exists to stop — and reporting it
	// as "no API key" would hide the broken re-mint behind a missing credential.
	test("an expired JWT is never served through the last good value, and the refusal names the command", async () => {
		const expiresAt = now + HOUR_MS;
		const token = jwt("minted", expiresAt);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		// Re-mint fails inside the skew: the token is still valid, so it keeps serving.
		fs.writeFileSync(tokenFile, "FAIL");
		setWall(expiresAt - 10_000);
		expect(await resolveCredentialConfigValue(config)).toBe(token);
		expect(runs()).toBe(2);

		// Past `exp`, inside the same failure backoff: the last good value is not a way
		// to send an expired credential, and the caller is told which source failed.
		setWall(expiresAt + 1_000);
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(CredentialSourceError);
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(/exited with status 1/);
		expect(runs()).toBe(2);
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

	// The boundary nothing probed: 180 tests stayed green while `now < expiresAt`
	// was weakened to `now <= expiresAt`. A JWT is dead AT `exp`, not after it.
	test("a JWT is not served at exactly its exp", async () => {
		const expiresAt = now + HOUR_MS;
		const token = jwt("minted", expiresAt);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		fs.writeFileSync(tokenFile, "FAIL");
		setWall(expiresAt);
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(/exited with status 1/);
	});

	// The other untested guard: serving a cached value instead of running the
	// command again. Without it every request mints, and a command that has since
	// started failing takes the credential down with it.
	test("a cached value inside its lifetime is served without running the command again", async () => {
		const expiresAt = now + HOUR_MS;
		const first = jwt("first", expiresAt);
		fs.writeFileSync(tokenFile, first);
		expect(await resolveConfigValue(config)).toBe(first);

		// A different, still valid token, and a clock well short of the refresh point.
		fs.writeFileSync(tokenFile, jwt("second", now + 2 * HOUR_MS));
		setWall(now + 60_000);
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(1);

		// And the cache, not the last-good path, is what served it: a failing command
		// changes nothing while the cached token is still inside its lifetime.
		fs.writeFileSync(tokenFile, "FAIL");
		expect(await resolveConfigValue(config)).toBe(first);
		expect(runs()).toBe(1);
	});

	// A fresh run was the one path that never passed the expiry check: it returned
	// its own stdout straight to the caller and cached it as the last good value.
	test("a command that prints an already expired JWT fails by name instead of serving it", async () => {
		const expired = jwt("stale", now - 1_000);
		fs.writeFileSync(tokenFile, expired);

		const refusal = await resolveCredentialConfigValue(config).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(CredentialSourceError);
		expect((refusal as Error).message).toContain("printed a credential that had already expired");
		expect((refusal as Error).message).not.toContain(expired);
		// Nor is it kept: the plain resolver gets nothing, not the dead token. And the
		// mint check is what holds the backoff — without it the dead token is stored as
		// the last good value and the failure record is cleared, so the next resolution
		// runs the mint command again, once per request.
		expect(runs()).toBe(1);
		expect(await resolveConfigValue(config)).toBeUndefined();
		expect(runs()).toBe(1);
	});

	test.each([0, -1])("a numeric exp of %s is an expiry, not an opaque value", async exp => {
		fs.writeFileSync(tokenFile, jwtWithExp("stale", exp));
		// Read as "no discoverable expiry", such a token was served and then kept for
		// the whole process under the default reuse.
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(
			/printed a credential that had already expired/,
		);
		expect(await resolveConfigValue(config)).toBeUndefined();
	});

	test("a wall clock moved back does not revive a token already observed expired", async () => {
		const expiresAt = now + HOUR_MS;
		const token = jwt("minted", expiresAt);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		fs.writeFileSync(tokenFile, "FAIL");
		setWall(expiresAt);
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(CredentialSourceError);

		// The clock goes backwards — NTP stepping, a VM resuming from a snapshot, a
		// hand-set host clock. A credential seen dead stays dead.
		stepWall(expiresAt - 1_000);
		const refusal = await resolveCredentialConfigValue(config).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(CredentialSourceError);
		expect((refusal as Error).message).not.toContain(token);
	});

	// Round 3, second arm. Expiry was discarded at entry and in the successful-run
	// continuation, and the failure-path continuation read the last good value
	// without one: a refresh that failed as the clock crossed `exp` saw the token
	// dead, left it in the map, and served it again after the clock stepped back.
	test("a refresh that fails as the clock crosses exp retires the last good value", async () => {
		const expiresAt = now + HOUR_MS;
		const token = jwt("minted", expiresAt);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		// The host clock jumps to ten seconds before `exp`: the refresh is due and the
		// token still serves. No time has actually passed.
		stepWall(expiresAt - 10_000);
		fs.writeFileSync(tokenFile, "FAIL");
		const realExec = ptree.exec;
		const exec = spyOn(ptree, "exec").mockImplementation(async (...args: Parameters<typeof ptree.exec>) => {
			const result = await realExec(...args);
			// The clock reaches `exp` while the failing refresh is in flight, so the
			// failure path is the one that observes the expiry.
			stepWall(expiresAt);
			return result;
		});
		try {
			await expect(resolveCredentialConfigValue(config)).rejects.toThrow(CredentialSourceError);
		} finally {
			exec.mockRestore();
		}

		stepWall(expiresAt - 1_000);
		const refusal = await resolveCredentialConfigValue(config).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(CredentialSourceError);
		expect((refusal as Error).message).not.toContain(token);
	});

	// The window the author disclosed as untestable: a result servable when its run
	// finished and past its `exp` by the time a waiter resumes. The only wall-clock
	// read between the two is the mint's own, so once the run has finished the clock
	// is made to advance two seconds per read — the mint reads T, the waiter reads
	// T + 2 s, and the one-second token dies between them.
	test("a value that expires while the waiter is resuming is not served", async () => {
		const token = jwt("short", now + 1_000);
		fs.writeFileSync(tokenFile, token);
		const realExec = ptree.exec;
		let runFinished = false;
		const exec = spyOn(ptree, "exec").mockImplementation(async (...args: Parameters<typeof ptree.exec>) => {
			const result = await realExec(...args);
			runFinished = true;
			return result;
		});
		spyOn(Date, "now").mockImplementation(() => {
			const read = now;
			if (runFinished) now += 2_000;
			return read;
		});
		try {
			const refusal = await resolveCredentialConfigValue(config).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(CredentialSourceError);
			expect((refusal as Error).message).toContain("printed a credential that had already expired");
			expect((refusal as Error).message).not.toContain(token);
		} finally {
			exec.mockRestore();
		}
		// The mint itself was fine: the run happened and its check passed.
		expect(runs()).toBe(1);
	});
});
