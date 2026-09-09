import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, BlobUploadRequest } from "./publication";
import {
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	expectOk,
	fetchFor,
	fileNameFor,
	multipartFile,
	optionBoolean,
	optionString,
	publication,
	requireCredential,
} from "./uploader-runtime";

const DROPBOX_CONTENT_API = "https://content.dropboxapi.com/2";
const DROPBOX_API = "https://api.dropboxapi.com/2";
const GRAPH_API = "https://graph.microsoft.com/v1.0";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const PUSHBULLET_API = "https://api.pushbullet.com/v2";
const ONEDRIVE_CHUNK_BYTES = 64 * 1024 * 1024;

type CloudDriveDestination = "dropbox" | "onedrive" | "google-drive" | "box" | "pushbullet";

interface DropboxUploadResponse {
	id?: unknown;
	path_display?: unknown;
}

interface DropboxSharedLink {
	url?: unknown;
}

interface DropboxSharedLinksResponse {
	links?: DropboxSharedLink[];
}

interface OneDriveUploadSession {
	uploadUrl?: unknown;
}

interface OneDriveFile {
	id?: unknown;
}

interface OneDrivePermission {
	link?: {
		webUrl?: unknown;
	};
}

interface GoogleDriveFile {
	id?: unknown;
}

interface BoxUploadResponse {
	entries?: Array<{
		id?: unknown;
	}>;
}

interface BoxSharedFile {
	shared_link?: {
		download_url?: unknown;
	};
}

interface PushbulletUploadRequest {
	file_type?: unknown;
	file_url?: unknown;
	upload_url?: unknown;
	data?: {
		awsaccesskeyid?: unknown;
		acl?: unknown;
		key?: unknown;
		signature?: unknown;
		policy?: unknown;
		"content-type"?: unknown;
	};
}

