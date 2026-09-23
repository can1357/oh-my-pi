import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BlobDestinationId } from "../src/blob-broker/destinations";
import type { BlobUploader, BlobUploadRequest } from "../src/blob-broker/publication";
import {
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	type FetchImpl,
} from "../src/blob-broker/uploader-runtime";
import { createLegacyUploader } from "../src/blob-broker/uploaders-legacy";
import { createSelfHostedUploader } from "../src/blob-broker/uploaders-self-hosted";

const DAY_MS = 24 * 60 * 60 * 1_000;
const request: BlobUploadRequest = {
	bytes: new TextEncoder().encode("image-payload"),
	mimeType: "image/png",
	extension: "png",
	filename: "a b.png",
};

function configured(
	options: DestinationRuntimeConfig["options"] = {},
	credentials: DestinationRuntimeConfig["credentials"] = {},
	fetch?: FetchImpl,
): DestinationRuntimeConfig {
	return { options, credentials, ...(fetch ? { fetch } : {}) };
}

function requiredUploader(uploader: BlobUploader | null): BlobUploader {
	if (!uploader) throw new Error("expected factory to handle destination");
	return uploader;
}

function urlOf(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function headersOf(init?: RequestInit): Headers {
	return new Headers(init?.headers);
}

function formOf(init?: RequestInit): FormData {
	if (!(init?.body instanceof FormData)) throw new Error("expected multipart form body");
	return init.body;
}

async function expectFile(form: FormData, field: string, name = request.filename): Promise<void> {
	if (!name) throw new Error("expected filename to be defined");
	const value = form.get(field);
	expect(value).toBeInstanceOf(File);
	const file = value as File;
	expect(file.name).toBe(name);
	expect(file.type).toBe(request.mimeType);
	expect(await file.text()).toBe("image-payload");
}

describe("self-hosted uploader wire contracts", () => {
	it("rejects unsupported SFTP password injection before invoking any transport", () => {
		let fetches = 0;
		expect(() => {
			createSelfHostedUploader(
				"ftp",
				configured(
					{ protocol: "sftp", host: "sftp.test", publicBaseUrl: "https://cdn.test/files" },
					{ username: "alice", password: "secret" },
					async () => {
						fetches++;
						throw new Error("fetch must not run");
					},
				),
			);
		}).toThrow(DestinationUnavailableError);
		expect(fetches).toBe(0);
	});

	it("does not corrupt FTP command stdin or mis-map the remote path to its public URL", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ftp-uploader-"));
		try {
			const executable = path.join(temp, "fake-curl");
			const argsFile = path.join(temp, "args");
			const bodyFile = path.join(temp, "body");
			fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${bodyFile}'\n`);
			fs.chmodSync(executable, 0o755);
			const uploader = requiredUploader(
				createSelfHostedUploader(
					"ftp",
					configured(
						{
							protocol: "ftp",
							host: "upload.test",
							port: 2121,
							path: "/folder/sub",
							publicBaseUrl: "https://cdn.test/assets/",
							commandBinary: executable,
						},
						{ username: "alice", password: "p@ss" },
					),
				),
			);

			const publication = await uploader.upload(request);
			expect(publication).toEqual({
				url: "https://cdn.test/assets/folder/sub/a%20b.png",
				destination: "ftp",
				bytes: request.bytes.byteLength,
			});
			expect(fs.readFileSync(bodyFile, "utf8")).toBe("image-payload");
			expect(fs.readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
				"--fail",
				"--silent",
				"--show-error",
				"--ftp-create-dirs",
				"--upload-file",
				"-",
				"--user",
				"alice:p@ss",
				"ftp://upload.test:2121/folder/sub/a%20b.png",
			]);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	it("does not mis-map an encoded shared-folder path or write outside its configured subtree", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shared-uploader-"));
		try {
			const uploader = requiredUploader(
				createSelfHostedUploader(
					"shared-folder",
					configured({ root, path: "captures/today", publicBaseUrl: "https://static.test/pub" }),
				),
			);
			const publication = await uploader.upload(request);
			expect(await Bun.file(path.join(root, "captures", "today", "a b.png")).text()).toBe("image-payload");
			expect(publication).toEqual({
				url: "https://static.test/pub/captures/today/a%20b.png",
				destination: "shared-folder",
				bytes: request.bytes.byteLength,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not omit ownCloud WebDAV auth, OCS direct sharing, expiry, or deletion metadata", async () => {
		let calls = 0;
		let shareForm: FormData | undefined;
		const authorization = `Basic ${Buffer.from("alice:secret").toString("base64")}`;
		const fetch: FetchImpl = async (input, init) => {
			calls++;
			const url = urlOf(input);
			if (calls === 1) {
				expect(url).toBe("https://cloud.test/base/remote.php/webdav/screens/a%20b.png");
				expect(init?.method).toBe("PUT");
				expect(headersOf(init).get("authorization")).toBe(authorization);
				expect(headersOf(init).get("ocs-apirequest")).toBe("true");
				expect(headersOf(init).get("content-type")).toBe("image/png");
				expect(init?.body).toEqual(request.bytes);
				return new Response(null, { status: 201 });
			}
			expect(url).toBe("https://cloud.test/base/ocs/v1.php/apps/files_sharing/api/v1/shares?format=json");
			expect(init?.method).toBe("POST");
			expect(headersOf(init).get("authorization")).toBe(authorization);
			expect(headersOf(init).get("ocs-apirequest")).toBe("true");
			shareForm = formOf(init);
			return Response.json({
				ocs: { meta: { statuscode: 100 }, data: { id: 42, url: "https://cloud.test/s/share/" } },
			});
		};
		const uploader = requiredUploader(
			createSelfHostedUploader(
				"owncloud",
				configured(
					{ host: "https://cloud.test/base/", path: "screens", expiryDays: 3 },
					{ username: "alice", password: "secret" },
					fetch,
				),
			),
		);
		const before = Date.now();
		const publication = await uploader.upload(request);
		const after = Date.now();

		expect(calls).toBe(2);
		expect(shareForm?.get("path")).toBe("/screens/a b.png");
		expect(shareForm?.get("shareType")).toBe("3");
		expect(shareForm?.get("permissions")).toBe("1");
		expect(shareForm?.get("expireDate")).toBe(new Date(publication.expiresAt ?? 0).toISOString().slice(0, 10));
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 3 * DAY_MS);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 3 * DAY_MS);
		expect(publication).toMatchObject({
			url: "https://cloud.test/s/share/download",
			destination: "owncloud",
			bytes: request.bytes.byteLength,
			remoteId: "42",
			delete: {
				method: "DELETE",
				url: "https://cloud.test/base/ocs/v1.php/apps/files_sharing/api/v1/shares/42",
				headers: { Authorization: authorization, "OCS-APIREQUEST": "true" },
			},
		});
	});

	it("does not drop Seafile token, upload-link, share fields, expiry, or raw-link semantics", async () => {
		let calls = 0;
		const fetch: FetchImpl = async (input, init) => {
			calls++;
			const url = urlOf(input);
			expect(headersOf(init).get("authorization")).toBe("Token auth-token");
			if (calls === 1) {
				expect(url).toBe("https://sea.test/api/repos/repo%201/upload-link/?format=json");
				expect(init?.method).toBeUndefined();
				return Response.json({ upload_link: "https://files.test/upload/target" });
			}
			if (calls === 2) {
				expect(url).toBe("https://files.test/upload/target");
				expect(init?.method).toBe("POST");
				const form = formOf(init);
				expect(form.get("parent_dir")).toBe("/screens");
				await expectFile(form, "file");
				return new Response(null, { status: 200 });
			}
			expect(url).toBe("https://sea.test/api/repos/repo%201/file/shared-link/");
			expect(init?.method).toBe("PUT");
			expect(init?.redirect).toBe("manual");
			expect(headersOf(init).get("content-type")).toBe("application/x-www-form-urlencoded");
			expect(init?.body).toBeInstanceOf(URLSearchParams);
			const form = init?.body as URLSearchParams;
			expect(Object.fromEntries(form)).toEqual({
				p: "/screens/a b.png",
				share_type: "download",
				password: "share-secret",
				expire: "2",
			});
			return new Response(null, { headers: { Location: "https://share.test/s/abc?download=1" } });
		};
		const uploader = requiredUploader(
			createSelfHostedUploader(
				"seafile",
				configured(
					{ apiUrl: "https://sea.test/api/", repositoryId: "repo 1", path: "screens", expiryDays: 2 },
					{ authToken: "auth-token", sharePassword: "share-secret" },
					fetch,
				),
			),
		);
		const before = Date.now();
		const publication = await uploader.upload(request);
		const after = Date.now();
		expect(calls).toBe(3);
		expect(publication.url).toBe("https://share.test/s/abc?download=1&raw=1");
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 2 * DAY_MS);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 2 * DAY_MS);
		expect(publication.delete).toBeUndefined();
		expect(publication.remoteId).toBeUndefined();
	});

	it("does not confuse Plik upload and file ids or lose token-bound deletion metadata", async () => {
		let calls = 0;
		const fetch: FetchImpl = async (input, init) => {
			calls++;
			if (calls === 1) {
				expect(urlOf(input)).toBe("https://plik.test/api/upload");
				expect(init?.method).toBe("POST");
				expect(headersOf(init).get("x-pliktoken")).toBe("plik-key");
				expect(JSON.parse(String(init?.body))).toEqual({ ttl: 90, oneShot: false, removable: false });
				return Response.json({
					id: "upload-id",
					uploadToken: "delete-token",
					downloadURL: "https://downloads.test/root",
				});
			}
			expect(urlOf(input)).toBe("https://plik.test/api/file/upload-id");
			expect(init?.method).toBe("POST");
			expect(headersOf(init).get("x-uploadtoken")).toBe("delete-token");
			await expectFile(formOf(init), "file");
			return Response.json([{ id: 7, fileName: "server name.png" }]);
		};
		const uploader = requiredUploader(
			createSelfHostedUploader(
				"plik",
				configured(
					{ endpoint: "https://plik.test/api/", ttlSeconds: 90, removable: false },
					{ apiKey: "plik-key" },
					fetch,
				),
			),
		);
		const before = Date.now();
		const publication = await uploader.upload(request);
		const after = Date.now();
		expect(calls).toBe(2);
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 90_000);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 90_000);
		expect(publication).toMatchObject({
			url: "https://downloads.test/root/file/upload-id/7/server%20name.png",
			remoteId: "upload-id",
			delete: {
				method: "DELETE",
				url: "https://plik.test/api/upload/upload-id",
				headers: { "X-UploadToken": "delete-token" },
			},
		});
	});
});

