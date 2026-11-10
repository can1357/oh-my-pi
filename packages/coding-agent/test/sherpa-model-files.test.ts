import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getTinyModelsCacheDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { ensureSherpaModelFiles, isSherpaModelCached, sherpaModelDir } from "../src/speech/sherpa-model-files";
import { asGlobalFetch } from "./helpers/fetch-mock";

const FILES = {
	encoder: "encoder.int8.onnx",
	decoder: "decoder.onnx",
	joiner: "joiner.int8.onnx",
	tokens: "tokens.txt",
} as const;

const originalAgentDir = getAgentDir();
let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sherpa-files-"));
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

/** Build a release-shaped `.tar.bz2` with a single top-level model directory. */
async function buildArchive(contents: Record<string, string>): Promise<Uint8Array> {
	const source = path.join(root, `archive-${crypto.randomUUID()}`);
	const modelDir = path.join(source, "sherpa-onnx-model");
	for (const [name, body] of Object.entries(contents)) await Bun.write(path.join(modelDir, name), body);
	const archivePath = path.join(source, "model.tar.bz2");
	const tar = await $`tar -cjf ${archivePath} -C ${source} sherpa-onnx-model`.quiet().nothrow();
	if (tar.exitCode !== 0) throw new Error(`tar failed (${tar.exitCode}): ${tar.stderr.toString()}`);
	return new Uint8Array(await Bun.file(archivePath).arrayBuffer());
}

function serveArchive(bytes: Uint8Array, respond?: (request: Request) => Response | Promise<Response>) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => respond?.(request) ?? new Response(bytes),
	});
}

describe("sherpa model archive installation", () => {
	test("downloads, extracts, and promotes the release tree into the shared cache", async () => {
		const contents = Object.fromEntries(Object.values(FILES).map(name => [name, `body:${name}`]));
		const bytes = await buildArchive(contents);
		const server = serveArchive(bytes);
		const repo = "test/x-asr";
		try {
			const resolved = await ensureSherpaModelFiles({
				repo,
				files: FILES,
				archive: { url: `http://127.0.0.1:${server.port}/model.tar.bz2` },
			});

			for (const [role, name] of Object.entries(FILES)) {
				expect(resolved[role]).toBe(path.join(sherpaModelDir(repo), name));
				expect(await Bun.file(resolved[role]!).text()).toBe(contents[name]!);
			}
			expect(await isSherpaModelCached({ repo, files: FILES })).toBe(true);
			const siblingEntries = await fs.readdir(path.dirname(sherpaModelDir(repo)));
			expect(siblingEntries.some(entry => entry.includes(".extract-"))).toBe(false);
			expect(await fs.readdir(path.join(getTinyModelsCacheDir(), ".archives"))).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	test("serializes concurrent installers of the same model", async () => {
		const contents = Object.fromEntries(Object.values(FILES).map(name => [name, `body:${name}`]));
		const bytes = await buildArchive(contents);
		let downloads = 0;
		const downloadStarted = Promise.withResolvers<void>();
		const releaseDownload = Promise.withResolvers<void>();
		const server = serveArchive(bytes, async () => {
			downloads++;
			downloadStarted.resolve();
			await releaseDownload.promise;
			return new Response(bytes);
		});
		const options = {
			repo: "test/concurrent",
			files: FILES,
			archive: { url: `http://127.0.0.1:${server.port}/model.tar.bz2` },
		};
		try {
			const first = ensureSherpaModelFiles(options);
			await downloadStarted.promise;
			const second = ensureSherpaModelFiles(options);
			releaseDownload.resolve();
			const [firstPaths, secondPaths] = await Promise.all([first, second]);
			expect(secondPaths).toEqual(firstPaths);
			expect(downloads).toBe(1);
			for (const name of Object.values(FILES)) {
				expect(await Bun.file(path.join(sherpaModelDir(options.repo), name)).text()).toBe(contents[name]!);
			}
		} finally {
			releaseDownload.resolve();
			server.stop(true);
		}
	});

	test("keeps completed files when the archive download fails", async () => {
		const repo = "test/failed-archive";
		const encoder = path.join(sherpaModelDir(repo), FILES.encoder);
		await Bun.write(encoder, "cached-encoder");
		const server = serveArchive(new Uint8Array(), () => new Response("unavailable", { status: 503 }));
		try {
			await expect(
				ensureSherpaModelFiles({
					repo,
					files: FILES,
					archive: { url: `http://127.0.0.1:${server.port}/model.tar.bz2` },
				}),
			).rejects.toThrow("HTTP 503");
			expect(await Bun.file(encoder).text()).toBe("cached-encoder");
		} finally {
			server.stop(true);
		}
	});
});

describe("sherpa model file downloads", () => {
	test("keeps completed files after a failed download and resumes only the missing ones", async () => {
		const repo = "test/file-resume";
		const requests: string[] = [];
		let failDecoder = true;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const name = String(input).split("/").pop()!;
				requests.push(name);
				if (name === FILES.decoder && failDecoder) return new Response("unavailable", { status: 503 });
				return new Response(`body:${name}`);
			}),
		);

		await expect(ensureSherpaModelFiles({ repo, files: FILES })).rejects.toThrow("HTTP 503");
		const repoDir = sherpaModelDir(repo);
		expect(await Bun.file(path.join(repoDir, FILES.encoder)).text()).toBe(`body:${FILES.encoder}`);
		expect((await fs.readdir(repoDir)).sort()).toEqual([FILES.encoder]);

		failDecoder = false;
		requests.length = 0;
		await ensureSherpaModelFiles({ repo, files: FILES });
		expect(requests).toEqual([FILES.decoder, FILES.joiner, FILES.tokens]);
		expect(await isSherpaModelCached({ repo, files: FILES })).toBe(true);
	});

	test("returns an installed model without touching the network", async () => {
		const repo = "test/warm";
		for (const name of Object.values(FILES)) await Bun.write(path.join(sherpaModelDir(repo), name), `body:${name}`);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network access"));

		const resolved = await ensureSherpaModelFiles({ repo, files: FILES });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await Bun.file(resolved.tokens).text()).toBe(`body:${FILES.tokens}`);
	});
});
