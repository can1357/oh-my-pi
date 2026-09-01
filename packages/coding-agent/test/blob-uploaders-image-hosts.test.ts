import { describe, expect, it } from "bun:test";
import type { BlobUploadRequest } from "../src/blob-broker/publication";
import {
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	type FetchInput,
} from "../src/blob-broker/uploader-runtime";
import { createImageHostUploader } from "../src/blob-broker/uploaders-image-hosts";

const IMGUR_UPLOAD_URL = "https://api.imgur.com/3/upload";
const IMAGESHACK_UPLOAD_URL = "https://api.imageshack.com/v2/images";
const FLICKR_UPLOAD_URL = "https://up.flickr.com/services/upload/";
const FLICKR_REST_URL = "https://api.flickr.com/services/rest";
const VGYME_UPLOAD_URL = "https://vgy.me/upload";

const UPLOAD_REQUEST: BlobUploadRequest = {
	bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	mimeType: "image/png",
	extension: "png",
	filename: "proof.png",
};

function inputUrl(input: FetchInput): string {
	return input instanceof Request ? input.url : String(input);
}

function formDataBody(init: RequestInit | undefined): FormData {
	expect(init?.body).toBeInstanceOf(FormData);
	return init?.body as FormData;
}

function stringFields(form: FormData): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const [key, value] of form.entries()) {
		if (typeof value === "string") fields[key] = value;
	}
	return fields;
}

function expectUploadedFile(form: FormData, field: string): void {
	const file = form.get(field);
	expect(file).toBeInstanceOf(File);
	expect(file).toMatchObject({ name: "proof.png", type: "image/png", size: UPLOAD_REQUEST.bytes.byteLength });
}

function oauthEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

