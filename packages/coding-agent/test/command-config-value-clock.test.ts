/**
 * A `!command` credential's expiry under a host clock that moves.
 *
 * `exp` is a wall-clock instant, and the wall clock can be set. Every test here
 * drives both clocks: `letTimePass` moves them together, `stepWall` moves only the
 * wall clock, which is what an NTP correction, a resumed VM snapshot or a hand-set
 * host clock does.
 *
 * The first test is the defect. The rest are the design constraints two earlier
 * attempts failed, each written against the attempt that failed it — they are
 * regression tests against ever keying a credential's lifetime on what a helper
 * printed rather than on the clock.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialSourceError } from "@oh-my-pi/pi-ai/error";
import {
	clearConfigValueCache,
	invalidateCommandConfig,
	resolveCredentialConfigValue,
} from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const HOUR_MS = 60 * 60_000;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** An unsigned JWT whose `exp` claim is `expiresAtMs` (seconds since the epoch on the wire). */
function jwt(subject: string, expiresAtMs: number): string {
	return [
		{ alg: "none", typ: "JWT" },
		{ sub: subject, exp: Math.floor(expiresAtMs / 1000) },
	]
		.map(part => Buffer.from(JSON.stringify(part)).toString("base64url"))
		.concat("c2ln")
		.join(".");
}

