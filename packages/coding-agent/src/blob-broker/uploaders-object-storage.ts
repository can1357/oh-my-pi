import { type AwsCredentials, type SignedHeaders, signRequest } from "@oh-my-pi/pi-ai/providers/aws-sigv4";
import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, RemoteDeleteAction } from "./publication";
import {
	credentialString,
	type DestinationRuntimeConfig,
	expectOk,
	fetchFor,
	fileNameFor,
	optionBoolean,
	optionString,
	publication,
	requireCredential,
	requireOption,
} from "./uploader-runtime";

const EMPTY_BYTES = new Uint8Array();

function toSignedHeaderRecord(signed: SignedHeaders): Record<string, string> {
	const headers: Record<string, string> = {
		host: signed.host,
		"x-amz-date": signed["x-amz-date"],
		"x-amz-content-sha256": signed["x-amz-content-sha256"],
		authorization: signed.authorization,
	};
	if (signed["x-amz-security-token"]) {
		headers["x-amz-security-token"] = signed["x-amz-security-token"];
	}
	return headers;
}
const encoder = new TextEncoder();

const S3_DESTINATIONS: Partial<Record<BlobDestinationId, true>> = {
	"amazon-s3": true,
	r2: true,
	tigris: true,
	minio: true,
	garage: true,
};

interface S3Settings {
	endpoint: string;
	region: string;
	bucket: string;
	pathStyle: boolean;
	publicBaseUrl?: string;
	keyPrefix?: string;
	cacheControl?: string;
}

interface B2Authorization {
	accountId: string;
	authorizationToken: string;
	apiUrl: string;
	downloadUrl: string;
}

interface B2Bucket {
	bucketId: string;
	bucketName: string;
	bucketType: string;
}

interface B2UploadTarget {
	uploadUrl: string;
	authorizationToken: string;
}

function requiredString(config: DestinationRuntimeConfig, key: string): string {
	const value = requireOption(config, key);
	if (typeof value !== "string") throw new Error(`Destination option ${key} must be a string`);
	return value;
}

function configuredPrefix(config: DestinationRuntimeConfig): string | undefined {
	return optionString(config, "keyPrefix") ?? optionString(config, "prefix") ?? optionString(config, "path");
}

function objectKey(prefix: string | undefined, filename: string): string {
	const cleanPrefix = prefix?.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	return cleanPrefix ? `${cleanPrefix}/${filename}` : filename;
}

