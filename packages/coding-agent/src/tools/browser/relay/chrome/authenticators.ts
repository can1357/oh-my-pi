/**
 * Chrome's preference authenticator plumbing: the shipped HMAC seed, the per-machine device id, and OSCrypt.
 *
 * A tracked preference's authenticator is `HMAC-SHA256(seed, deviceId + prefPath + chromiumJson(value))`
 * (`services/preferences/tracked/pref_hash_calculator.cc`). The seed is a 64-byte binary resource
 * (`IDR_PREF_HASH_SEED_BIN`) whose resource id shifts between Chrome builds, so it is recovered by testing candidate
 * `.pak` payloads against authenticators the profile already carries instead of hard-coding an id.
 *
 * `Hash()` (OSCrypt's input) is the same concatenation without the device id and keyed with the seed as a plain
 * SHA-256 prefix; the digest is then encrypted with a key Chrome derives from the OS key store.
 */
import * as fs from "node:fs/promises";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import { isRecord } from "@oh-my-pi/pi-utils";
import { chromiumJson, type JsonValue } from "./canonical-json";

const GZIP_MAGIC = 0x1f8b;
const BROTLI_MAGIC = 0x1e9b;
const ZSTD_MAGIC = 0x28b52ffd;
const PAK_HEADER_BYTES = 12;
const PAK_ENTRY_BYTES = 6;
const MIN_SEED_BYTES = 8;
const MAX_SEED_BYTES = 1024;

/** One tracked path, its stored value, and the authenticator Chrome wrote for it. */
export interface AuthenticatorSample {
	path: string;
	/** Value the authenticator covers; undefined for a preference that is absent (hashed as an empty string). */
	value?: JsonValue;
	mac: string;
}

/**
 * Chrome's machine id: the IOPlatformUUID on macOS, the registry MachineGuid on Windows, empty elsewhere
 * (`services/preferences/tracked/device_id_mac.cc`, `device_id_stub.cc`).
 */
export async function deviceId(platform: NodeJS.Platform = process.platform): Promise<string> {
	if (platform === "darwin") {
		const result = await Bun.$`ioreg -rd1 -c IOPlatformExpertDevice`.quiet().nothrow();
		return /"IOPlatformUUID" = "([^"]+)"/.exec(result.stdout.toString())?.[1] ?? "";
	}
	if (platform === "win32") {
		const result = await Bun.$`reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`.quiet().nothrow();
		return /MachineGuid\s+REG_\w+\s+(\S+)/.exec(result.stdout.toString())?.[1] ?? "";
	}
	return "";
}

/** HMAC-SHA256 authenticator as Chrome stores it (uppercase hex). */
export function authenticator(seed: Buffer, device: string, prefPath: string, value: JsonValue | undefined): string {
	const hasher = new Bun.CryptoHasher("sha256", seed);
	hasher.update(device);
	hasher.update(prefPath);
	hasher.update(value === undefined ? "" : chromiumJson(value));
	return hasher.digest("hex").toUpperCase();
}

/** Plain SHA-256 that OSCrypt encrypts, without the device id (`PrefHashCalculator::Hash`). */
export function plainHash(seed: Buffer, prefPath: string, value: JsonValue | undefined): Buffer {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(seed);
	hasher.update(prefPath);
	hasher.update(value === undefined ? "" : chromiumJson(value));
	return Buffer.from(hasher.digest());
}

/** Reads every payload of a v5 `.pak`; malformed entries are skipped rather than aborting the scan. */
export async function pakEntries(file: string): Promise<Buffer[]> {
	const data = await fs.readFile(file).catch(() => null);
	if (!data || data.length < PAK_HEADER_BYTES || data.readUInt32LE(0) !== 5) return [];
	const count = data.readUInt16LE(8);
	const offsets: Array<{ start: number; end: number }> = [];
	for (let index = 0; index <= count; index++) {
		const tableOffset = PAK_HEADER_BYTES + index * PAK_ENTRY_BYTES;
		if (tableOffset + PAK_ENTRY_BYTES > data.length) break;
		const start = data.readUInt32LE(tableOffset + 2);
		const previous = offsets[index - 1];
		if (previous && start > previous.start && start <= data.length) previous.end = start;
		offsets.push({ start, end: data.length });
	}
	const payloads: Buffer[] = [];
	for (const { start, end } of offsets) {
		if (start <= 0 || start >= end || end > data.length) continue;
		payloads.push(data.subarray(start, end));
	}
	return payloads;
}

