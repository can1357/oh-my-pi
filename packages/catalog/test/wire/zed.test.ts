import { describe, expect, it } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import {
	buildZedNativeAppSignInUrl,
	decryptZedAccessToken,
	generateZedAuthKeypair,
	parseZedCredentials,
	ZED_CLOUD_URL,
	ZED_HEADERS,
	ZED_WEB_URL,
} from "../../src/wire/zed";

describe("Zed Wire Protocol & Crypto", () => {
	it("exposes expected Zed constants and header names", () => {
		expect(ZED_CLOUD_URL).toBe("https://cloud.zed.dev");
		expect(ZED_HEADERS.VERSION).toBe("x-zed-version");
		expect(ZED_HEADERS.EXPIRED_TOKEN).toBe("x-zed-expired-token");
		expect(ZED_HEADERS.CLIENT_STATUS).toBe("x-zed-client-supports-status-messages");
		expect(ZED_HEADERS.CLIENT_X_AI).toBe("x-zed-client-supports-x-ai");
	});

	it("uses the public web origin for native app sign-in", () => {
		expect(ZED_WEB_URL).toBe("https://zed.dev");
		expect(buildZedNativeAppSignInUrl(48921, "public-key")).toBe(
			"https://zed.dev/native_app_signin?native_app_port=48921&native_app_public_key=public-key",
		);
	});

	it("generates a valid RSA-2048 keypair with Base64-URL-Safe DER public key", () => {
		const keypair = generateZedAuthKeypair();
		expect(keypair.publicKeyDerBase64Url).toBeString();
		expect(keypair.publicKeyDerBase64Url.length).toBeGreaterThan(100);
		expect(keypair.publicKeyDerBase64Url).not.toContain("+");
		expect(keypair.publicKeyDerBase64Url).not.toContain("/");
		expect(keypair.publicKeyDerBase64Url).not.toContain("=");

		expect(keypair.privateKeyPem).toBeString();
		expect(keypair.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
	});

	it("correctly decrypts an OAEP-SHA256 encrypted access token", () => {
		const keypair = generateZedAuthKeypair();
		const secretToken = "gho_test_secret_access_token_123456789";

		// Reconstruct public key from DER
		let b64 = keypair.publicKeyDerBase64Url.replace(/-/g, "+").replace(/_/g, "/");
		while (b64.length % 4 !== 0) b64 += "=";
		const pubDer = Buffer.from(b64, "base64");

		const encrypted = publicEncrypt(
			{
				key: pubDer,
				format: "der",
				type: "pkcs1",
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			Buffer.from(secretToken, "utf8"),
		);

		const encryptedB64Url = encrypted.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

		const decrypted = decryptZedAccessToken(encryptedB64Url, keypair.privateKeyPem);
		expect(decrypted).toBe(secretToken);
	});

	it("parses JSON formatted credentials", () => {
		const credsJson = JSON.stringify({ userId: "98765", accessToken: "tok_abc_123" });
		const parsed = parseZedCredentials(credsJson);
		expect(parsed.userId).toBe("98765");
		expect(parsed.accessToken).toBe("tok_abc_123");
	});

	it("parses space-separated credentials", () => {
		const credsSpace = "98765 tok_abc_123";
		const parsed = parseZedCredentials(credsSpace);
		expect(parsed.userId).toBe("98765");
		expect(parsed.accessToken).toBe("tok_abc_123");
	});

	it("handles fallback for raw access token without user id", () => {
		const raw = "tok_abc_123";
		const parsed = parseZedCredentials(raw);
		expect(parsed.userId).toBe("");
		expect(parsed.accessToken).toBe("tok_abc_123");
	});
});
