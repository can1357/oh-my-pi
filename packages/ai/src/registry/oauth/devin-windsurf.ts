/**
 * Windsurf Enterprise login for Devin seats: `login "custom" hook="devin-windsurf"`.
 *
 * The declarative `devin` rule mints a Devin-native token through app.devin.ai,
 * which legacy Windsurf Enterprise seats cannot complete (the continue endpoint
 * bounces unauthenticated browsers to app.devin.ai login, and its Windsurf
 * bridge does not return to the CLI callback). This hook drives the Windsurf
 * editor authorize endpoint directly, so only a Windsurf (Enterprise) browser
 * session is required; `store-as "devin"` routes the minted raw key through
 * the normal devin provider plumbing.
 */
import type { FetchImpl } from "../../types";
import * as AIError from "../../error";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthController } from "./types";

const WINDSURF_AUTHORIZE_URL = "https://windsurf.com/editor/signin";
const WINDSURF_EXCHANGE_URL =
	"https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
const DEFAULT_API_ENDPOINT = "https://server.enterprise.windsurf.com";
const CALLBACK_PORT = 59654;
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

export interface WindsurfExchange {
	apiKey: string;
	userName: string;
	apiEndpoint: string;
}

class DevinWindsurfOAuthFlow extends OAuthCallbackFlow {
	#pkce?: { verifier: string; challenge: string };

	constructor(ctrl: OAuthController) {
		super(ctrl, { preferredPort: CALLBACK_PORT, callbackHostname: "127.0.0.1" });
	}

	override generateState(): string {
		return crypto.randomUUID();
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		this.#pkce = await generatePKCE();
		const params = new URLSearchParams({
			response_type: "code",
			redirect_uri: redirectUri,
			state,
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			prompt: "login",
			redirect_parameters_type: "query",
		});
		return {
			url: `${WINDSURF_AUTHORIZE_URL}?${params.toString()}`,
			instructions: "Sign in with your Windsurf (Enterprise) account in your browser.",
		};
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		if (!this.#pkce) {
			throw new AIError.OAuthError("Devin Windsurf PKCE verifier was not initialized", {
				kind: "configuration",
				provider: "devin-windsurf",
			});
		}
		const exchange = await exchangeWindsurfPkceCode(code, this.#pkce.verifier, this.ctrl.fetch);
		return {
			access: exchange.apiKey,
			refresh: exchange.apiKey,
			expires: Date.now() + FALLBACK_EXPIRES_MS,
			apiEndpoint: exchange.apiEndpoint,
			orgName: exchange.userName || undefined,
		};
	}
}

/** Encode a Connect-unary protobuf message of two length-delimited string fields. */
function encodeTwoStringProto(fieldOne: string, fieldTwo: string): Uint8Array {
	const chunks: number[] = [];
	for (const [field, value] of [
		[1, fieldOne],
		[2, fieldTwo],
	] as const) {
		chunks.push((field << 3) | 2);
		let length = value.length;
		while (length > 0x7f) {
			chunks.push((length & 0x7f) | 0x80);
			length >>>= 7;
		}
		chunks.push(length);
		for (let index = 0; index < value.length; index++) chunks.push(value.charCodeAt(index));
	}
	return Uint8Array.from(chunks);
}

/** Decode a protobuf message of length-delimited string fields keyed by field number. */
function decodeStringProto(data: Uint8Array): Record<number, string> {
	const fields: Record<number, string> = {};
	const decoder = new TextDecoder();
	let offset = 0;
	while (offset < data.length) {
		const tag = data[offset++];
		const field = tag >>> 3;
		if ((tag & 7) !== 2) {
			throw new AIError.OAuthError("Unexpected wire type in Windsurf exchange response", {
				kind: "validation",
				provider: "devin-windsurf",
			});
		}
		let length = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = data[offset++];
			length |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		fields[field] = decoder.decode(data.subarray(offset, offset + length));
		offset += length;
	}
	return fields;
}

export async function exchangeWindsurfPkceCode(
	code: string,
	codeVerifier: string,
	fetchImpl: FetchImpl = fetch,
): Promise<WindsurfExchange> {
	const response = await fetchImpl(WINDSURF_EXCHANGE_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/proto",
			"Connect-Protocol-Version": "1",
			Accept: "*/*",
		},
		body: encodeTwoStringProto(code, codeVerifier),
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new AIError.OAuthError(`Windsurf PKCE exchange failed: ${response.status} ${detail}`.trim(), {
			kind: "validation",
			provider: "devin-windsurf",
			status: response.status,
		});
	}
	const fields = decodeStringProto(new Uint8Array(await response.arrayBuffer()));
	if (!fields[1]) {
		throw new AIError.OAuthError("Windsurf PKCE exchange response omitted the session key", {
			kind: "validation",
			provider: "devin-windsurf",
		});
	}
	// The exchange returns the `g`-prefixed wire form of the key (gsk-ws-01-...);
	// Windsurf RPCs authenticate with the unprefixed key, which is also what the
	// official CLI persists in credentials.toml.
	const apiKey = fields[1].startsWith("gsk-") ? fields[1].slice(1) : fields[1];
	return {
		apiKey,
		userName: fields[2] ?? "",
		apiEndpoint: fields[3] || DEFAULT_API_ENDPOINT,
	};
}

export async function loginDevinWindsurfHook(callbacks: OAuthController): Promise<OAuthCredentials> {
	const flow = new DevinWindsurfOAuthFlow(callbacks);
	return flow.login();
}
