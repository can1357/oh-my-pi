import { describe, expect, it } from "bun:test";
import type { BlobDestinationId } from "../src/blob-broker/destinations";
import type { RemoteDeleteAction } from "../src/blob-broker/publication";
import type { DestinationRuntimeConfig, FetchImpl, FetchInput } from "../src/blob-broker/uploader-runtime";
import { createObjectStorageUploader } from "../src/blob-broker/uploaders-object-storage";

type TestBody = string | Uint8Array | FormData | Blob | File;

const encoder = new TextEncoder();
const uploadBytes = encoder.encode("object-store-payload");
const accessKeyId = "AKIDEXAMPLE";
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

interface CapturedRequest {
	url: URL;
	method: string;
	headers: Headers;
	body?: TestBody | null;
}

function captureRequest(input: FetchInput, init: RequestInit = {}): CapturedRequest {
	const inputRequest = input instanceof Request ? input : undefined;
	const body = init.body;
	const capturedBody: TestBody | null | undefined =
		body === null || body === undefined
			? body
			: typeof body === "string" || body instanceof Uint8Array || body instanceof FormData || body instanceof Blob
				? body
				: undefined;
	return {
		url: new URL(inputRequest?.url ?? input.toString()),
		method: init.method ?? inputRequest?.method ?? "GET",
		headers: new Headers(init.headers ?? inputRequest?.headers),
		body: capturedBody,
	};
}

function uploaderFor(destination: BlobDestinationId, config: DestinationRuntimeConfig) {
	const uploader = createObjectStorageUploader(destination, config);
	if (!uploader) throw new Error(`Expected an object-storage uploader for ${destination}`);
	return uploader;
}

function bytesOf(body: TestBody | null | undefined): Uint8Array {
	if (body === undefined || body === null) return new Uint8Array();
	if (typeof body === "string") return encoder.encode(body);
	if (body instanceof Uint8Array) return body;
	throw new Error(`Unexpected captured body: ${body.constructor.name}`);
}

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
	return Uint8Array.from(bytes).buffer;
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	return Buffer.from(await crypto.subtle.digest("SHA-256", cryptoBytes(bytes))).toString("hex");
}

async function sha1Hex(value: Uint8Array): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-1", cryptoBytes(value))).toString("hex");
}

async function hmacSha256(key: Uint8Array, value: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey("raw", cryptoBytes(key), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, cryptoBytes(encoder.encode(value))));
}

async function assertValidS3Signature(
	request: Pick<CapturedRequest, "url" | "method" | "headers">,
	body: Uint8Array,
	region: string,
	secret = secretAccessKey,
): Promise<void> {
	const authorization = request.headers.get("authorization") ?? "";
	const parsed = authorization.match(
		/^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
	);
	expect(parsed, "AWS Authorization must contain a credential scope, signed headers, and signature").not.toBeNull();
	if (!parsed) return;

	const [, credential, scope, signedHeaderText, signature] = parsed;
	const [shortDate, scopeRegion, service, terminal] = scope.split("/");
	expect(credential).toBe(accessKeyId);
	expect(scopeRegion).toBe(region);
	expect(service).toBe("s3");
	expect(terminal).toBe("aws4_request");

	const amzDate = request.headers.get("x-amz-date") ?? "";
	expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
	expect(amzDate.slice(0, 8)).toBe(shortDate);
	const payloadHash = await sha256Hex(body);
	expect(request.headers.get("x-amz-content-sha256")).toBe(payloadHash);

	const signedHeaderNames = signedHeaderText.split(";");
	expect(signedHeaderNames).toEqual([...signedHeaderNames].sort());
	const canonicalHeaders = `${signedHeaderNames
		.map(name => {
			const value = request.headers.get(name);
			expect(value, `${name} must be present when named by SignedHeaders`).not.toBeNull();
			return `${name}:${value?.trim().replace(/\s+/g, " ")}`;
		})
		.join("\n")}\n`;
	const canonicalRequest = [
		request.method,
		request.url.pathname,
		"",
		canonicalHeaders,
		signedHeaderText,
		payloadHash,
	].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
	const dateKey = await hmacSha256(encoder.encode(`AWS4${secret}`), shortDate);
	const regionKey = await hmacSha256(dateKey, region);
	const serviceKey = await hmacSha256(regionKey, "s3");
	const signingKey = await hmacSha256(serviceKey, "aws4_request");
	const expected = Buffer.from(await hmacSha256(signingKey, stringToSign)).toString("hex");
	expect(signature).toBe(expected);
}

