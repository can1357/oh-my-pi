import * as path from "node:path";
import { getSafeProjectCwd } from "@oh-my-pi/pi-utils";
import { writeRemoteFile } from "../ssh/file-transfer";
import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, BlobUploadRequest, RemoteDeleteAction } from "./publication";
import {
	credentialString,
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	expectOk,
	fetchFor,
	fileNameFor,
	multipartFile,
	optionBoolean,
	optionNumber,
	optionString,
	publication,
	requireCredential,
	requireOption,
} from "./uploader-runtime";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface OwnCloudShare {
	statusCode: unknown;
	url: string;
	id?: string;
}

interface PlikUpload {
	id: string;
	uploadToken: string;
	downloadBase?: string;
}

interface PlikFile {
	id: string;
	name?: string;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifier(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function ownCloudShare(value: unknown): OwnCloudShare {
	if (typeof value !== "object" || value === null || !("ocs" in value)) {
		throw new Error("owncloud share response did not include an OCS envelope");
	}
	const ocs = value.ocs;
	if (typeof ocs !== "object" || ocs === null || !("meta" in ocs) || !("data" in ocs)) {
		throw new Error("owncloud share response did not include OCS metadata and data");
	}
	const meta = ocs.meta;
	const data = ocs.data;
	if (typeof meta !== "object" || meta === null || !("statuscode" in meta)) {
		throw new Error("owncloud share response did not include an OCS status");
	}
	if (typeof data !== "object" || data === null || !("url" in data)) {
		throw new Error("owncloud share response did not include a URL");
	}
	const url = nonEmptyString(data.url);
	if (!url) throw new Error("owncloud share response did not include a URL");
	const id = "id" in data ? identifier(data.id) : undefined;
	return { statusCode: meta.statuscode, url, ...(id ? { id } : {}) };
}

function plikUpload(value: unknown): PlikUpload {
	if (typeof value !== "object" || value === null || !("id" in value) || !("uploadToken" in value)) {
		throw new Error("plik upload metadata did not include an id and upload token");
	}
	const id = identifier(value.id);
	const uploadToken = nonEmptyString(value.uploadToken);
	if (!id || !uploadToken) throw new Error("plik upload metadata did not include an id and upload token");
	let downloadBase: string | undefined;
	if ("downloadURL" in value) downloadBase = nonEmptyString(value.downloadURL);
	if (!downloadBase && "downloadDomain" in value) downloadBase = nonEmptyString(value.downloadDomain);
	return { id, uploadToken, ...(downloadBase ? { downloadBase } : {}) };
}

function requiredStringOption(config: DestinationRuntimeConfig, key: string): string {
	const value = requireOption(config, key);
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Destination option ${key} must be a non-empty string`);
	}
	return value.trim();
}

function pathParts(value: string | undefined): string[] {
	if (!value) return [];
	const parts = value.replaceAll("\\", "/").split("/");
	const result: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === ".." || part.includes("\0"))
			throw new Error("Destination paths cannot contain parent traversal or NUL bytes");
		result.push(part);
	}
	return result;
}

function safeFileName(request: BlobUploadRequest): string {
	const name = fileNameFor(request);
	if (name.includes("\0") || name === "." || name === "..") throw new Error("Upload filename is invalid");
	return name;
}

function remotePath(directory: string | undefined, filename: string): string {
	const absolute = directory?.replaceAll("\\", "/").startsWith("/") ?? false;
	const joined = [...pathParts(directory), filename].join("/");
	return absolute ? `/${joined}` : joined;
}

function encodedPath(parts: readonly string[]): string {
	return parts.map(part => encodeURIComponent(part)).join("/");
}

function endpoint(base: string, ...parts: string[]): string {
	const url = new URL(base);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodedPath(parts)}`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

function httpBase(value: string, optionName: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Destination option ${optionName} must be an absolute HTTP URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Destination option ${optionName} must use http or https`);
	}
	return url;
}

function publicUrl(baseValue: string, directory: string | undefined, filename: string): string {
	const url = httpBase(baseValue, "publicBaseUrl");
	const relative = encodedPath([...pathParts(directory), filename]);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${relative}`;
	url.hash = "";
	return url.toString();
}

function basicAuthorization(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function expiry(days: number | undefined): { expiresAt?: number; expireDate?: string } {
	if (days === undefined || days <= 0) return {};
	const expiresAt = Date.now() + days * DAY_MS;
	return { expiresAt, expireDate: new Date(expiresAt).toISOString().slice(0, 10) };
}

function errorCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return error.code;
}

function ftpUploadUrl(protocol: "ftp" | "ftps", host: string, port: number, destinationPath: string): string {
	const implicitTls = protocol === "ftps" && port === 990;
	const scheme = implicitTls ? "ftps" : "ftp";
	const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	const url = new URL(`${scheme}://${bracketedHost}`);
	url.port = String(port);
	url.pathname = `/${encodedPath(pathParts(destinationPath))}`;
	return url.toString();
}

function createFtpUploader(config: DestinationRuntimeConfig): BlobUploader {
	const protocol = optionString(config, "protocol", "sftp");
	if (protocol !== "ftp" && protocol !== "ftps" && protocol !== "sftp") {
		throw new Error("Destination option protocol must be ftp, ftps, or sftp");
	}
	const host = requiredStringOption(config, "host");
	const username = requireCredential(config, "username");
	const directory = optionString(config, "path");
	const publicBase = requiredStringOption(config, "publicBaseUrl");
	httpBase(publicBase, "publicBaseUrl");

	if (protocol === "sftp") {
		const port = optionNumber(config, "port", 22) ?? 22;
		const keyPath = credentialString(config, "privateKey");
		const password = credentialString(config, "password");
		if (password && !keyPath) {
			throw new DestinationUnavailableError(
				"ftp",
				"SFTP password injection is unsupported by the shared SSH transport; configure a private-key path or SSH agent",
			);
		}
		if (keyPath?.includes("-----BEGIN")) {
			throw new DestinationUnavailableError(
				"ftp",
				"the SFTP privateKey credential must be a filesystem path, not key contents",
			);
		}
		const connectionName = `blob-${username}-${host}-${port}`.replace(/[^A-Za-z0-9._-]/g, "-");
		return {
			destination: "ftp",
			async upload(request) {
				const filename = safeFileName(request);
				await writeRemoteFile(
					{ name: connectionName, host, username, port, ...(keyPath ? { keyPath } : {}) },
					remotePath(directory, filename),
					request.bytes,
					{},
				);
				return publication("ftp", request, publicUrl(publicBase, directory, filename));
			},
		};
	}

	const binary = optionString(config, "commandBinary");
	if (!binary) {
		throw new DestinationUnavailableError(
			"ftp",
			`${protocol.toUpperCase()} requires options.commandBinary pointing to curl`,
		);
	}
	const password = credentialString(config, "password") ?? "";
	const port = optionNumber(config, "port", 21) ?? 21;
	return {
		destination: "ftp",
		async upload(request) {
			const filename = safeFileName(request);
			const destinationPath = remotePath(directory, filename);
			const args = [
				binary,
				"--fail",
				"--silent",
				"--show-error",
				"--ftp-create-dirs",
				"--upload-file",
				"-",
				"--user",
				`${username}:${password}`,
			];
			if (protocol === "ftps" && port !== 990) args.push("--ssl-reqd");
			args.push(ftpUploadUrl(protocol, host, port, destinationPath));
			try {
				const process = Bun.spawn(args, {
					stdin: request.bytes,
					stdout: "ignore",
					stderr: "pipe",
					cwd: getSafeProjectCwd(),
				});
				const stderr = await new Response(process.stderr as ReadableStream<Uint8Array>).text();
				const exitCode = await process.exited;
				if (exitCode !== 0) {
					throw new Error(
						`${protocol.toUpperCase()} upload command exited with code ${exitCode}: ${stderr.trim().slice(-300)}`,
					);
				}
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					throw new DestinationUnavailableError("ftp", "the configured command binary does not exist");
				}
				throw error;
			}
			return publication("ftp", request, publicUrl(publicBase, directory, filename));
		},
	};
}

function createSharedFolderUploader(config: DestinationRuntimeConfig): BlobUploader {
	const root = path.resolve(requiredStringOption(config, "root"));
	const directory = optionString(config, "path");
	const publicBase = requiredStringOption(config, "publicBaseUrl");
	httpBase(publicBase, "publicBaseUrl");
	return {
		destination: "shared-folder",
		async upload(request) {
			const filename = safeFileName(request);
			const target = path.resolve(root, ...pathParts(directory), filename);
			if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
				throw new Error("Shared-folder destination escapes its configured root");
			}
			await Bun.write(target, request.bytes, { createPath: true });
			return publication("shared-folder", request, publicUrl(publicBase, directory, filename));
		},
	};
}

function createOwnCloudUploader(config: DestinationRuntimeConfig): BlobUploader {
	const host = httpBase(requiredStringOption(config, "host"), "host").toString().replace(/\/$/, "");
	const username = requireCredential(config, "username");
	const password = requireCredential(config, "password");
	const directory = optionString(config, "path");
	const direct = optionBoolean(config, "directLink", true) ?? true;
	const preview = optionBoolean(config, "previewLink", false) ?? false;
	const expiryDays = optionNumber(config, "expiryDays");
	const authorization = basicAuthorization(username, password);
	const requestHeaders = { Authorization: authorization, "OCS-APIREQUEST": "true" };
	const requestFetch = fetchFor(config);

	return {
		destination: "owncloud",
		async upload(request) {
			const filename = safeFileName(request);
			const expiryInfo = expiry(expiryDays);
			const parts = [...pathParts(directory), filename];
			const davUrl = endpoint(host, "remote.php", "webdav", ...parts);
			await expectOk(
				await requestFetch(davUrl, {
					method: "PUT",
					headers: { ...requestHeaders, "Content-Type": request.mimeType },
					body: request.bytes,
				}),
				"owncloud",
			);

			const shareForm = new FormData();
			shareForm.append("path", `/${parts.join("/")}`);
			shareForm.append("shareType", "3");
			shareForm.append("permissions", "1");
			if (expiryInfo.expireDate) shareForm.append("expireDate", expiryInfo.expireDate);
			const shareResponse = await expectOk(
				await requestFetch(
					`${endpoint(host, "ocs", "v1.php", "apps", "files_sharing", "api", "v1", "shares")}?format=json`,
					{
						method: "POST",
						headers: requestHeaders,
						body: shareForm,
					},
				),
				"owncloud",
			);
			const share = ownCloudShare(await shareResponse.json());
			if (share.statusCode !== 100 && share.statusCode !== "100") {
				throw new Error("owncloud share creation returned an unsuccessful OCS status");
			}
			const url = preview
				? `${share.url.replace(/\/$/, "")}/preview`
				: direct
					? `${share.url.replace(/\/$/, "")}/download`
					: share.url;
			const shareId = share.id;
			const deleteAction: RemoteDeleteAction | undefined = shareId
				? {
						method: "DELETE",
						url: endpoint(host, "ocs", "v1.php", "apps", "files_sharing", "api", "v1", "shares", shareId),
						headers: requestHeaders,
					}
				: undefined;
			return publication("owncloud", request, url, {
				...(expiryInfo.expiresAt === undefined ? {} : { expiresAt: expiryInfo.expiresAt }),
				...(deleteAction ? { delete: deleteAction } : {}),
				...(shareId ? { remoteId: shareId } : {}),
			});
		},
	};
}

function parseJsonText(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		return text.trim();
	}
}

