/**
 * Devin (Codeium Cascade) wire constants shared by catalog discovery, the pi-ai
 * provider, and account usage. This module deliberately stays free of the
 * generated protobuf runtime so the synchronous model seed can import it
 * without pulling devin-gen into the boot path.
 */

/** Base host for Codeium/Windsurf's Cascade API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

/**
 * Released Devin CLI request identity. The backend gates behavior on this
 * tuple: `ideType: "chisel"` is what unlocks router assignment (`AssignModel`)
 * and the CLI model surface.
 */
const DEVIN_CLI_METADATA = {
	ideName: "devin-cli",
	ideType: "chisel",
	ideVersion: "3000.11.3",
	extensionName: "chisel",
	extensionVersion: "3000.11.3",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/**
 * Native discovery identity. The Devin CLI announces itself as the `chisel`
 * client on its dev channel for `GetCliModelConfigs`; that identity, not the
 * released chat identity, unlocks the full native config set.
 */
const DEVIN_DISCOVERY_METADATA = {
	ideName: "chisel",
	ideVersion: "0.0.0-dev",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/** Prefixes bare JWT-shaped session tokens; every other key, legacy `sk-ws-` ones included, goes out as stored. */
function encodeDevinCredential(apiKey: string | undefined): string {
	const key = apiKey?.trim();
	if (!key) return "";
	if (key.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return key;
	return key.split(".").length === 3 ? `${DEVIN_SESSION_TOKEN_PREFIX}${key}` : key;
}

/**
 * Fields for `Metadata` on released-CLI calls (`GetUserJwt`, `AssignModel`,
 * `GetChatMessage`, `GetUserStatus`).
 */
export function devinCliMetadata(apiKey: string | undefined, userJwt = "") {
	return {
		apiKey: encodeDevinCredential(apiKey),
		userJwt,
		...DEVIN_CLI_METADATA,
	};
}

/** Fields for `Metadata` on the dev-channel `GetCliModelConfigs` call. */
export function devinDiscoveryMetadata(apiKey: string | undefined) {
	return {
		apiKey: encodeDevinCredential(apiKey),
		...DEVIN_DISCOVERY_METADATA,
	};
}
