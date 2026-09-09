import { deviceCheckGenerateToken } from "@oh-my-pi/pi-natives";

const CHATGPT_BUNDLE_ID = "com.openai.codex";
const APP_SESSION_ID = crypto.randomUUID();

type DeviceCheckResult = {
	supported: boolean;
	tokenBase64?: string | null;
	latencyMs?: number | null;
};

function cborHeader(major: number, value: number): Buffer {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid CBOR length: ${value}`);
	if (value < 24) return Buffer.from([major + value]);
	if (value <= 0xff) return Buffer.from([major + 24, value]);
	if (value <= 0xffff) {
		const output = Buffer.allocUnsafe(3);
		output[0] = major + 25;
		output.writeUInt16BE(value, 1);
		return output;
	}
	if (value <= 0xffff_ffff) {
		const output = Buffer.allocUnsafe(5);
		output[0] = major + 26;
		output.writeUInt32BE(value, 1);
		return output;
	}
	throw new Error(`CBOR length is too large: ${value}`);
}

function cborUnsigned(value: number): Buffer {
	return cborHeader(0, value);
}

function cborText(value: string): Buffer {
	const text = Buffer.from(value, "utf8");
	return Buffer.concat([cborHeader(96, text.length), text]);
}

function cborMap(entries: ReadonlyArray<readonly [Buffer, Buffer]>): Buffer {
	const values: Buffer[] = [cborHeader(160, entries.length)];
	for (const [key, value] of entries) values.push(key, value);
	return Buffer.concat(values);
}

function attestationSignals(): Buffer {
	const resolved = Intl.DateTimeFormat().resolvedOptions();
	const locale = (resolved.locale || "unknown").slice(0, 64);
	const timezone = (resolved.timeZone || "unknown").slice(0, 64);
	const preferredLanguages = Buffer.concat([cborHeader(128, 1), cborText(locale)]);
	return cborMap([
		[cborUnsigned(0), cborUnsigned(1)],
		[cborUnsigned(1), preferredLanguages],
		[cborUnsigned(2), cborText(locale)],
		[cborUnsigned(3), cborText(timezone)],
		[cborUnsigned(4), cborUnsigned(0)],
		[cborUnsigned(5), cborUnsigned(1)],
		[cborUnsigned(6), cborText(APP_SESSION_ID.slice(0, 128))],
	]);
}

function buildClientAttestation(result: DeviceCheckResult): string {
	const entries: Array<readonly [Buffer, Buffer]> = [];
	if (result.supported && result.tokenBase64) {
		entries.push([cborText("token"), cborText(result.tokenBase64)]);
	} else {
		entries.push([cborText("error_code"), cborUnsigned(result.supported ? 4 : 3)]);
	}
	entries.push([cborText("bundle_id"), cborText(CHATGPT_BUNDLE_ID)]);
	const signals = attestationSignals();
	entries.push([cborText("f"), Buffer.concat([cborHeader(64, signals.length), signals])]);
	if (result.latencyMs !== undefined && result.latencyMs !== null) {
		const latency = Buffer.allocUnsafe(9);
		latency[0] = 0xfb;
		latency.writeDoubleBE(result.latencyMs, 1);
		entries.push([cborText("t"), latency]);
	}
	return `v1.${cborMap(entries).toString("base64url")}`;
}

/** Generates the Codex DeviceCheck attestation envelope sent as `x-oai-attestation` on ChatGPT-OAuth requests. */
export async function generateCodexAttestation(): Promise<string | undefined> {
	if (process.platform !== "darwin" || process.arch !== "arm64") return undefined;
	let result: DeviceCheckResult;
	try {
		result = await deviceCheckGenerateToken();
	} catch {
		return undefined;
	}
	return JSON.stringify({ v: 1, s: 0, t: buildClientAttestation(result) });
}