/** Payload variants Chrome may ship the seed under: raw, gzip, brotli, zstd, and hex text. */
function seedCandidates(payloads: Buffer[]): Buffer[] {
	const candidates: Buffer[] = [];
	for (const payload of payloads) {
		if (payload.length >= 2) {
			const magic16 = payload.readUInt16BE(0);
			try {
				if (magic16 === GZIP_MAGIC) candidates.push(gunzipSync(payload));
				else if (magic16 === BROTLI_MAGIC) candidates.push(brotliDecompressSync(payload.subarray(8)));
				else if (payload.length >= 4 && payload.readUInt32BE(0) === ZSTD_MAGIC) {
					candidates.push(zstdDecompressSync(payload));
				}
			} catch {}
		}
		if (payload.length >= MIN_SEED_BYTES && payload.length <= MAX_SEED_BYTES) {
			candidates.push(payload);
			const text = payload.toString("latin1").trim();
			if (text.length === 64 && /^[0-9a-fA-F]{64}$/.test(text)) candidates.push(Buffer.from(text, "hex"));
		}
	}
	return candidates.slice(0, 40_000).filter(candidate => candidate.length >= MIN_SEED_BYTES);
}

/** Collects authenticators the profile already carries, so a seed candidate can be verified against Chrome's own. */
export function authenticatorSamples(
	macs: JsonValue | undefined,
	values: JsonValue | undefined,
): AuthenticatorSample[] {
	const samples: AuthenticatorSample[] = [];
	const visit = (node: JsonValue | undefined, prefix: string): void => {
		if (!isRecord(node)) return;
		for (const key in node) {
			const entry = node[key] as JsonValue;
			const prefPath = prefix ? `${prefix}.${key}` : key;
			if (key.endsWith("_encrypted_hash")) continue;
			if (typeof entry === "string") {
				let cursor: JsonValue | undefined = values;
				for (const segment of prefPath.split(".")) {
					cursor = isRecord(cursor) ? (cursor[segment] as JsonValue | undefined) : undefined;
					if (cursor === undefined) break;
				}
				samples.push({ path: prefPath, value: cursor, mac: entry });
			} else {
				visit(entry, prefPath);
			}
		}
	};
	visit(macs, "");
	return samples.slice(0, 40);
}

/** Picks the seed whose HMACs reproduce the profile's authenticators; empty seed for unbranded Chromium. */
export async function discoverSeed(
	pakFiles: readonly string[],
	device: string,
	samples: readonly AuthenticatorSample[],
): Promise<Buffer> {
	if (samples.length === 0) return Buffer.alloc(0);
	const candidates = [Buffer.alloc(0), ...seedCandidates((await Promise.all(pakFiles.map(pakEntries))).flat())];
	const sampleSet = samples.slice(0, 12);
	let best: { seed: Buffer; score: number } | undefined;
	for (const seed of candidates) {
		let score = 0;
		for (const sample of sampleSet) {
			if (authenticator(seed, device, sample.path, sample.value) === sample.mac) score++;
		}
		if (score === 0) continue;
		if (!best || score > best.score) best = { seed, score };
		if (score === sampleSet.length) break;
	}
	if (!best) {
		throw new Error(
			`Could not recover Chrome's pref-hash seed from ${pakFiles.length} resource pack(s); the profile has ${samples.length} authenticator sample(s).`,
		);
	}
	return best.seed;
}