describe("legacy uploader wire contracts", () => {
	it("does not omit s-ul compatibility fields or its GET deletion contract", async () => {
		let calls = 0;
		const fetch: FetchImpl = async (input, init) => {
			calls++;
			expect(urlOf(input)).toBe("https://s-ul.eu/api/v1/upload");
			expect(init?.method).toBe("POST");
			const form = formOf(init);
			expect(form.get("wizard")).toBe("true");
			expect(form.get("key")).toBe("sul-key");
			expect(form.get("client")).toBe("sharex-native");
			await expectFile(form, "file");
			return Response.json({ protocol: "https://", domain: "cdn.s-ul.test", filename: "asset", extension: ".png" });
		};
		const publication = await requiredUploader(
			createLegacyUploader("s-ul", configured({}, { apiKey: "sul-key" }, fetch)),
		).upload(request);
		expect(calls).toBe(1);
		expect(publication).toEqual({
			url: "https://cdn.s-ul.test/asset.png",
			destination: "s-ul",
			bytes: request.bytes.byteLength,
			remoteId: "asset",
			delete: { method: "GET", url: "https://s-ul.eu/delete.php?key=sul-key&file=asset" },
		});
	});

	it("does not misread the puush CSV direct URL or remote id", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/puush");
			expect(init?.method).toBe("POST");
			const form = formOf(init);
			expect(form.get("k")).toBe("puush-key");
			expect(form.get("z")).toBe("oh-my-pi");
			await expectFile(form, "f");
			return new Response("0,https://cdn.test/puush.png,p-42");
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"puush",
				configured({ endpoint: "https://replacement.test/puush" }, { apiKey: "puush-key" }, fetch),
			),
		).upload(request);
		expect(publication).toMatchObject({ url: "https://cdn.test/puush.png", remoteId: "p-42" });
	});

	it("does not omit MediaFire auth and fields or miss a nested direct URL", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/media/upload");
			expect(init?.method).toBe("POST");
			expect(headersOf(init).get("authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
			const form = formOf(init);
			expect(form.get("path")).toBe("screens");
			expect(form.get("api_key")).toBe("media-key");
			await expectFile(form, "Filedata");
			return Response.json({ quickkey: "mf-1", response: { direct_url: "/public/media.png" } });
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"mediafire",
				configured(
					{ endpoint: "https://replacement.test/media/upload", path: "screens" },
					{ username: "user", password: "pass", apiKey: "media-key" },
					fetch,
				),
			),
		).upload(request);
		expect(publication).toMatchObject({ url: "https://replacement.test/public/media.png", remoteId: "mf-1" });
	});

	it("does not bypass SendSpace discovery or lose node fields and delete URL", async () => {
		let calls = 0;
		const fetch: FetchImpl = async (input, init) => {
			calls++;
			if (calls === 1) {
				const url = new URL(urlOf(input));
				expect(`${url.origin}${url.pathname}`).toBe("https://replacement.test/sendspace/discover");
				expect(Object.fromEntries(url.searchParams)).toEqual({
					method: "anonymous.uploadGetInfo",
					speed_limit: "0",
					api_version: "1.0",
					app_version: "1.0",
					api_key: "send-key",
				});
				expect(init?.method).toBe("GET");
				return new Response(
					'<response status="ok"><upload url="https://node.test/upload" max_file_size="1000" upload_identifier="upload-1" extra_info="opaque" /></response>',
				);
			}
			expect(urlOf(input)).toBe("https://node.test/upload");
			expect(init?.method).toBe("POST");
			const form = formOf(init);
			expect(form.get("MAX_FILE_SIZE")).toBe("1000");
			expect(form.get("UPLOAD_IDENTIFIER")).toBe("upload-1");
			expect(form.get("extra_info")).toBe("opaque");
			await expectFile(form, "userfile");
			return new Response(
				"<response><status>ok</status><direct_url>https://cdn.test/send.png</direct_url><delete_url>https://node.test/delete/1</delete_url></response>",
			);
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"sendspace",
				configured({ endpoint: "https://replacement.test/sendspace/discover" }, { apiKey: "send-key" }, fetch),
			),
		).upload(request);
		expect(calls).toBe(2);
		expect(publication).toMatchObject({
			url: "https://cdn.test/send.png",
			delete: { method: "GET", url: "https://node.test/delete/1" },
		});
	});

	it("does not omit localhostr basic auth or mis-map id and filename to the public URL", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/hostr");
			expect(init?.method).toBe("POST");
			expect(headersOf(init).get("authorization")).toBe(`Basic ${Buffer.from("mail@test:pass").toString("base64")}`);
			await expectFile(formOf(init), "file");
			return Response.json({ id: "host-id", name: "server name.png" });
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"localhostr",
				configured(
					{ endpoint: "https://replacement.test/hostr", publicBaseUrl: "https://cdn.test/base/" },
					{ email: "mail@test", password: "pass" },
					fetch,
				),
			),
		).upload(request);
		expect(publication).toMatchObject({
			url: "https://cdn.test/base/file/host-id/server%20name.png",
			remoteId: "host-id",
		});
	});

	it("does not fall back to defunct Lambda or resolve its custom PUT result against the wrong base", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/lambda");
			expect(init?.method).toBe("PUT");
			const form = formOf(init);
			expect(form.get("api_key")).toBe("lambda-key");
			await expectFile(form, "file");
			return Response.json({ errors: [], url: "images/lambda.png" });
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"lambda",
				configured(
					{ endpoint: "https://replacement.test/lambda", resultBaseUrl: "https://cdn.test/root/" },
					{ apiKey: "lambda-key" },
					fetch,
				),
			),
		).upload(request);
		expect(publication.url).toBe("https://cdn.test/root/images/lambda.png");
	});

	it("does not omit the LobFile API key or miss its nested direct URL", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/lob/upload");
			expect(init?.method).toBe("POST");
			const form = formOf(init);
			expect(form.get("api_key")).toBe("lob-key");
			await expectFile(form, "file");
			return Response.json({ success: true, response: { URL: "/files/lob.png" } });
		};
		const publication = await requiredUploader(
			createLegacyUploader(
				"lobfile",
				configured({ endpoint: "https://replacement.test/lob/upload" }, { apiKey: "lob-key" }, fetch),
			),
		).upload(request);
		expect(publication.url).toBe("https://replacement.test/files/lob.png");
	});

	it("does not discard the transfer-compatible deletion header or direct URL", async () => {
		const fetch: FetchImpl = async (input, init) => {
			expect(urlOf(input)).toBe("https://replacement.test/transfer");
			expect(init?.method).toBe("POST");
			await expectFile(formOf(init), "file");
			return new Response("/public/transfer.png\n", { headers: { "X-Url-Delete": "/delete/transfer" } });
		};
		const publication = await requiredUploader(
			createLegacyUploader("transfer-sh", configured({ endpoint: "https://replacement.test/transfer" }, {}, fetch)),
		).upload(request);
		expect(publication).toMatchObject({
			url: "https://replacement.test/public/transfer.png",
			delete: { method: "DELETE", url: "https://replacement.test/delete/transfer" },
		});
	});
});