describe("command-backed credential expiry under a moving host clock", () => {
	let tempDir = "";
	let tokenFile = "";
	let counterFile = "";
	let config = "";
	let now = 0;
	let mono = 0;

	const runs = () => fs.readFileSync(counterFile, "utf8").length;

	/** Real time passes: both clocks move by `ms`. */
	function letTimePass(ms: number): void {
		now += ms;
		mono += ms;
	}

	/** The host clock is set: the wall clock moves by `ms`, no time passes. */
	function stepWall(ms: number): void {
		now += ms;
	}

	/**
	 * Force the next resolution to run the helper and answer from that run alone, the
	 * way a provider's 401 does. Without it the failure backoff — a duration, and so
	 * immune to the steps these tests make — would answer instead of the helper, and
	 * a last good value from an earlier spelling would stand in for the mint.
	 */
	async function remint(): Promise<string | undefined> {
		invalidateCommandConfig(config, "rejected");
		return await resolveCredentialConfigValue(config).catch(() => undefined);
	}

	beforeEach(() => {
		clearConfigValueCache();
		tempDir = path.join(os.tmpdir(), `pi-test-command-clock-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		tokenFile = path.join(tempDir, "token.txt");
		counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "");
		// Prints the whole first line of the token file, so a test can change the
		// auth scheme or the spacing around the JWT without changing the JWT.
		config = `!IFS= read -r line < ${shellQuote(tokenFile)}; printf 1 >> ${shellQuote(counterFile)}; printf %s "$line"`;
		// Whole seconds, so a JWT `exp` built from it round-trips exactly.
		now = Math.floor(Date.now() / 1000) * 1000;
		mono = performance.now();
		spyOn(Date, "now").mockImplementation(() => now);
		spyOn(performance, "now").mockImplementation(() => mono);
	});

	afterEach(() => {
		mock.restore();
		clearConfigValueCache();
		removeSyncWithRetries(tempDir);
	});

	// The defect. A credential is bounded by a wall-clock instant, and the wall clock
	// is movable: stepping it back before a token's `exp` made the token live again,
	// and a helper that reprints it had it served.
	test("a backward wall-clock step does not give an expired credential a second life", async () => {
		const token = jwt("minted", now + HOUR_MS);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		// An hour and a second really passes. The token is dead.
		letTimePass(HOUR_MS + 1_000);
		await expect(resolveCredentialConfigValue(config)).rejects.toThrow(CredentialSourceError);

		// The host clock is set back two hours. No time passed, so nothing about the
		// token changed, and the helper still prints it.
		stepWall(-2 * HOUR_MS);
		const refusal = await remint().catch((error: unknown) => error);
		expect(refusal).toBeUndefined();
	});

	// Round 2 of #18375. Running the helper again is not evidence that an unchanged
	// credential was newly issued; the first attempt treated it as exactly that, and
	// every re-run handed the same dead JWT a fresh lease.
	test("re-running the helper does not renew an unchanged credential", async () => {
		const token = jwt("minted", now + HOUR_MS);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		letTimePass(HOUR_MS + 1_000);
		stepWall(-2 * HOUR_MS);
		for (let attempt = 0; attempt < 3; attempt++) expect(await remint()).toBeUndefined();
		// Every attempt really ran the helper: this is the mint being refused, not a cache.
		expect(runs()).toBe(4);
	});

	// Round 3 of #18375, and the three the terminal review arm added. The second
	// attempt keyed the deadline on a digest of the whole output, one record per
	// command — so anything that changed those bytes, including the credential's own
	// absence for one run, lost the record and renewed the dead token. None of these
	// four outputs is a new credential.
	test.each([
		["a different credential comes and goes", (token: string) => ["other-token", token]],
		["an opaque value with no expiry intervenes", (token: string) => ["opaque-no-exp", token]],
		["the auth scheme changes case", (token: string) => [`Bearer ${token}`, `bearer ${token}`]],
		["the spacing around the credential changes", (token: string) => [`Bearer ${token}`, `Bearer  ${token}`]],
	])("an expired credential is not revived when %s", async (_name, spellings) => {
		const token = jwt("minted", now + HOUR_MS);
		const [intervening, revived] = spellings(token);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		letTimePass(HOUR_MS + 1_000);
		stepWall(-2 * HOUR_MS);

		// Something else is printed in between. Whatever it is, it is not evidence
		// about the credential that already died.
		fs.writeFileSync(tokenFile, intervening);
		await remint();

		fs.writeFileSync(tokenFile, revived);
		expect(await remint()).toBeUndefined();
	});

	// The repair the second attempt's author considered and the reviewer rejected:
	// retaining the FIRST deadline for each credential refuses a genuinely valid one
	// for as long as the clock was wrong, recoverable only by different bytes or a
	// restart. A correction must not cost a valid credential anything.
	test("a forward clock correction does not refuse a credential that is genuinely valid", async () => {
		// The host clock is half an hour behind the issuer's, so this token's `exp` is
		// half an hour nearer than the host believes.
		const token = jwt("minted", now + HOUR_MS);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		letTimePass(60_000);
		stepWall(30 * 60_000);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		// And a fresh mint under the corrected clock is served, not held against the
		// lifetime the wrong clock gave the previous one.
		const replacement = jwt("replacement", now + HOUR_MS);
		fs.writeFileSync(tokenFile, replacement);
		expect(await remint()).toBe(replacement);
	});

	// What a carried backward step must not become: a process stuck refusing every
	// credential a working helper produces. A step that is undone leaves nothing
	// behind, and a genuinely new token clears a step that is not.
	test("a carried backward step is paid back by the correction that undoes it", async () => {
		const token = jwt("minted", now + HOUR_MS);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		letTimePass(HOUR_MS + 1_000);
		stepWall(-2 * HOUR_MS);
		expect(await remint()).toBeUndefined();

		// The operator puts the clock back where it was. The process owes nothing.
		stepWall(2 * HOUR_MS);
		const replacement = jwt("replacement", now + HOUR_MS);
		fs.writeFileSync(tokenFile, replacement);
		expect(await remint()).toBe(replacement);
	});

	// Clocks disagree by parts per million all the time. Reacting to that would turn
	// a long-lived process into one that refuses credentials ever earlier.
	test("ordinary clock slew never accumulates into a refusal", async () => {
		const token = jwt("minted", now + HOUR_MS);
		fs.writeFileSync(tokenFile, token);
		expect(await resolveCredentialConfigValue(config)).toBe(token);

		// Sixty reads an hour apart, the wall clock losing a second and a half each
		// time — 417 ppm, and more than a minute of drift in total.
		for (let tick = 0; tick < 60; tick++) {
			mono += HOUR_MS;
			now += HOUR_MS - 1_500;
			const fresh = jwt(`tick-${tick}`, now + HOUR_MS);
			fs.writeFileSync(tokenFile, fresh);
			expect(await remint()).toBe(fresh);
		}
	});
});
