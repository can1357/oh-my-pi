#!/usr/bin/env bun
//
// Publish an omp release's binaries and shared HTML viewer to build.stencil.so,
// which serves them, with binary patches between releases, to update
// clients. Canary releases (`v<semver>-canary.<n>`) are uploaded with channel
// `canary`, everything else with channel `stable`.
//
// Usage:
//   bun scripts/ci-build-upload.ts <tag> <file>...    # all 8 release binaries
// The viewer is read from packages/coding-agent/export-assets and must exactly
// match src/export/html/viewer.generated.json before any network request.
//
// Runs in ci.yml's `release_build` job (which npm and the Homebrew tap wait
// for), on the binaries this run built. Requests the job's GitHub OIDC token
// for audience `build.stencil.so` (needs `permissions: id-token: write`); the service
// accepts it because release tag <tag> points at the run's commit. Declares
// the build (version, channel, every file's target/size/sha256, and the version's
// packages/coding-agent/CHANGELOG.md section as notes when it fits 16 KiB),
// PUTs each file to its presigned R2 URL, then publishes the build. Any non-2xx
// answer fails the run.
//
// Environment:
//   ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN  set by Actions
//   BUILD_URL       service origin (default https://build.stencil.so)
// Uploads go through `curl`.

import * as path from "node:path";
import { $ } from "bun";
import { enumerateChangelogVersions } from "./ci-release-notes";

const PRODUCT = "omp";
const AUDIENCE = "build.stencil.so";
const SERVICE_URL = (process.env.BUILD_URL ?? "https://build.stencil.so").replace(/\/+$/, "");
const CODING_AGENT = path.join(import.meta.dir, "..", "packages", "coding-agent");
const CHANGELOG = path.join(CODING_AGENT, "CHANGELOG.md");
const VIEWER_MANIFEST = path.join(CODING_AGENT, "src", "export", "html", "viewer.generated.json");
/** The service rejects notes longer than this many bytes. */
const MAX_NOTES_BYTES = 16 << 10;
/** Attempts per upload/publish request on network errors and transient statuses. */
const ATTEMPTS = 3;

/** Release asset name → build-service target. Only these are uploaded. */
export const ASSETS: Readonly<Record<string, { platform: string; arch: string }>> = {
	"omp-darwin-arm64": { platform: "macos", arch: "arm64" },
	"omp-darwin-x64": { platform: "macos", arch: "x86_64" },
	"omp-linux-x64": { platform: "linux", arch: "x86_64" },
	"omp-linux-arm64": { platform: "linux", arch: "arm64" },
	"omp-linux-musl-x64": { platform: "linux-musl", arch: "x86_64" },
	"omp-linux-musl-arm64": { platform: "linux-musl", arch: "arm64" },
	"omp-windows-x64.exe": { platform: "windows", arch: "x86_64" },
	"omp-windows-arm64.exe": { platform: "windows", arch: "arm64" },
};

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** Build-service release channel. */
export type Channel = "stable" | "canary";

interface BuildFile {
	name: string;
	platform: string;
	arch: string;
	kind: "archive" | "web";
	size: number;
	sha256: string;
}

interface CreateResponse {
	build: { id: string };
	uploads: { name: string; url: string }[];
}

/** The version a release tag names; throws for non-release tags. */
export function releaseVersion(tag: string): string {
	const version = RELEASE_TAG.exec(tag)?.[1];
	if (!version) throw new Error(`${tag} is not a v<semver> release tag`);
	return version;
}

/**
 * The body of `changelog`'s `## [version]` section (heading excluded,
 * trimmed), or undefined when the section is missing, empty, or longer than
 * the service accepts.
 */
export function releaseNotes(changelog: string, version: string): string | undefined {
	const span = enumerateChangelogVersions(changelog).find(s => s.version === version);
	if (!span) return undefined;
	const notes = changelog
		.split("\n")
		.slice(span.start + 1, span.end)
		.join("\n")
		.trim();
	if (notes === "") return undefined;
	const bytes = Buffer.byteLength(notes);
	if (bytes > MAX_NOTES_BYTES) {
		console.warn(`CHANGELOG section for ${version} is ${bytes} bytes (limit ${MAX_NOTES_BYTES}); sending no notes.`);
		return undefined;
	}
	return notes;
}

async function fingerprint(file: string): Promise<{ size: number; sha256: string }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	for await (const chunk of Bun.file(file).stream()) {
		hasher.update(chunk);
		size += chunk.byteLength;
	}
	return { size, sha256: hasher.digest("hex") };
}

async function describe(file: string): Promise<BuildFile> {
	const name = path.basename(file);
	if (!Object.hasOwn(ASSETS, name)) {
		throw new Error(`${file}: not an uploaded release asset (${Object.keys(ASSETS).join(", ")})`);
	}
	return { name, ...ASSETS[name], kind: "archive", ...(await fingerprint(file)) };
}