interface PushbulletPush {
	iden?: unknown;
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} was missing from the destination response`);
	}
	return value;
}

function bearer(token: string): Readonly<Record<string, string>> {
	return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): Readonly<Record<string, string>> {
	return { ...bearer(token), "Content-Type": "application/json" };
}

function expandDropboxPath(template: string, filename: string): string {
	const now = new Date();
	const twoDigits = (value: number): string => value.toString().padStart(2, "0");
	const replacements: Readonly<Record<string, string>> = {
		"%y": now.getFullYear().toString(),
		"%mo": twoDigits(now.getMonth() + 1),
		"%d": twoDigits(now.getDate()),
		"%h": twoDigits(now.getHours()),
		"%mi": twoDigits(now.getMinutes()),
		"%s": twoDigits(now.getSeconds()),
	};
	let folder = template;
	for (const token in replacements) {
		const value = replacements[token];
		if (value !== undefined) folder = folder.replaceAll(token, value);
	}
	folder = folder.replace(/^\/+|\/+$/g, "");
	return `/${folder.length > 0 ? `${folder}/` : ""}${filename}`;
}

function dropboxDirectUrl(sharedUrl: string): string {
	const url = new URL(sharedUrl);
	if (url.hostname !== "dropbox.com" && !url.hostname.endsWith(".dropbox.com")) {
		throw new Error("Dropbox returned an unrecognized shared-link host");
	}
	url.protocol = "https:";
	url.hostname = "dl.dropboxusercontent.com";
	url.searchParams.delete("dl");
	return url.toString();
}

function oneDriveDownloadUrl(embedUrl: string): string {
	const url = new URL(embedUrl);
	if (url.hostname !== "onedrive.live.com" || !url.pathname.endsWith("/embed")) {
		throw new DestinationUnavailableError(
			"onedrive",
			"Microsoft returned an anonymous viewer URL that cannot be converted to a stable direct download URL",
		);
	}
	url.pathname = `${url.pathname.slice(0, -"embed".length)}download`;
	return url.toString();
}

function requireDirectMode(
	destination: CloudDriveDestination,
	config: DestinationRuntimeConfig,
	option: string,
	reason: string,
): void {
	if (!optionBoolean(config, option, true)) throw new DestinationUnavailableError(destination, reason);
}

function createDropboxUploader(config: DestinationRuntimeConfig): BlobUploader {
	requireDirectMode(
		"dropbox",
		config,
		"createShareableLink",
		"Dropbox must create a public shared link for broker uploads",
	);
	requireDirectMode("dropbox", config, "directLink", "Dropbox viewer links are not valid image publications");
	const token = requireCredential(config, "oauthToken");
	const fetchImpl = fetchFor(config);
	const uploadPath = optionString(config, "uploadPath", "ShareX/%y/%mo") ?? "ShareX/%y/%mo";

	return {
		destination: "dropbox",
		async upload(request) {
			const path = expandDropboxPath(uploadPath, fileNameFor(request));
			const uploadedResponse = await expectOk(
				await fetchImpl(`${DROPBOX_CONTENT_API}/files/upload`, {
					method: "POST",
					headers: {
						...bearer(token),
						"Content-Type": "application/octet-stream",
						"Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
					},
					body: request.bytes,
				}),
				"dropbox",
			);
			const uploaded = (await uploadedResponse.json()) as DropboxUploadResponse;
			const remoteId = requiredText(uploaded.id, "Dropbox file id");
			const remotePath = requiredText(uploaded.path_display, "Dropbox file path");

			const createLinkResponse = await fetchImpl(`${DROPBOX_API}/sharing/create_shared_link_with_settings`, {
				method: "POST",
				headers: jsonHeaders(token),
				body: JSON.stringify({ path: remotePath, settings: { requested_visibility: "public" } }),
			});
			let sharedUrl: string;
			if (createLinkResponse.status === 409) {
				const listResponse = await expectOk(
					await fetchImpl(`${DROPBOX_API}/sharing/list_shared_links`, {
						method: "POST",
						headers: jsonHeaders(token),
						body: JSON.stringify({ path: remotePath, direct_only: true }),
					}),
					"dropbox",
				);
				const links = (await listResponse.json()) as DropboxSharedLinksResponse;
				sharedUrl = requiredText(links.links?.[0]?.url, "Dropbox shared link");
			} else {
				await expectOk(createLinkResponse, "dropbox");
				const link = (await createLinkResponse.json()) as DropboxSharedLink;
				sharedUrl = requiredText(link.url, "Dropbox shared link");
			}

			return publication("dropbox", request, dropboxDirectUrl(sharedUrl), {
				remoteId,
				delete: {
					method: "POST",
					url: `${DROPBOX_API}/files/delete_v2`,
					headers: jsonHeaders(token),
					body: JSON.stringify({ path: remotePath }),
				},
			});
		},
	};
}

function createOneDriveUploader(config: DestinationRuntimeConfig): BlobUploader {
	requireDirectMode("onedrive", config, "directLink", "OneDrive viewer links are not valid image publications");
	const token = requireCredential(config, "oauthToken");
	const fetchImpl = fetchFor(config);
	const folderId = optionString(config, "folderId");

	return {
		destination: "onedrive",
		async upload(request) {
			const folderPath = folderId ? `me/drive/items/${encodeURIComponent(folderId)}` : "me/drive/root";
			const sessionResponse = await expectOk(
				await fetchImpl(
					`${GRAPH_API}/${folderPath}:/${encodeURIComponent(fileNameFor(request))}:/createUploadSession`,
					{
						method: "POST",
						headers: jsonHeaders(token),
						body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
					},
				),
				"onedrive",
			);
			const session = (await sessionResponse.json()) as OneDriveUploadSession;
			const uploadUrl = requiredText(session.uploadUrl, "OneDrive upload URL");
			let uploaded: OneDriveFile | undefined;

			for (let start = 0; start < request.bytes.byteLength; start += ONEDRIVE_CHUNK_BYTES) {
				const endExclusive = Math.min(start + ONEDRIVE_CHUNK_BYTES, request.bytes.byteLength);
				const chunkResponse = await fetchImpl(uploadUrl, {
					method: "PUT",
					headers: {
						"Content-Length": (endExclusive - start).toString(),
						"Content-Range": `bytes ${start}-${endExclusive - 1}/${request.bytes.byteLength}`,
					},
					body: request.bytes.subarray(start, endExclusive),
				});
				if (!chunkResponse.ok) {
					await fetchImpl(uploadUrl, { method: "DELETE" });
					await expectOk(chunkResponse, "onedrive");
				}
				if (chunkResponse.status !== 202) uploaded = (await chunkResponse.json()) as OneDriveFile;
			}
			const remoteId = requiredText(uploaded?.id, "OneDrive file id");
			const permissionResponse = await expectOk(
				await fetchImpl(`${GRAPH_API}/me/drive/items/${encodeURIComponent(remoteId)}/createLink`, {
					method: "POST",
					headers: jsonHeaders(token),
					body: JSON.stringify({ type: "embed", scope: "anonymous" }),
				}),
				"onedrive",
			);
			const permission = (await permissionResponse.json()) as OneDrivePermission;
			const embedUrl = requiredText(permission.link?.webUrl, "OneDrive anonymous embed URL");

			return publication("onedrive", request, oneDriveDownloadUrl(embedUrl), {
				remoteId,
				delete: {
					method: "DELETE",
					url: `${GRAPH_API}/me/drive/items/${encodeURIComponent(remoteId)}`,
					headers: bearer(token),
				},
			});
		},
	};
}

function createGoogleDriveUploader(config: DestinationRuntimeConfig): BlobUploader {
	requireDirectMode("google-drive", config, "public", "Google Drive files must be public for broker uploads");
	const token = requireCredential(config, "oauthToken");
	const fetchImpl = fetchFor(config);
	const folderId = optionString(config, "folderId");

	return {
		destination: "google-drive",
		async upload(request) {
			const boundary = `omp-${crypto.randomUUID()}`;
			const metadata: { name: string; parents?: string[] } = { name: fileNameFor(request) };
			if (folderId) metadata.parents = [folderId];
			const body = new Blob([
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
				`--${boundary}\r\nContent-Type: ${request.mimeType}\r\n\r\n`,
				request.bytes,
				`\r\n--${boundary}--\r\n`,
			]);
			const uploadResponse = await expectOk(
				await fetchImpl(
					`${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink,webContentLink&supportsAllDrives=true`,
					{
						method: "POST",
						headers: { ...bearer(token), "Content-Type": `multipart/related; boundary=${boundary}` },
						body,
					},
				),
				"google-drive",
			);
			const uploaded = (await uploadResponse.json()) as GoogleDriveFile;
			const remoteId = requiredText(uploaded.id, "Google Drive file id");
			await expectOk(
				await fetchImpl(
					`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(remoteId)}/permissions?supportsAllDrives=true`,
					{
						method: "POST",
						headers: jsonHeaders(token),
						body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false }),
					},
				),
				"google-drive",
			);

			return publication("google-drive", request, `https://drive.google.com/uc?id=${encodeURIComponent(remoteId)}`, {
				remoteId,
				delete: {
					method: "DELETE",
					url: `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(remoteId)}?supportsAllDrives=true`,
					headers: bearer(token),
				},
			});
		},
	};
}