async function assertValidAzureSharedKey(
	method: "PUT" | "DELETE",
	url: URL,
	headers: Headers,
	accountName: string,
	accountKey: Uint8Array,
): Promise<void> {
	const canonicalHeaders = [...headers.entries()]
		.filter(([name]) => name.startsWith("x-ms-"))
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => `${name}:${value}\n`)
		.join("");
	const contentLength = headers.get("content-length") ?? "";
	const stringToSign = [
		method,
		"",
		"",
		contentLength === "0" ? "" : contentLength,
		"",
		headers.get("content-type") ?? "",
		"",
		"",
		"",
		"",
		"",
		"",
		`${canonicalHeaders}/${accountName}${decodeURIComponent(url.pathname)}`,
	].join("\n");
	const expected = Buffer.from(await hmacSha256(accountKey, stringToSign)).toString("base64");
	expect(headers.get("authorization")).toBe(`SharedKey ${accountName}:${expected}`);
}

describe("S3-compatible object storage uploaders", () => {
	it("signs the uploaded bytes and replayable delete instead of publishing an unsigned S3 request", async () => {
		const requests: CapturedRequest[] = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push(captureRequest(input, init));
			return new Response(null, { status: 200 });
		};
		const uploader = uploaderFor("amazon-s3", {
			options: {
				bucket: "media-bucket",
				region: "eu-west-1",
				keyPrefix: "/captures/",
				publicBaseUrl: "https://cdn.example.test/assets",
				cacheControl: "public, max-age=600",
			},
			credentials: { accessKeyId, secretAccessKey, sessionToken: "temporary-session-token" },
			fetch,
		});

		const publication = await uploader.upload({
			bytes: uploadBytes,
			mimeType: "image/png",
			extension: "png",
			filename: "screen shot.png",
		});

		expect(requests).toHaveLength(1);
		const put = requests[0];
		expect(put.method).toBe("PUT");
		expect(put.url.toString()).toBe("https://media-bucket.s3.eu-west-1.amazonaws.com/captures/screen%20shot.png");
		expect(bytesOf(put.body)).toEqual(uploadBytes);
		expect(put.headers.get("content-type")).toBe("image/png");
		expect(put.headers.get("cache-control")).toBe("public, max-age=600");
		expect(put.headers.get("x-amz-security-token")).toBe("temporary-session-token");
		await assertValidS3Signature(put, uploadBytes, "eu-west-1");

		expect(publication).toMatchObject({
			destination: "amazon-s3",
			bytes: uploadBytes.byteLength,
			url: "https://cdn.example.test/assets/captures/screen%20shot.png",
			remoteId: "captures/screen shot.png",
		});
		expect(publication.delete).toBeDefined();
		const deletion = publication.delete as RemoteDeleteAction;
		expect(deletion.method).toBe("DELETE");
		expect(deletion.url).toBe(put.url.toString());
		const deleteRequest = {
			url: new URL(deletion.url),
			method: deletion.method,
			headers: new Headers(deletion.headers),
		};
		expect(deleteRequest.headers.get("x-amz-security-token")).toBe("temporary-session-token");
		await assertValidS3Signature(deleteRequest, new Uint8Array(), "eu-west-1");
	});

	interface AliasTestCase {
		readonly name: string;
		readonly destination: BlobDestinationId;
		readonly options: DestinationRuntimeConfig["options"];
		readonly expectedUrl: string;
		readonly region: string;
	}

	const aliasTestCases: readonly AliasTestCase[] = [
		{
			name: "R2",
			destination: "r2",
			options: { bucket: "assets", accountId: "account-123" },
			expectedUrl: "https://account-123.r2.cloudflarestorage.com/assets/alias.bin",
			region: "auto",
		},
		{
			name: "Tigris",
			destination: "tigris",
			options: { bucket: "assets" },
			expectedUrl: "https://assets.fly.storage.tigris.dev/alias.bin",
			region: "auto",
		},
		{
			name: "MinIO",
			destination: "minio",
			options: { bucket: "assets", endpoint: "https://minio.example.test/base" },
			expectedUrl: "https://minio.example.test/base/assets/alias.bin",
			region: "us-east-1",
		},
		{
			name: "Garage",
			destination: "garage",
			options: { bucket: "assets", endpoint: "https://garage.example.test/base" },
			expectedUrl: "https://garage.example.test/base/assets/alias.bin",
			region: "garage",
		},
		{
			name: "Backblaze B2 S3 API",
			destination: "backblaze-b2",
			options: { bucket: "assets" },
			expectedUrl: "https://assets.s3.us-west-004.backblazeb2.com/alias.bin",
			region: "us-west-004",
		},
	];

	for (const testCase of aliasTestCases) {
		it(`uses the ${testCase.name} endpoint, addressing style, and signing region defaults`, async () => {
			let captured: CapturedRequest | undefined;
			const fetch: FetchImpl = async (input, init) => {
				captured = captureRequest(input, init);
				return new Response(null, { status: 200 });
			};
			const uploader = uploaderFor(testCase.destination, {
				options: testCase.options,
				credentials: { accessKeyId, secretAccessKey },
				fetch,
			});
			const publication = await uploader.upload({
				bytes: uploadBytes,
				mimeType: "application/octet-stream",
				extension: "bin",
				filename: "alias.bin",
			});

			expect(captured).toBeDefined();
			if (!captured) return;
			expect(captured.url.toString()).toBe(testCase.expectedUrl);
			expect(publication.url).toBe(testCase.expectedUrl);
			expect(publication.remoteId).toBe("alias.bin");
			await assertValidS3Signature(captured, uploadBytes, testCase.region);
		});
	}
});