function uploadLink(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value !== "object" || value === null) return undefined;
	if ("url" in value && nonEmptyString(value.url)) return nonEmptyString(value.url);
	if ("upload_link" in value && nonEmptyString(value.upload_link)) return nonEmptyString(value.upload_link);
	return "uploadLink" in value ? nonEmptyString(value.uploadLink) : undefined;
}

function shareLink(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value !== "object" || value === null) return undefined;
	if ("url" in value && nonEmptyString(value.url)) return nonEmptyString(value.url);
	return "link" in value ? nonEmptyString(value.link) : undefined;
}

function createSeafileUploader(config: DestinationRuntimeConfig): BlobUploader {
	const apiUrl = httpBase(requiredStringOption(config, "apiUrl"), "apiUrl").toString().replace(/\/$/, "");
	const repositoryId = requiredStringOption(config, "repositoryId");
	const directoryParts = pathParts(optionString(config, "path"));
	const directory = `/${directoryParts.join("/")}`;
	const token = requireCredential(config, "authToken");
	const headers = { Authorization: `Token ${token}` };
	const raw = optionBoolean(config, "raw", true) ?? true;
	const expiryDays = optionNumber(config, "expiryDays");
	const sharePassword = credentialString(config, "sharePassword");
	const requestFetch = fetchFor(config);

	return {
		destination: "seafile",
		async upload(request) {
			const filename = safeFileName(request);
			const expiryInfo = expiry(expiryDays);
			const linkResponse = await expectOk(
				await requestFetch(`${endpoint(apiUrl, "repos", repositoryId, "upload-link")}/?format=json`, { headers }),
				"seafile",
			);
			const linkBody = parseJsonText(await linkResponse.text());
			const fileServerUrl = uploadLink(linkBody);
			if (!fileServerUrl) throw new Error("seafile upload-link response did not include a URL");
			await expectOk(
				await requestFetch(fileServerUrl, {
					method: "POST",
					headers,
					body: multipartFile(request, "file", { filename, parent_dir: directory || "/" }),
				}),
				"seafile",
			);

			const shareForm = new URLSearchParams({
				p: `${directory === "/" ? "" : directory}/${filename}`,
				share_type: "download",
			});
			if (sharePassword) shareForm.set("password", sharePassword);
			if (expiryDays !== undefined && expiryDays > 0) shareForm.set("expire", String(expiryDays));
			const shareResponse = await expectOk(
				await requestFetch(`${endpoint(apiUrl, "repos", repositoryId, "file", "shared-link")}/`, {
					method: "PUT",
					headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
					body: shareForm,
					redirect: "manual",
				}),
				"seafile",
			);
			let location = shareResponse.headers.get("Location") ?? undefined;
			if (!location) location = shareLink(parseJsonText(await shareResponse.text()));
			if (!location) throw new Error("seafile share response did not include a Location URL");
			const resultUrl = new URL(location, apiUrl);
			if (raw) resultUrl.searchParams.set("raw", "1");
			return publication("seafile", request, resultUrl.toString(), {
				...(expiryInfo.expiresAt === undefined ? {} : { expiresAt: expiryInfo.expiresAt }),
			});
		},
	};
}

