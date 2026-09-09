import { describe, expect, test } from "bun:test";
import { formatAmzDate, getSigningKey, signRequest, toHex } from "@oh-my-pi/pi-ai/providers/aws-sigv4";

// Canonical AWS SigV4 test vectors. Sourced from the
// `aws-sig-v4-test-suite` published with the SigV4 spec.
//
// We hit the two most common shapes: a GET with no body and a POST with a JSON
// body. Each vector pins the expected signature so any drift in canonicalization
// is caught.

const CREDS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const REGION = "us-east-1";
const SERVICE = "service";
// 2015-08-30T12:36:00Z -> longDate 20150830T123600Z, shortDate 20150830.
const DATE = new Date("2015-08-30T12:36:00Z");

describe("aws-sigv4 helpers", () => {
	test("formatAmzDate", () => {
		expect(formatAmzDate(DATE)).toEqual({ longDate: "20150830T123600Z", shortDate: "20150830" });
	});

	test("derived signing key matches spec sample", async () => {
		// Reference value from AWS docs:
		//   https://docs.aws.amazon.com/IAM/latest/UserGuide/signature-v4-examples.html
		const key = await getSigningKey(CREDS.secretAccessKey, "20150830", REGION, "iam");
		expect(toHex(key)).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
	});
});

describe("aws-sigv4 signRequest", () => {
	test("GET with empty body matches @smithy/signature-v4 reference", async () => {
		// Reference signatures cross-verified once against `@smithy/signature-v4`
		// (with `@aws-crypto/sha256-js` as the hash) signing the same request
		// with identical credentials/date/region/service. Pinned here so the test
		// runs without those SDK deps.
		const signed = await signRequest({
			method: "GET",
			host: "example.amazonaws.com",
			path: "/",
			body: new Uint8Array(0),
			region: REGION,
			service: SERVICE,
			credentials: CREDS,
			date: DATE,
		});
		expect(signed["x-amz-date"]).toBe("20150830T123600Z");
		// SHA-256("") = e3b0c44...
		expect(signed["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(signed.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
				"SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
				"Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642",
		);
	});

	test("POST with JSON body matches @smithy/signature-v4 reference", async () => {
		const body = new TextEncoder().encode('{"hello":"world"}');
		const signed = await signRequest({
			method: "POST",
			host: "example.amazonaws.com",
			path: "/",
			body,
			region: REGION,
			service: SERVICE,
			credentials: CREDS,
			date: DATE,
			headers: { "content-type": "application/json" },
		});
		// SHA-256('{"hello":"world"}') = 93a23971a914e5eacbf0a8d25154cda...
		expect(signed["x-amz-content-sha256"]).toBe("93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588");
		expect(signed.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
				"SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
				"Signature=e9744044f72be2a6e5082cdcebb673e0a1daf890c82cc130d46abd3769ca15e0",
		);
	});

	test("session token is included when credentials carry one", async () => {
		const signed = await signRequest({
			method: "GET",
			host: "example.amazonaws.com",
			path: "/",
			body: new Uint8Array(0),
			region: REGION,
			service: SERVICE,
			credentials: { ...CREDS, sessionToken: "AQoDYXdzEJr..." },
			date: DATE,
		});
		expect(signed["x-amz-security-token"]).toBe("AQoDYXdzEJr...");
		// Token must appear in SignedHeaders too (it's signed).
		expect(signed.authorization).toContain("x-amz-security-token");
	});
});