async function expectedOAuthSignature(
	method: "GET" | "POST",
	url: string,
	parameters: Readonly<Record<string, string>>,
	consumerSecret: string,
	tokenSecret: string,
): Promise<string> {
	const normalized = Object.entries(parameters)
		.map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
		.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
			if (leftKey < rightKey) return -1;
			if (leftKey > rightKey) return 1;
			if (leftValue < rightValue) return -1;
			if (leftValue > rightValue) return 1;
			return 0;
		})
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const parsedUrl = new URL(url);
	const baseUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
	const signatureBase = `${method}&${oauthEncode(baseUrl)}&${oauthEncode(normalized)}`;
	const keyBytes = new TextEncoder().encode(`${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signatureBase));
	return Buffer.from(signature).toString("base64");
}

function config(
	credentials: DestinationRuntimeConfig["credentials"],
	options: DestinationRuntimeConfig["options"],
	fetch: NonNullable<DestinationRuntimeConfig["fetch"]>,
): DestinationRuntimeConfig {
	return { credentials, options, fetch };
}

describe("built-in image host uploaders", () => {
	for (const scenario of [
		{
			name: "Client-ID",
			credentials: { clientId: "imgur-client-id" } as Readonly<Record<string, string>>,
			authorization: "Client-ID imgur-client-id",
			response: { id: "client-image-id", link: "https://i.imgur.com/client.png...", deletehash: "delete/hash" },
			deleteIdentifier: "delete%2Fhash",
		},
		{
			name: "Bearer",
			credentials: { accessToken: "imgur-access-token" } as Readonly<Record<string, string>>,
			authorization: "Bearer imgur-access-token",
			response: { id: "bearer-image-id", link: "https://i.imgur.com/bearer.png..." },
			deleteIdentifier: "bearer-image-id",
		},
	] as const) {
		it(`does not confuse Imgur ${scenario.name} auth and preserves its direct link and deletion identity`, async () => {
			let calls = 0;
			const uploader = createImageHostUploader(
				"imgur",
				config(scenario.credentials, { album: "album-42" }, async (input, init) => {
					calls++;
					expect(inputUrl(input)).toBe(IMGUR_UPLOAD_URL);
					expect(init?.method).toBe("POST");
					expect(init?.headers).toEqual({ Authorization: scenario.authorization });
					const form = formDataBody(init);
					expect(stringFields(form)).toEqual({ album: "album-42" });
					expectUploadedFile(form, "image");
					return Response.json({ success: true, data: scenario.response });
				}),
			);

			expect(uploader).not.toBeNull();
			const publication = await uploader!.upload(UPLOAD_REQUEST);

			expect(calls).toBe(1);
			expect(publication).toEqual({
				url: scenario.response.link.replace(/\.+$/, ""),
				destination: "imgur",
				bytes: UPLOAD_REQUEST.bytes.byteLength,
				delete: {
					method: "DELETE",
					url: `https://api.imgur.com/3/image/${scenario.deleteIdentifier}`,
					headers: { Authorization: scenario.authorization },
				},
				remoteId: scenario.response.id,
			});
		});
	}

	it("does not lose ImageShack server coordinates when constructing the direct image URL", async () => {
		const uploader = createImageHostUploader(
			"imageshack",
			config({ apiKey: "imageshack-key", authToken: "imageshack-token" }, { public: true }, async (input, init) => {
				expect(inputUrl(input)).toBe(IMAGESHACK_UPLOAD_URL);
				expect(init?.method).toBe("POST");
				const form = formDataBody(init);
				expect(stringFields(form)).toEqual({
					api_key: "imageshack-key",
					auth_token: "imageshack-token",
					public: "y",
				});
				expectUploadedFile(form, "file");
				return Response.json({
					success: true,
					result: { images: [{ id: "image-17", server: 924, bucket: "v2", filename: "proof.png" }] },
				});
			}),
		);

		expect(uploader).not.toBeNull();
		expect(await uploader!.upload(UPLOAD_REQUEST)).toEqual({
			url: "https://imagizer.imageshack.com/a/img924/v2/proof.png",
			destination: "imageshack",
			bytes: UPLOAD_REQUEST.bytes.byteLength,
			remoteId: "image-17",
		});
	});

	it("does not substitute a Chevereto viewer page for the returned direct image URL", async () => {
		const endpoint = "https://images.example.test/api/1/upload/";
		const uploader = createImageHostUploader(
			"chevereto",
			config({ apiKey: "chevereto-key" }, { endpoint }, async (input, init) => {
				expect(inputUrl(input)).toBe(endpoint);
				expect(init?.method).toBe("POST");
				const form = formDataBody(init);
				expect(stringFields(form)).toEqual({ key: "chevereto-key", format: "json" });
				expectUploadedFile(form, "source");
				return Response.json({
					image: {
						id: "chevereto-88",
						url: "https://cdn.example.test/images/proof.png",
						url_viewer: "https://images.example.test/image/proof",
					},
				});
			}),
		);

		expect(uploader).not.toBeNull();
		expect(await uploader!.upload(UPLOAD_REQUEST)).toEqual({
			url: "https://cdn.example.test/images/proof.png",
			destination: "chevereto",
			bytes: UPLOAD_REQUEST.bytes.byteLength,
			remoteId: "chevereto-88",
		});
	});

	it("does not discard vgy.me's replayable deletion URL", async () => {
		const uploader = createImageHostUploader(
			"vgyme",
			config({ userKey: "vgy-user-key" }, {}, async (input, init) => {
				expect(inputUrl(input)).toBe(VGYME_UPLOAD_URL);
				expect(init?.method).toBe("POST");
				const form = formDataBody(init);
				expect(stringFields(form)).toEqual({ userkey: "vgy-user-key" });
				expectUploadedFile(form, "file");
				return Response.json({
					error: false,
					image: "https://i.vgy.me/proof.png",
					delete: "https://vgy.me/delete/one-time-token",
					filename: "proof.png",
				});
			}),
		);

		expect(uploader).not.toBeNull();
		expect(await uploader!.upload(UPLOAD_REQUEST)).toEqual({
			url: "https://i.vgy.me/proof.png",
			destination: "vgyme",
			bytes: UPLOAD_REQUEST.bytes.byteLength,
			delete: { method: "DELETE", url: "https://vgy.me/delete/one-time-token" },
			remoteId: "proof.png",
		});
	});

	it("does not send an invalid Flickr OAuth 1 signature or publish a smaller rendition", async () => {
		const credentials = {
			apiKey: "flickr-consumer-key",
			apiSecret: "flickr-consumer-secret",
			oauthToken: "flickr-oauth-token",
			oauthTokenSecret: "flickr-oauth-token-secret",
		};
		let call = 0;
		const uploader = createImageHostUploader(
			"flickr",
			config(credentials, { title: "Proof image", tags: "contract test", isPublic: "1" }, async (input, init) => {
				call++;
				if (call === 1) {
					expect(inputUrl(input)).toBe(FLICKR_UPLOAD_URL);
					expect(init?.method).toBe("POST");
					const form = formDataBody(init);
					expectUploadedFile(form, "photo");
					const fields = stringFields(form);
					expect(fields).toMatchObject({
						title: "Proof image",
						tags: "contract test",
						is_public: "1",
						oauth_consumer_key: credentials.apiKey,
						oauth_signature_method: "HMAC-SHA1",
						oauth_token: credentials.oauthToken,
						oauth_version: "1.0",
					});
					expect(fields.oauth_nonce).toMatch(/^[0-9a-f]{32}$/);
					expect(fields.oauth_timestamp).toMatch(/^\d+$/);
					const signature = fields.oauth_signature;
					delete fields.oauth_signature;
					expect(signature).toBe(
						await expectedOAuthSignature(
							"POST",
							FLICKR_UPLOAD_URL,
							fields,
							credentials.apiSecret,
							credentials.oauthTokenSecret,
						),
					);
					return new Response('<rsp stat="ok"><photoid>photo-123</photoid></rsp>');
				}

				expect(init?.method).toBe("GET");
				const url = new URL(inputUrl(input));
				expect(`${url.origin}${url.pathname}`).toBe(FLICKR_REST_URL);
				const fields = Object.fromEntries(url.searchParams.entries());
				expect(fields).toMatchObject({
					format: "json",
					method: "flickr.photos.getSizes",
					nojsoncallback: "1",
					photo_id: "photo-123",
					oauth_consumer_key: credentials.apiKey,
					oauth_signature_method: "HMAC-SHA1",
					oauth_token: credentials.oauthToken,
					oauth_version: "1.0",
				});
				const signature = fields.oauth_signature;
				delete fields.oauth_signature;
				expect(signature).toBe(
					await expectedOAuthSignature(
						"GET",
						FLICKR_REST_URL,
						fields,
						credentials.apiSecret,
						credentials.oauthTokenSecret,
					),
				);
				return Response.json({
					stat: "ok",
					sizes: {
						size: [
							{ label: "Small", source: "https://live.staticflickr.com/photo_small.jpg" },
							{ label: "Large", source: "https://live.staticflickr.com/photo_large.jpg" },
							{ label: "Original", source: "https://live.staticflickr.com/photo_original.png" },
						],
					},
				});
			}),
		);

		expect(uploader).not.toBeNull();
		expect(await uploader!.upload(UPLOAD_REQUEST)).toEqual({
			url: "https://live.staticflickr.com/photo_original.png",
			destination: "flickr",
			bytes: UPLOAD_REQUEST.bytes.byteLength,
			remoteId: "photo-123",
		});
		expect(call).toBe(2);
	});

	it("rejects defunct Photobucket before fetch without exposing configured secrets", () => {
		const secret = "photobucket-secret-that-must-not-leak";
		let fetchCalls = 0;
		let error: unknown;
		try {
			createImageHostUploader(
				"photobucket",
				config({ apiKey: "photobucket-key", apiSecret: secret }, {}, async () => {
					fetchCalls++;
					return new Response(null, { status: 500 });
				}),
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(DestinationUnavailableError);
		expect(String(error)).toContain("photobucket is unavailable");
		expect(String(error)).not.toContain(secret);
		expect(fetchCalls).toBe(0);
	});

	it("does not include Imgur bearer credentials in HTTP failure errors", async () => {
		const secret = "imgur-bearer-secret-that-must-not-leak";
		const uploader = createImageHostUploader(
			"imgur",
			config(
				{ accessToken: secret },
				{},
				async () => new Response("provider diagnostic body", { status: 401, statusText: "Unauthorized" }),
			),
		);

		expect(uploader).not.toBeNull();
		let error: unknown;
		try {
			await uploader!.upload(UPLOAD_REQUEST);
		} catch (caught) {
			error = caught;
		}
		expect(String(error)).toBe("Error: imgur upload failed with HTTP 401 Unauthorized");
		expect(String(error)).not.toContain(secret);
	});
});