function plikFile(value: unknown): PlikFile | undefined {
	let candidate: unknown = value;
	if (Array.isArray(candidate)) candidate = candidate[0];
	if (typeof candidate === "object" && candidate !== null && "file" in candidate) candidate = candidate.file;
	if (typeof candidate !== "object" || candidate === null || !("id" in candidate)) return undefined;
	const id = identifier(candidate.id);
	if (!id) return undefined;
	const name =
		"fileName" in candidate
			? nonEmptyString(candidate.fileName)
			: "name" in candidate
				? nonEmptyString(candidate.name)
				: undefined;
	return { id, ...(name ? { name } : {}) };
}

function createPlikUploader(config: DestinationRuntimeConfig): BlobUploader {
	const base = httpBase(requiredStringOption(config, "endpoint"), "endpoint").toString().replace(/\/$/, "");
	const ttlSeconds = optionNumber(config, "ttlSeconds");
	const removable = optionBoolean(config, "removable", true) ?? true;
	const apiKey = credentialString(config, "apiKey");
	const requestFetch = fetchFor(config);

	return {
		destination: "plik",
		async upload(request) {
			const filename = safeFileName(request);
			const headers = new Headers({ "Content-Type": "application/json" });
			if (apiKey) headers.set("X-PlikToken", apiKey);
			const metadataResponse = await expectOk(
				await requestFetch(endpoint(base, "upload"), {
					method: "POST",
					headers,
					body: JSON.stringify({
						...(ttlSeconds === undefined ? {} : { ttl: ttlSeconds }),
						oneShot: false,
						removable,
					}),
				}),
				"plik",
			);
			const metadata = plikUpload(await metadataResponse.json());
			const uploadId = metadata.id;
			const uploadToken = metadata.uploadToken;
			const fileResponse = await expectOk(
				await requestFetch(endpoint(base, "file", uploadId), {
					method: "POST",
					headers: { "X-UploadToken": uploadToken },
					body: multipartFile(request),
				}),
				"plik",
			);
			const fileBody: unknown = await fileResponse.json();
			const file = plikFile(fileBody);
			if (!file) throw new Error("plik file response did not include an id");
			const fileId = file.id;
			const remoteName = file.name ?? filename;
			const downloadBase = metadata.downloadBase ?? base;
			const url = endpoint(downloadBase, "file", uploadId, fileId, remoteName);
			const deleteAction: RemoteDeleteAction = {
				method: "DELETE",
				url: endpoint(base, "upload", uploadId),
				headers: { "X-UploadToken": uploadToken },
			};
			const expiresAt = ttlSeconds !== undefined && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1_000 : undefined;
			return publication("plik", request, url, {
				...(expiresAt === undefined ? {} : { expiresAt }),
				delete: deleteAction,
				remoteId: uploadId,
			});
		},
	};
}

/** Create an uploader for the built-in self-hosted and filesystem destination family. */
export function createSelfHostedUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	switch (destination) {
		case "ftp":
			return createFtpUploader(config);
		case "shared-folder":
			return createSharedFolderUploader(config);
		case "owncloud":
			return createOwnCloudUploader(config);
		case "seafile":
			return createSeafileUploader(config);
		case "plik":
			return createPlikUploader(config);
		default:
			return null;
	}
}