function createBoxUploader(config: DestinationRuntimeConfig): BlobUploader {
	requireDirectMode("box", config, "directLink", "Box viewer links are not valid image publications");
	const shareAccess = optionString(config, "shareAccess", "open") ?? "open";
	if (shareAccess !== "open") {
		throw new DestinationUnavailableError(
			"box",
			"Box company and collaborator links are not anonymous direct publications",
		);
	}
	const token = requireCredential(config, "oauthToken");
	const fetchImpl = fetchFor(config);
	const folderId = optionString(config, "folderId", "0") ?? "0";

	return {
		destination: "box",
		async upload(request) {
			const uploadResponse = await expectOk(
				await fetchImpl(`${BOX_UPLOAD_API}/files/content`, {
					method: "POST",
					headers: bearer(token),
					body: multipartFile(request, "filename", { parent_id: folderId }),
				}),
				"box",
			);
			const uploaded = (await uploadResponse.json()) as BoxUploadResponse;
			const remoteId = requiredText(uploaded.entries?.[0]?.id, "Box file id");
			const shareResponse = await expectOk(
				await fetchImpl(`${BOX_API}/files/${encodeURIComponent(remoteId)}`, {
					method: "PUT",
					headers: jsonHeaders(token),
					body: JSON.stringify({ shared_link: { access: "open" } }),
				}),
				"box",
			);
			const shared = (await shareResponse.json()) as BoxSharedFile;
			const directUrl = requiredText(shared.shared_link?.download_url, "Box direct shared-link download URL");

			return publication("box", request, directUrl, {
				remoteId,
				delete: {
					method: "DELETE",
					url: `${BOX_API}/files/${encodeURIComponent(remoteId)}`,
					headers: bearer(token),
				},
			});
		},
	};
}

