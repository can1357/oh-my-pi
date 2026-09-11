import { describe, expect, it } from "bun:test";
import { createDevinFingerprint } from "../src/wire/devin-fingerprint";

/** Envelope key: SHA-256 of the native CLI's embedded secret (see devin-fingerprint.ts). */
const envelopeKeyMaterial = crypto.subtle.digest(
	"SHA-256",
	new TextEncoder().encode("df97465349f38646af1d66c263e25e08"),
);

async function openEnvelope(value: string): Promise<string[]> {
	const sealed = Uint8Array.fromHex(value);
	const key = await crypto.subtle.importKey("raw", await envelopeKeyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, 12) },
		key,
		sealed.subarray(12),
	);
	return new TextDecoder().decode(plaintext).split("|");
}

describe("devin device fingerprint", () => {
	it("seals the native envelope shape around the credential and a nanosecond timestamp", async () => {
		const credential = "devin-session-token$fixture";
		const [deviceDigest, sealedCredential, timestamp] = await openEnvelope(await createDevinFingerprint(credential));

		expect(sealedCredential).toBe(credential);
		expect(deviceDigest).toMatch(/^[0-9a-f]{128}$/);
		expect(timestamp).toMatch(/^\d{19}$/);
	});

	it("keeps the device identity stable per account and distinct across accounts", async () => {
		const first = (await openEnvelope(await createDevinFingerprint("devin-session-token$a")))[0];
		const repeat = (await openEnvelope(await createDevinFingerprint("devin-session-token$a")))[0];
		const other = (await openEnvelope(await createDevinFingerprint("devin-session-token$b")))[0];

		expect(repeat).toBe(first);
		expect(other).not.toBe(first);
	});

	it("pins the pseudonym derivation so releases do not silently rotate every device identity", async () => {
		const credential = "devin-session-token$a";
		const digest = (await openEnvelope(await createDevinFingerprint(credential)))[0];
		const expected = Buffer.from(
			await crypto.subtle.digest("SHA-512", new TextEncoder().encode(`omp-devin-private-device-v1\0${credential}`)),
		).toString("hex");
		expect(digest).toBe(expected);
	});
});