describe("native Google Cloud Storage uploader", () => {
	it("sends metadata and bytes as an authenticated multipart upload and retains the server object name for deletion", async () => {
		const requests: CapturedRequest[] = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push(captureRequest(input, init));
			return Response.json({ name: "stored/server object.png" });
		};
		const uploader = uploaderFor("google-cloud-storage", {
			options: {
				bucket: "gcs-bucket",
				keyPrefix: "incoming",
				cacheControl: "private, max-age=30",
			},
			credentials: { oauthToken: "deterministic-oauth-token" },
			fetch,
		});

		const publication = await uploader.upload({
			bytes: encoder.encode("gcs-payload"),
			mimeType: "image/png",
			extension: "png",
			filename: "client image.png",
		});

		expect(requests).toHaveLength(1);
		const upload = requests[0];
		expect(upload.method).toBe("POST");
		expect(upload.url.toString()).toBe(
			"https://storage.googleapis.com/upload/storage/v1/b/gcs-bucket/o?uploadType=multipart",
		);
		expect(upload.headers.get("authorization")).toBe("Bearer deterministic-oauth-token");
		const contentType = upload.headers.get("content-type") ?? "";
		const boundary = contentType.match(/^multipart\/related; boundary=(omp-[0-9a-f-]+)$/)?.[1];
		expect(boundary).toBeDefined();
		const multipart = new TextDecoder().decode(bytesOf(upload.body));
		expect(multipart).toContain(
			JSON.stringify({
				name: "incoming/client image.png",
				contentType: "image/png",
				cacheControl: "private, max-age=30",
			}),
		);
		expect(multipart).toContain("Content-Type: image/png\r\n\r\ngcs-payload");
		expect(multipart.endsWith(`\r\n--${boundary}--\r\n`)).toBeTrue();

		expect(publication).toMatchObject({
			destination: "google-cloud-storage",
			url: "https://storage.googleapis.com/gcs-bucket/stored/server%20object.png",
			remoteId: "stored/server object.png",
			delete: {
				method: "DELETE",
				url: "https://storage.googleapis.com/storage/v1/b/gcs-bucket/o/stored%2Fserver%20object.png",
				headers: { authorization: "Bearer deterministic-oauth-token" },
			},
		});
	});
});