function createPushbulletUploader(config: DestinationRuntimeConfig): BlobUploader {
	const apiKey = requireCredential(config, "apiKey");
	const fetchImpl = fetchFor(config);
	const deviceId = optionString(config, "deviceId");
	const authHeaders = { Authorization: `Basic ${btoa(`${apiKey}:`)}` };

	return {
		destination: "pushbullet",
		async upload(request: BlobUploadRequest) {
			const filename = fileNameFor(request);
			const requestForm = new FormData();
			requestForm.set("file_name", filename);
			const uploadRequestResponse = await expectOk(
				await fetchImpl(`${PUSHBULLET_API}/upload-request`, {
					method: "POST",
					headers: authHeaders,
					body: requestForm,
				}),
				"pushbullet",
			);
			const uploadRequest = (await uploadRequestResponse.json()) as PushbulletUploadRequest;
			const data = uploadRequest.data;
			if (!data) throw new Error("Pushbullet upload fields were missing from the destination response");
			const fileUrl = requiredText(uploadRequest.file_url, "Pushbullet file URL");
			const fileType = requiredText(uploadRequest.file_type, "Pushbullet file type");
			const uploadUrl = requiredText(uploadRequest.upload_url, "Pushbullet presigned upload URL");
			const uploadFields = {
				awsaccesskeyid: requiredText(data.awsaccesskeyid, "Pushbullet AWS access key id"),
				acl: requiredText(data.acl, "Pushbullet upload ACL"),
				key: requiredText(data.key, "Pushbullet upload key"),
				signature: requiredText(data.signature, "Pushbullet upload signature"),
				policy: requiredText(data.policy, "Pushbullet upload policy"),
				"content-type": requiredText(data["content-type"], "Pushbullet upload content type"),
			};
			await expectOk(
				await fetchImpl(uploadUrl, {
					method: "POST",
					body: multipartFile(request, "file", uploadFields),
				}),
				"pushbullet",
			);

			const pushForm = new FormData();
			pushForm.set("file_name", filename);
			if (deviceId) pushForm.set("device_iden", deviceId);
			pushForm.set("type", "file");
			pushForm.set("file_url", fileUrl);
			pushForm.set("body", "Sent via Oh My Pi");
			pushForm.set("file_type", fileType);
			const pushResponse = await expectOk(
				await fetchImpl(`${PUSHBULLET_API}/pushes`, {
					method: "POST",
					headers: authHeaders,
					body: pushForm,
				}),
				"pushbullet",
			);
			const push = (await pushResponse.json()) as PushbulletPush;
			const remoteId = requiredText(push.iden, "Pushbullet push id");
			return publication("pushbullet", request, fileUrl, { remoteId });
		},
	};
}

/** Create the built-in uploader for a cloud-drive destination, or null for another family. */
export function createCloudDriveUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	switch (destination) {
		case "dropbox":
			return createDropboxUploader(config);
		case "onedrive":
			return createOneDriveUploader(config);
		case "google-drive":
			return createGoogleDriveUploader(config);
		case "box":
			return createBoxUploader(config);
		case "pushbullet":
			return createPushbulletUploader(config);
		default:
			return null;
	}
}
