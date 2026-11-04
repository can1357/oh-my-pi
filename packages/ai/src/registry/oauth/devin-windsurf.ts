/**
 * `login "custom" hook="devin-windsurf"`: Windsurf Enterprise seats cannot finish
 * the Devin-native app.devin.ai flow, so this drives the Windsurf editor
 * authorize page (PKCE + loopback callback) and exchanges the code for the
 * seat's raw API key, the same key the Devin CLI stores. `store-as "devin"`
 * files it as a `devin` API key.
 */
import {
	ExchangePKCEAuthorizationCodeRequestSchema,
	ExchangePKCEAuthorizationCodeResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { DEVIN_DEFAULT_BASE_URL } from "@oh-my-pi/pi-catalog/wire/devin";
import { decodeDevinUnaryMessage } from "@oh-my-pi/pi-catalog/wire/devin-proto";
import * as AIError from "../../error";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const AUTHORIZE_URL = "https://windsurf.com/editor/signin";
const EXCHANGE_PATH = "/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
/** Loopback port the official Devin CLI uses for this flow. */
const CALLBACK_PORT = 59654;

class DevinWindsurfFlow extends OAuthCallbackFlow {
	#verifier = "";

	constructor(ctrl: OAuthController) {
		super(ctrl, { preferredPort: CALLBACK_PORT, callbackHostname: "127.0.0.1" });
	}

	/** Same state format as the official CLI. */
	override generateState(): string {
		return crypto.randomUUID();
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const { verifier, challenge } = await generatePKCE();
		this.#verifier = verifier;
		const params = new URLSearchParams({
			response_type: "code",
			redirect_uri: redirectUri,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			prompt: "login",
			redirect_parameters_type: "query",
		});
		return {
			url: `${AUTHORIZE_URL}?${params}`,
			instructions: "Sign in with your Windsurf (Enterprise) account in your browser.",
		};
	}

	/** The seat key neither expires nor refreshes; the hook keeps only `access`. */
	async exchangeToken(code: string): Promise<OAuthCredentials> {
		const access = await exchangeWindsurfCode(code, this.#verifier, this.ctrl);
		return { access, refresh: "", expires: Number.POSITIVE_INFINITY };
	}
}

/** Exchanges an authorization code for the seat's raw API key (`sk-ws-…`). */
export async function exchangeWindsurfCode(
	code: string,
	verifier: string,
	ctrl: Pick<OAuthController, "fetch" | "signal">,
): Promise<string> {
	const request = create(ExchangePKCEAuthorizationCodeRequestSchema, {
		authorizationCode: code,
		codeVerifier: verifier,
	});
	const response = await (ctrl.fetch ?? fetch)(`${DEVIN_DEFAULT_BASE_URL}${EXCHANGE_PATH}`, {
		method: "POST",
		// Any other content type is answered with 200 and an empty body.
		headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
		body: toBinary(ExchangePKCEAuthorizationCodeRequestSchema, request),
		signal: ctrl.signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new AIError.OAuthError(`Windsurf code exchange failed: ${response.status} ${detail}`.trim(), {
			kind: "token-exchange",
			provider: "devin-windsurf",
			status: response.status,
		});
	}
	const body = new Uint8Array(await response.arrayBuffer());
	const apiKey = decodeDevinUnaryMessage(ExchangePKCEAuthorizationCodeResponseSchema, body)?.apiKey;
	if (!apiKey) {
		throw new AIError.OAuthError("Windsurf code exchange returned no API key", {
			kind: "validation",
			provider: "devin-windsurf",
		});
	}
	// The exchange returns the `g`-prefixed wire form (`gsk-ws-…`); RPCs authenticate with the raw key.
	return apiKey.startsWith("gsk-") ? apiKey.slice(1) : apiKey;
}

export async function loginDevinWindsurfHook(ctrl: OAuthController): Promise<string> {
	return (await new DevinWindsurfFlow(ctrl).login()).access;
}