describe("legacy and self-hosted pre-network rejection", () => {
	it("requires replacement endpoints instead of silently using defunct public defaults", () => {
		const destinations: BlobDestinationId[] = [
			"puush",
			"mediafire",
			"sendspace",
			"localhostr",
			"lambda",
			"lobfile",
			"transfer-sh",
		];
		let fetches = 0;
		for (const destination of destinations) {
			expect(() =>
				createLegacyUploader(
					destination,
					configured({}, { apiKey: "key" }, async () => {
						fetches++;
						throw new Error("fetch must not run");
					}),
				),
			).toThrow(DestinationUnavailableError);
		}
		expect(fetches).toBe(0);
	});

	it("blocks the known defunct hosts even when explicitly configured", () => {
		const cases: ReadonlyArray<readonly [BlobDestinationId, string]> = [
			["puush", "https://puush.me/api/up"],
			["mediafire", "https://api.mediafire.com/upload"],
			["sendspace", "https://api.sendspace.com/rest/"],
			["localhostr", "https://hostr.co/upload"],
			["lambda", "https://lambda.sx/upload"],
			["lobfile", "https://lithi.io/upload"],
			["transfer-sh", "https://transfer.sh/upload"],
		];
		let fetches = 0;
		for (const [destination, endpoint] of cases) {
			expect(() =>
				createLegacyUploader(
					destination,
					configured({ endpoint }, { apiKey: "key" }, async () => {
						fetches++;
						throw new Error("fetch must not run");
					}),
				),
			).toThrow(DestinationUnavailableError);
		}
		expect(fetches).toBe(0);
	});

	it("rejects video, encrypted-viewer, and email destinations before fetch", () => {
		const destinations: BlobDestinationId[] = ["streamable", "youtube", "vault", "email"];
		let fetches = 0;
		for (const destination of destinations) {
			expect(() =>
				createLegacyUploader(
					destination,
					configured({}, {}, async () => {
						fetches++;
						throw new Error("fetch must not run");
					}),
				),
			).toThrow(DestinationUnavailableError);
		}
		expect(fetches).toBe(0);
	});

	it("returns null rather than claiming destinations owned by another factory family", () => {
		expect(createSelfHostedUploader("s-ul", configured())).toBeNull();
		expect(createLegacyUploader("ftp", configured())).toBeNull();
	});
});