/** Only the content-addressed viewer pinned into the release may be published. */
async function describeViewer(): Promise<{ file: string; entry: BuildFile }> {
	const manifest: unknown = await Bun.file(VIEWER_MANIFEST).json();
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("file" in manifest) ||
		typeof manifest.file !== "string" ||
		!/^export-viewer-[a-f0-9]{64}\.js$/.test(manifest.file) ||
		!("integrity" in manifest) ||
		typeof manifest.integrity !== "string" ||
		!("size" in manifest) ||
		typeof manifest.size !== "number" ||
		!Number.isSafeInteger(manifest.size) ||
		manifest.size <= 0
	) {
		throw new Error("invalid viewer manifest");
	}
	const file = path.join(CODING_AGENT, "export-assets", manifest.file);
	const { size, sha256 } = await fingerprint(file);
	const integrity = `sha256-${Buffer.from(sha256, "hex").toString("base64")}`;
	if (manifest.file !== `export-viewer-${sha256}.js` || manifest.integrity !== integrity || manifest.size !== size) {
		throw new Error(`${manifest.file}: viewer filename, integrity or size does not match generated manifest`);
	}
	return {
		file,
		entry: { name: manifest.file, platform: "web", arch: "wasm32", kind: "web", size, sha256 },
	};
}

/** fetch() that throws with the response body on any non-2xx answer. */
async function request(what: string, url: string, init: RequestInit, attempts = 1): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			if (attempt < attempts) {
				console.warn(`${what}: ${err}; retrying`);
				continue;
			}
			throw new Error(`${what}: ${err}`);
		}
		if (response.ok) return response;
		const body = (await response.text()).trim();
		const transient = response.status === 408 || response.status === 429 || response.status >= 500;
		if (transient && attempt < attempts) {
			console.warn(`${what}: HTTP ${response.status} ${body}; retrying`);
			continue;
		}
		throw new Error(`${what}: HTTP ${response.status} ${body}`);
	}
}

async function oidcToken(): Promise<string> {
	const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!requestUrl || !requestToken) {
		throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN not set: run in GitHub Actions with id-token: write");
	}
	const url = new URL(requestUrl);
	url.searchParams.set("audience", AUDIENCE);
	const response = await request("OIDC token request", url.href, {
		headers: { Authorization: `bearer ${requestToken}` },
	});
	const { value } = (await response.json()) as { value?: string };
	if (!value) throw new Error("OIDC token response has no value");
	return value;
}

async function main(): Promise<void> {
	const [tag, ...files] = process.argv.slice(2);
	if (!tag || files.length === 0) throw new Error("usage: ci-build-upload.ts <tag> <file>...");
	const version = releaseVersion(tag);
	const channel: Channel = version.includes("-canary.") ? "canary" : "stable";

	const described: BuildFile[] = [];
	for (const file of files) {
		const entry = await describe(file);
		if (described.some(d => d.name === entry.name)) throw new Error(`${entry.name} given twice`);
		described.push(entry);
		console.log(`${entry.name}\t${entry.platform}-${entry.arch}\t${entry.size}\t${entry.sha256}`);
	}
	const missing: string[] = [];
	for (const name in ASSETS) {
		if (!described.some(d => d.name === name)) missing.push(name);
	}
	if (missing.length > 0) throw new Error(`missing release binaries: ${missing.join(", ")}`);
	const viewer = await describeViewer();
	described.push(viewer.entry);
	files.push(viewer.file);
	console.log(`${viewer.entry.name}\tweb-wasm32\t${viewer.entry.size}\t${viewer.entry.sha256}`);
	const notes = releaseNotes(await Bun.file(CHANGELOG).text(), version);

	const token = await oidcToken();
	const auth = { Authorization: `Bearer ${token}` };
	const builds = `${SERVICE_URL}/api/products/${PRODUCT}/builds`;
	const created = (await (
		await request("create build", builds, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ version, channel, ...(notes ? { notes } : {}), files: described }),
		})
	).json()) as CreateResponse;
	const id = created.build.id;
	console.log(`created ${PRODUCT} build ${id} (${version}, ${channel})`);

	for (const [i, entry] of described.entries()) {
		const upload = created.uploads.find(u => u.name === entry.name);
		if (!upload) throw new Error(`service returned no upload URL for ${entry.name}`);
		console.log(`uploading ${entry.name}`);
		// curl, not fetch: the presigned URL takes the bare body, and fetch
		// always adds a Content-Type derived from the file name.
		const put =
			await $`curl --fail-with-body --silent --show-error --retry ${ATTEMPTS - 1} --upload-file ${files[i]} ${upload.url}`
				.quiet()
				.nothrow();
		if (put.exitCode !== 0) {
			throw new Error(
				`upload ${entry.name} failed: ${put.stderr.toString().trim()} ${put.stdout.toString().trim()}`,
			);
		}
	}

	await request(
		"publish build",
		`${builds}/${encodeURIComponent(id)}/publish`,
		{ method: "POST", headers: auth, body: "" },
		ATTEMPTS,
	);
	console.log(`published ${PRODUCT} build ${id}`);
}

if (import.meta.main) {
	await main();
}