describe("Azure Blob Storage uploader", () => {
	it("uses independently verifiable SharedKey signatures for both BlockBlob PUT and delete", async () => {
		const accountName = "testaccount";
		const accountKey = encoder.encode("0123456789abcdef0123456789abcdef");
		const requests: CapturedRequest[] = [];
		const fetch: FetchImpl = async (input, init) => {
			requests.push(captureRequest(input, init));
			return new Response(null, { status: 201 });
		};
		const uploader = uploaderFor("azure-storage", {
			options: {
				container: "screenshots",
				endpoint: "https://azure.example.test/account-root",
				keyPrefix: "daily",
				publicBaseUrl: "https://cdn.example.test/azure",
				cacheControl: "public, max-age=120",
			},
			credentials: { accountName, accountKey: Buffer.from(accountKey).toString("base64") },
			fetch,
		});

		const publication = await uploader.upload({
			bytes: uploadBytes,
			mimeType: "image/webp",
			extension: "webp",
			filename: "capture.webp",
		});

		expect(requests).toHaveLength(1);
		const put = requests[0];
		expect(put.method).toBe("PUT");
		expect(put.url.toString()).toBe("https://azure.example.test/account-root/screenshots/daily/capture.webp");
		expect(bytesOf(put.body)).toEqual(uploadBytes);
		expect(put.headers.get("x-ms-blob-type")).toBe("BlockBlob");
		expect(put.headers.get("x-ms-version")).toBe("2023-11-03");
		expect(put.headers.get("x-ms-date")).toMatch(/GMT$/);
		expect(put.headers.get("content-length")).toBe(String(uploadBytes.byteLength));
		expect(put.headers.get("content-type")).toBe("image/webp");
		expect(put.headers.get("x-ms-blob-content-type")).toBe("image/webp");
		expect(put.headers.get("x-ms-blob-cache-control")).toBe("public, max-age=120");
		await assertValidAzureSharedKey("PUT", put.url, put.headers, accountName, accountKey);

		expect(publication).toMatchObject({
			destination: "azure-storage",
			url: "https://cdn.example.test/azure/daily/capture.webp",
			remoteId: "daily/capture.webp",
		});
		const deletion = publication.delete;
		expect(deletion).toBeDefined();
		if (!deletion) return;
		expect(deletion.method).toBe("DELETE");
		expect(deletion.url).toBe(put.url.toString());
		const deleteHeaders = new Headers(deletion.headers);
		expect(deleteHeaders.get("x-ms-version")).toBe("2023-11-03");
		expect(deleteHeaders.has("content-length")).toBeFalse();
		await assertValidAzureSharedKey("DELETE", new URL(deletion.url), deleteHeaders, accountName, accountKey);
	});
});