function encodePath(path: string): string {
	return path
		.split("/")
		.map(segment =>
			encodeURIComponent(segment).replace(
				/[!'()*]/g,
				character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");
}

function decodedPathname(url: URL): string {
	try {
		return decodeURIComponent(url.pathname);
	} catch {
		return url.pathname;
	}
}

function joinPath(...parts: string[]): string {
	const joined = parts
		.map((part, index) => (index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, "")))
		.filter(Boolean)
		.join("/");
	return joined.startsWith("/") ? joined : `/${joined}`;
}

function publicObjectUrl(base: string, key: string): string {
	const url = new URL(base);
	const prefix = url.pathname.replace(/\/+$/g, "");
	url.pathname = `${prefix}/${encodePath(key)}`;
	return url.toString();
}

function requestObjectUrl(settings: S3Settings, key: string): { url: URL; signingPath: string } {
	const url = new URL(settings.endpoint);
	url.search = "";
	url.hash = "";
	const basePath = decodedPathname(url);
	const signingPath = settings.pathStyle ? joinPath(basePath, settings.bucket, key) : joinPath(basePath, key);
	if (!settings.pathStyle) url.hostname = `${settings.bucket}.${url.hostname}`;
	url.pathname = encodePath(signingPath);
	return { url, signingPath };
}

function s3Defaults(destination: BlobDestinationId, config: DestinationRuntimeConfig): Omit<S3Settings, "bucket"> {
	const endpointOption = optionString(config, "endpoint");
	switch (destination) {
		case "amazon-s3": {
			const region = optionString(config, "region", "us-east-1") ?? "us-east-1";
			return {
				endpoint: endpointOption ?? `https://s3.${region}.amazonaws.com`,
				region,
				pathStyle: optionBoolean(config, "pathStyle", false) ?? false,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		}
		case "r2": {
			const accountId = endpointOption ? undefined : requiredString(config, "accountId");
			return {
				endpoint: endpointOption ?? `https://${accountId}.r2.cloudflarestorage.com`,
				region: optionString(config, "region", "auto") ?? "auto",
				pathStyle: optionBoolean(config, "pathStyle", true) ?? true,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		}
		case "tigris":
			return {
				endpoint: endpointOption ?? "https://fly.storage.tigris.dev",
				region: optionString(config, "region", "auto") ?? "auto",
				pathStyle: optionBoolean(config, "pathStyle", false) ?? false,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		case "minio":
			return {
				endpoint: endpointOption ?? requiredString(config, "endpoint"),
				region: optionString(config, "region", "us-east-1") ?? "us-east-1",
				pathStyle: optionBoolean(config, "pathStyle", true) ?? true,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		case "garage":
			return {
				endpoint: endpointOption ?? requiredString(config, "endpoint"),
				region: optionString(config, "region", "garage") ?? "garage",
				pathStyle: optionBoolean(config, "pathStyle", true) ?? true,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		case "backblaze-b2": {
			const region = optionString(config, "region", "us-west-004") ?? "us-west-004";
			return {
				endpoint: endpointOption ?? `https://s3.${region}.backblazeb2.com`,
				region,
				pathStyle: optionBoolean(config, "pathStyle", false) ?? false,
				publicBaseUrl: optionString(config, "publicBaseUrl"),
				keyPrefix: configuredPrefix(config),
				cacheControl: optionString(config, "cacheControl"),
			};
		}
		default:
			throw new Error(`Unsupported S3 destination: ${destination}`);
	}
}

function createS3Uploader(destination: BlobDestinationId, config: DestinationRuntimeConfig): BlobUploader {
	const defaults = s3Defaults(destination, config);
	const settings: S3Settings = { ...defaults, bucket: requiredString(config, "bucket") };
	const sessionToken = credentialString(config, "sessionToken");
	const credentials: AwsCredentials = {
		accessKeyId: requireCredential(config, "accessKeyId"),
		secretAccessKey: requireCredential(config, "secretAccessKey"),
		...(sessionToken ? { sessionToken } : {}),
	};
	const request = fetchFor(config);

	return {
		destination,
		async upload(uploadRequest) {
			const key = objectKey(settings.keyPrefix, fileNameFor(uploadRequest));
			const target = requestObjectUrl(settings, key);
			const requestHeaders: Record<string, string> = { "content-type": uploadRequest.mimeType };
			if (settings.cacheControl) requestHeaders["cache-control"] = settings.cacheControl;
			const signed = await signRequest({
				method: "PUT",
				host: target.url.host,
				path: target.signingPath,
				headers: requestHeaders,
				body: uploadRequest.bytes,
				region: settings.region,
				service: "s3",
				credentials,
			});
			await expectOk(
				await request(target.url, {
					method: "PUT",
					headers: { ...requestHeaders, ...toSignedHeaderRecord(signed) },
					body: uploadRequest.bytes,
				}),
				destination,
			);

			const deleteSigned = await signRequest({
				method: "DELETE",
				host: target.url.host,
				path: target.signingPath,
				body: EMPTY_BYTES,
				region: settings.region,
				service: "s3",
				credentials,
			});
			const deleteAction: RemoteDeleteAction = {
				method: "DELETE",
				url: target.url.toString(),
				headers: toSignedHeaderRecord(deleteSigned),
			};
			const publicUrl = settings.publicBaseUrl
				? publicObjectUrl(settings.publicBaseUrl, key)
				: target.url.toString();
			return publication(destination, uploadRequest, publicUrl, { delete: deleteAction, remoteId: key });
		},
	};
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.byteLength;
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function createGcsUploader(config: DestinationRuntimeConfig): BlobUploader {
	const destination = "google-cloud-storage" as const;
	const bucket = requiredString(config, "bucket");
	const token = requireCredential(config, "oauthToken");
	const prefix = configuredPrefix(config);
	const publicBaseUrl = optionString(config, "publicBaseUrl");
	const cacheControl = optionString(config, "cacheControl");
	const request = fetchFor(config);

	return {
		destination,
		async upload(uploadRequest) {
			const key = objectKey(prefix, fileNameFor(uploadRequest));
			const boundary = `omp-${crypto.randomUUID()}`;
			const metadata: Record<string, string> = { name: key, contentType: uploadRequest.mimeType };
			if (cacheControl) metadata.cacheControl = cacheControl;
			const opening = encoder.encode(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
					`--${boundary}\r\nContent-Type: ${uploadRequest.mimeType}\r\n\r\n`,
			);
			const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
			const body = concatenate([opening, uploadRequest.bytes, closing]);
			const uploadUrl = new URL(
				`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
			);
			uploadUrl.searchParams.set("uploadType", "multipart");
			const response = await expectOk(
				await request(uploadUrl, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": `multipart/related; boundary=${boundary}`,
					},
					body,
				}),
				destination,
			);
			const responseBody: unknown = await response.json();
			const remoteName = optionalStringField(responseBody, "name") ?? key;
			const deleteUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(remoteName)}`;
			const publicUrl = publicBaseUrl
				? publicObjectUrl(publicBaseUrl, remoteName)
				: `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${encodePath(remoteName)}`;
			return publication(destination, uploadRequest, publicUrl, {
				remoteId: remoteName,
				delete: { method: "DELETE", url: deleteUrl, headers: { authorization: `Bearer ${token}` } },
			});
		},
	};
}

function strictBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

async function hmacSha256Base64(key: Uint8Array, value: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey("raw", strictBytes(key), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, strictBytes(encoder.encode(value)));
	return new Uint8Array(signature).toBase64();
}

function azureCanonicalHeaders(headers: Readonly<Record<string, string>>): string {
	return Object.entries(headers)
		.filter(([name]) => name.startsWith("x-ms-"))
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => `${name}:${value}\n`)
		.join("");
}

async function azureHeaders(
	method: "PUT" | "DELETE",
	accountName: string,
	accountKey: Uint8Array,
	resourcePath: string,
	contentLength: number,
	mimeType?: string,
	cacheControl?: string,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		"x-ms-date": new Date().toUTCString(),
		"x-ms-version": "2023-11-03",
	};
	if (method === "PUT") {
		headers["x-ms-blob-type"] = "BlockBlob";
		if (mimeType) {
			headers["content-type"] = mimeType;
			headers["x-ms-blob-content-type"] = mimeType;
		}
		if (cacheControl) headers["x-ms-blob-cache-control"] = cacheControl;
		headers["content-length"] = String(contentLength);
	}
	const stringToSign = [
		method,
		"",
		"",
		contentLength === 0 ? "" : String(contentLength),
		"",
		mimeType ?? "",
		"",
		"",
		"",
		"",
		"",
		"",
		`${azureCanonicalHeaders(headers)}/${accountName}${resourcePath}`,
	].join("\n");
	headers.authorization = `SharedKey ${accountName}:${await hmacSha256Base64(accountKey, stringToSign)}`;
	return headers;
}

function createAzureUploader(config: DestinationRuntimeConfig): BlobUploader {
	const destination = "azure-storage" as const;
	const accountName = requireCredential(config, "accountName");
	const accountKey = Uint8Array.fromBase64(requireCredential(config, "accountKey"));
	const container = requiredString(config, "container");
	const prefix = configuredPrefix(config);
	const cacheControl = optionString(config, "cacheControl");
	const endpoint =
		optionString(config, "endpoint", `https://${accountName}.blob.core.windows.net`) ??
		`https://${accountName}.blob.core.windows.net`;
	const publicBaseUrl = optionString(config, "publicBaseUrl");
	const request = fetchFor(config);

	return {
		destination,
		async upload(uploadRequest) {
			const key = objectKey(prefix, fileNameFor(uploadRequest));
			const url = new URL(endpoint);
			const resourcePath = joinPath(decodedPathname(url), container, key);
			url.pathname = encodePath(resourcePath);
			url.search = "";
			url.hash = "";
			const headers = await azureHeaders(
				"PUT",
				accountName,
				accountKey,
				resourcePath,
				uploadRequest.bytes.byteLength,
				uploadRequest.mimeType,
				cacheControl,
			);
			await expectOk(await request(url, { method: "PUT", headers, body: uploadRequest.bytes }), destination);
			const deleteHeaders = await azureHeaders("DELETE", accountName, accountKey, resourcePath, 0);
			const publicUrl = publicBaseUrl ? publicObjectUrl(publicBaseUrl, key) : url.toString();
			return publication(destination, uploadRequest, publicUrl, {
				remoteId: key,
				delete: { method: "DELETE", url: url.toString(), headers: deleteHeaders },
			});
		},
	};
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} returned an invalid JSON object`);
	}
	return value as Record<string, unknown>;
}

function requiredStringField(value: unknown, field: string, context: string): string {
	const result = asRecord(value, context)[field];
	if (typeof result !== "string" || result.length === 0) throw new Error(`${context} omitted ${field}`);
	return result;
}

function optionalStringField(value: unknown, field: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const result = (value as Record<string, unknown>)[field];
	return typeof result === "string" ? result : undefined;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", strictBytes(bytes)));
	let result = "";
	for (const byte of digest) result += byte.toString(16).padStart(2, "0");
	return result;
}

async function b2Json(
	config: DestinationRuntimeConfig,
	url: string,
	authorization: string,
	body?: Readonly<Record<string, string | number>>,
): Promise<unknown> {
	const response = await expectOk(
		await fetchFor(config)(url, {
			method: body ? "POST" : "GET",
			headers: {
				authorization,
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		}),
		"backblaze-b2",
	);
	return response.json();
}

async function authorizeB2(config: DestinationRuntimeConfig): Promise<B2Authorization> {
	const keyId = requireCredential(config, "applicationKeyId");
	const applicationKey = requireCredential(config, "applicationKey");
	const basic = encoder.encode(`${keyId}:${applicationKey}`).toBase64();
	const value = await b2Json(
		config,
		optionString(config, "authorizeEndpoint", "https://api.backblazeb2.com/b2api/v2/b2_authorize_account") ??
			"https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
		`Basic ${basic}`,
	);
	return {
		accountId: requiredStringField(value, "accountId", "Backblaze B2 authorization"),
		authorizationToken: requiredStringField(value, "authorizationToken", "Backblaze B2 authorization"),
		apiUrl: requiredStringField(value, "apiUrl", "Backblaze B2 authorization"),
		downloadUrl: requiredStringField(value, "downloadUrl", "Backblaze B2 authorization"),
	};
}

async function findB2Bucket(
	config: DestinationRuntimeConfig,
	authorization: B2Authorization,
	bucketName: string,
): Promise<B2Bucket> {
	const value = await b2Json(
		config,
		`${authorization.apiUrl}/b2api/v2/b2_list_buckets`,
		authorization.authorizationToken,
		{ accountId: authorization.accountId, bucketName },
	);
	const buckets = asRecord(value, "Backblaze B2 bucket listing").buckets;
	if (!Array.isArray(buckets)) throw new Error("Backblaze B2 bucket listing omitted buckets");
	for (const candidate of buckets) {
		if (optionalStringField(candidate, "bucketName") !== bucketName) continue;
		return {
			bucketId: requiredStringField(candidate, "bucketId", "Backblaze B2 bucket"),
			bucketName,
			bucketType: requiredStringField(candidate, "bucketType", "Backblaze B2 bucket"),
		};
	}
	throw new Error(`Backblaze B2 bucket not found: ${bucketName}`);
}

async function b2UploadTarget(
	config: DestinationRuntimeConfig,
	authorization: B2Authorization,
	bucketId: string,
): Promise<B2UploadTarget> {
	const value = await b2Json(
		config,
		`${authorization.apiUrl}/b2api/v2/b2_get_upload_url`,
		authorization.authorizationToken,
		{ bucketId },
	);
	return {
		uploadUrl: requiredStringField(value, "uploadUrl", "Backblaze B2 upload URL"),
		authorizationToken: requiredStringField(value, "authorizationToken", "Backblaze B2 upload URL"),
	};
}

async function b2PublicUrl(
	config: DestinationRuntimeConfig,
	authorization: B2Authorization,
	bucket: B2Bucket,
	key: string,
): Promise<{ url: string; expiresAt?: number }> {
	const publicBaseUrl = optionString(config, "publicBaseUrl");
	if (publicBaseUrl) return { url: publicObjectUrl(publicBaseUrl, key) };
	const url = new URL(`${authorization.downloadUrl}/file/${encodeURIComponent(bucket.bucketName)}/${encodePath(key)}`);
	if (bucket.bucketType === "allPublic") return { url: url.toString() };
	const durationSeconds = 7 * 24 * 60 * 60;
	const value = await b2Json(
		config,
		`${authorization.apiUrl}/b2api/v2/b2_get_download_authorization`,
		authorization.authorizationToken,
		{ bucketId: bucket.bucketId, fileNamePrefix: key, validDurationInSeconds: durationSeconds },
	);
	url.searchParams.set(
		"Authorization",
		requiredStringField(value, "authorizationToken", "Backblaze B2 download authorization"),
	);
	return { url: url.toString(), expiresAt: Date.now() + durationSeconds * 1000 };
}

function createNativeB2Uploader(config: DestinationRuntimeConfig): BlobUploader {
	const destination = "backblaze-b2" as const;
	const bucketName = requiredString(config, "bucket");
	const prefix = configuredPrefix(config);
	const cacheControl = optionString(config, "cacheControl");
	const request = fetchFor(config);

	return {
		destination,
		async upload(uploadRequest) {
			const key = objectKey(prefix, fileNameFor(uploadRequest));
			const authorization = await authorizeB2(config);
			const bucket = await findB2Bucket(config, authorization, bucketName);
			const uploadTarget = await b2UploadTarget(config, authorization, bucket.bucketId);
			const response = await expectOk(
				await request(uploadTarget.uploadUrl, {
					method: "POST",
					headers: {
						authorization: uploadTarget.authorizationToken,
						"content-type": uploadRequest.mimeType,
						"x-bz-content-sha1": await sha1Hex(uploadRequest.bytes),
						"x-bz-file-name": encodePath(key),
						...(cacheControl ? { "x-bz-info-b2-cache-control": encodeURIComponent(cacheControl) } : {}),
					},
					body: uploadRequest.bytes,
				}),
				destination,
			);
			const responseBody: unknown = await response.json();
			const fileId = requiredStringField(responseBody, "fileId", "Backblaze B2 upload");
			const uploadedName = optionalStringField(responseBody, "fileName") ?? key;
			const published = await b2PublicUrl(config, authorization, bucket, uploadedName);
			return publication(destination, uploadRequest, published.url, {
				remoteId: fileId,
				expiresAt: published.expiresAt,
				delete: {
					method: "POST",
					url: `${authorization.apiUrl}/b2api/v2/b2_delete_file_version`,
					headers: {
						authorization: authorization.authorizationToken,
						"content-type": "application/json",
					},
					body: JSON.stringify({ fileName: uploadedName, fileId }),
				},
			});
		},
	};
}

/** Create an uploader for an S3-compatible, GCS, Azure Blob, or Backblaze B2 destination. */
export function createObjectStorageUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	if (S3_DESTINATIONS[destination]) return createS3Uploader(destination, config);
	switch (destination) {
		case "google-cloud-storage":
			return createGcsUploader(config);
		case "azure-storage":
			return createAzureUploader(config);
		case "backblaze-b2":
			return credentialString(config, "accessKeyId") || credentialString(config, "secretAccessKey")
				? createS3Uploader(destination, config)
				: createNativeB2Uploader(config);
		default:
			return null;
	}
}
