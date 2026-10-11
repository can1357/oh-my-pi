import { afterEach, describe, expect, it } from "bun:test";
import {
	type BuildHost,
	fetchBuild,
	isMuslLinuxForTest,
	parseBuildAnswer,
	resolveBuildHost,
} from "@oh-my-pi/pi-coding-agent/cli/build-service";
import { VERSION } from "@oh-my-pi/pi-utils";

const fileName = "omp-darwin-arm64";
const sha = (text: string) => Bun.SHA256.hash(text, "hex");

/** A well-formed `latest` answer, with `overrides` merged over the top level. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		build: { id: "20261011-120000-abcdef0", version: "18.8.9", channel: "stable" },
		file: { name: fileName, platform: "macos", arch: "arm64", kind: "binary", size: 205_765_664, sha256: sha("new") },
		download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
		patch: {
			format: "file",
			from: "20261001-120000-1234567",
			from_sha256: sha("old"),
			size: 6_700_636,
			sha256: sha("patch"),
			url: "https://r2.test/patches/p?X-Amz-Signature=y",
		},
		...overrides,
	};
}

describe("build service answers", () => {
	it("keeps a complete file patch and the version the check named as installed", () => {
		const parsed = parseBuildAnswer(answer(), fileName, "18.8.8");

		expect(parsed).toEqual({
			version: "18.8.9",
			file: { name: fileName, size: 205_765_664, sha256: sha("new") },
			download: "https://r2.test/omp/18.8.9/omp-darwin-arm64?X-Amz-Signature=x",
			patch: {
				fromSha256: sha("old"),
				fromVersion: "18.8.8",
				size: 6_700_636,
				sha256: sha("patch"),
				url: "https://r2.test/patches/p?X-Amz-Signature=y",
			},
		});
	});

	it("rejects answers that cannot be installed safely", () => {
		const file = (fields: Record<string, unknown>) => ({ file: { ...(answer().file as object), ...fields } });
		expect(() => parseBuildAnswer(answer(file({ sha256: sha("new").toUpperCase() })), fileName)).toThrow(
			"invalid sha256",
		);
		expect(() => parseBuildAnswer(answer(file({ sha256: "abc" })), fileName)).toThrow("invalid sha256");
		expect(() => parseBuildAnswer(answer(file({ size: 0 })), fileName)).toThrow("invalid size");
		expect(() => parseBuildAnswer(answer(file({ name: "omp-darwin-x64" })), fileName)).toThrow(
			"omp-darwin-x64 is not omp-darwin-arm64",
		);
		expect(() => parseBuildAnswer(answer({ download: "http://r2.test/omp" }), fileName)).toThrow("no HTTPS download");
		expect(() => parseBuildAnswer(answer({ build: { version: "latest" } }), fileName)).toThrow("no valid version");
	});

	it("installs the whole file when the patch is incomplete or not a file patch", () => {
		const { url: _url, ...withoutUrl } = answer().patch as Record<string, unknown>;
		expect(parseBuildAnswer(answer({ patch: withoutUrl }), fileName).patch).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), format: "tree" } }), fileName).patch,
		).toBeUndefined();
		expect(
			parseBuildAnswer(answer({ patch: { ...(answer().patch as object), url: "http://r2.test/p" } }), fileName)
				.patch,
		).toBeUndefined();
	});
});

describe("build service targets", () => {
	it("maps platform, architecture, and libc to the service target and release file name", () => {
		expect(resolveBuildHost("darwin", "arm64", false)).toEqual({
			target: "macos-arm64",
			fileName: "omp-darwin-arm64",
		});
		expect(resolveBuildHost("linux", "x64", true)).toEqual({
			target: "linux-musl-x86_64",
			fileName: "omp-linux-musl-x64",
		});
		expect(resolveBuildHost("linux", "arm64", false)).toEqual({
			target: "linux-arm64",
			fileName: "omp-linux-arm64",
		});
		expect(resolveBuildHost("win32", "x64", false)).toEqual({
			target: "windows-x86_64",
			fileName: "omp-windows-x64.exe",
		});
	});

	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("fetchBuild", () => {
	const host: BuildHost = { target: "macos-arm64", fileName };
	const previousUrl = process.env.PI_BUILD_URL;

	afterEach(() => {
		if (previousUrl === undefined) delete process.env.PI_BUILD_URL;
		else process.env.PI_BUILD_URL = previousUrl;
	});

	it("asks the configured origin for the channel's newest build, naming the installed version", async () => {
		process.env.PI_BUILD_URL = "https://build.test/";
		const requests: Array<{ url: string; userAgent: string | null; signal: AbortSignal | null | undefined }> = [];

		const build = await fetchBuild(
			{ channel: "canary" },
			{
				host,
				fromVersion: "18.8.8",
				fetchImpl: async (input, init) => {
					requests.push({
						url: String(input),
						userAgent: new Headers(init?.headers).get("User-Agent"),
						signal: init?.signal,
					});
					return Response.json(answer());
				},
			},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			"https://build.test/api/products/omp/latest/macos-arm64?channel=canary&from_version=18.8.8",
		);
		expect(requests[0].userAgent).toBe(`omp/${VERSION}`);
		expect(requests[0].signal).toBeInstanceOf(AbortSignal);
		expect(build.patch?.fromVersion).toBe("18.8.8");
	});

	it("asks for one exact version without a channel", async () => {
		delete process.env.PI_BUILD_URL;
		let url = "";

		await fetchBuild(
			{ version: "18.8.9" },
			{
				host,
				fetchImpl: async input => {
					url = String(input);
					return Response.json(answer());
				},
			},
		);

		expect(url).toBe("https://build.stencil.so/api/products/omp/versions/18.8.9/macos-arm64");
	});

	it("names the target when nothing is published for it", async () => {
		await expect(
			fetchBuild(
				{ channel: "stable" },
				{ host, fetchImpl: async () => Response.json({ error: "no_build" }, { status: 404 }) },
			),
		).rejects.toThrow("No omp stable build for macos-arm64 is published");
	});
});