describe("native Backblaze B2 uploader", () => {
	it("completes authorization, bucket discovery, upload-target, upload, and private publication stages without losing delete identity", async () => {
		const requests: CapturedRequest[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const request = captureRequest(input, init);
			requests.push(request);
			switch (request.url.toString()) {
				case "https://auth.example.test/b2_authorize_account":
					return Response.json({
						accountId: "account-id",
						authorizationToken: "account-token",
						apiUrl: "https://api.b2.example.test",
						downloadUrl: "https://download.b2.example.test",
					});
				case "https://api.b2.example.test/b2api/v2/b2_list_buckets":
					return Response.json({
						buckets: [{ bucketId: "bucket-id", bucketName: "photos", bucketType: "allPrivate" }],
					});
				case "https://api.b2.example.test/b2api/v2/b2_get_upload_url":
					return Response.json({
						uploadUrl: "https://upload.b2.example.test/file/photos",
						authorizationToken: "upload-token",
					});
				case "https://upload.b2.example.test/file/photos":
					return Response.json({ fileId: "file-id-123", fileName: "images/cat photo.png" });
				case "https://api.b2.example.test/b2api/v2/b2_get_download_authorization":
					return Response.json({ authorizationToken: "download-token" });
				default:
					throw new Error(`Unexpected Backblaze request: ${request.url}`);
			}
		};
		const uploader = uploaderFor("backblaze-b2", {
			options: {
				bucket: "photos",
				keyPrefix: "images",
				cacheControl: "public, max-age=300",
				authorizeEndpoint: "https://auth.example.test/b2_authorize_account",
			},
			credentials: { applicationKeyId: "application-key-id", applicationKey: "application-key-secret" },
			fetch,
		});
		const beforeUpload = Date.now();
		const publication = await uploader.upload({
			bytes: uploadBytes,
			mimeType: "image/png",
			extension: "png",
			filename: "cat photo.png",
		});
		const afterUpload = Date.now();

		expect(requests).toHaveLength(5);
		const [authorize, listBuckets, getUploadUrl, upload, getDownloadAuthorization] = requests;
		expect(authorize.method).toBe("GET");
		expect(authorize.headers.get("authorization")).toBe(
			`Basic ${Buffer.from("application-key-id:application-key-secret").toString("base64")}`,
		);
		expect(listBuckets.method).toBe("POST");
		expect(listBuckets.headers.get("authorization")).toBe("account-token");
		expect(JSON.parse(new TextDecoder().decode(bytesOf(listBuckets.body)))).toEqual({
			accountId: "account-id",
			bucketName: "photos",
		});
		expect(getUploadUrl.method).toBe("POST");
		expect(getUploadUrl.headers.get("authorization")).toBe("account-token");
		expect(getUploadUrl.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(new TextDecoder().decode(bytesOf(getUploadUrl.body)))).toEqual({ bucketId: "bucket-id" });

		expect(upload.method).toBe("POST");
		expect(upload.headers.get("authorization")).toBe("upload-token");
		expect(upload.headers.get("content-type")).toBe("image/png");
		expect(upload.headers.get("x-bz-file-name")).toBe("images/cat%20photo.png");
		expect(upload.headers.get("x-bz-content-sha1")).toBe(await sha1Hex(uploadBytes));
		expect(upload.headers.get("x-bz-info-b2-cache-control")).toBe("public%2C%20max-age%3D300");
		expect(bytesOf(upload.body)).toEqual(uploadBytes);

		expect(getDownloadAuthorization.method).toBe("POST");
		expect(getDownloadAuthorization.headers.get("authorization")).toBe("account-token");
		expect(JSON.parse(new TextDecoder().decode(bytesOf(getDownloadAuthorization.body)))).toEqual({
			bucketId: "bucket-id",
			fileNamePrefix: "images/cat photo.png",
			validDurationInSeconds: 604800,
		});
		expect(publication).toMatchObject({
			destination: "backblaze-b2",
			bytes: uploadBytes.byteLength,
			url: "https://download.b2.example.test/file/photos/images/cat%20photo.png?Authorization=download-token",
			remoteId: "file-id-123",
		});
		expect(publication.expiresAt).toBeGreaterThanOrEqual(beforeUpload + 604800000);
		expect(publication.expiresAt).toBeLessThanOrEqual(afterUpload + 604800000);
		expect(publication.delete).toEqual({
			method: "POST",
			url: "https://api.b2.example.test/b2api/v2/b2_delete_file_version",
			headers: { authorization: "account-token", "content-type": "application/json" },
			body: JSON.stringify({ fileName: "images/cat photo.png", fileId: "file-id-123" }),
		});
	});
});
