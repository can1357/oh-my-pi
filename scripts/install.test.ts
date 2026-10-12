import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// install.sh runs against a fake build service and fake PATH host commands so
// target detection, artifact selection, and Bun usage stay deterministic.

const repoRoot = path.join(import.meta.dir, "..");
const BINARY = '#!/bin/sh\necho "omp/1.0.0"\n';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * A build service answering every update check with version 1.0.0 of
 * `fileName`, whose `file` object carries the expected checksum. Other target
 * hashes and the notes contain decoys, and the download URL holds a `\u0026`
 * escape the way Go's encoder writes presigned URLs.
 */
function startService(
	fileSha256: string,
	fileName = "omp-linux-musl-x64",
	binaryContent = BINARY,
): { url: string; requests: string[] } {
	const requests: string[] = [];
	let origin = "";
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(url.pathname + url.search);
			if (url.pathname === `/dl/${fileName}`) {
				return url.searchParams.get("b") === "2"
					? new Response(binaryContent)
					: new Response("bad query", { status: 403 });
			}
			if (!url.pathname.startsWith("/api/products/omp/"))
				return Response.json({ error: "no_build" }, { status: 404 });
			const decoy = "0".repeat(64);
			const artifactPlatform = fileName.includes("android")
				? "android"
				: fileName.includes("linux-musl")
					? "linux-musl"
					: "linux";
			const artifactArch = fileName.endsWith("arm64") ? "arm64" : "x86_64";
			const answer = {
				build: {
					id: "20261010-171748-fa5ff4a",
					product: "omp",
					version: "1.0.0",
					channel: "stable",
					notes: `Answers look like {"file":{"sha256":"${decoy}"},"version":"9.9.9"}`,
					files: [
						{
							name: "omp-linux-x64",
							platform: "linux",
							arch: "x86_64",
							sha256: decoy,
						},
						{
							name: "omp-linux-musl-x64",
							platform: "linux-musl",
							arch: "x86_64",
							sha256: decoy,
						},
					],
				},
				file: {
					name: fileName,
					platform: artifactPlatform,
					arch: artifactArch,
					kind: "binary",
					size: binaryContent.length,
					sha256: fileSha256,
					url: `/d/omp/20261010-171748-fa5ff4a/${fileName}`,
				},
				download: `${origin}/dl/${fileName}?a=1&b=2`,
				patch: {
					format: "file",
					from: "20261009-000000-0000000",
					from_sha256: decoy,
					size: 1,
					sha256: "f".repeat(64),
					url: `${origin}/patch`,
				},
			};
			return new Response(JSON.stringify(answer).replaceAll("&", "\\u0026"), {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	origin = server.url.origin;
	cleanups.push(() => server.stop(true));
	// Trailing slashes on PI_BUILD_URL are trimmed.
	return { url: `${server.url.origin}/`, requests };
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function runInstall(
	buildUrl: string,
	args: string[],
	host: { unameS?: string; unameM?: string; unameO?: string; termuxVersion?: string } = {},
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	installDir: string;
	bunCalls: string;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	const bunCalls = path.join(dir, "bun-calls");
	await writeExecutable(
		path.join(binDir, "uname"),
		`#!/bin/sh
case "$1" in
	-s) echo "${host.unameS ?? "Linux"}" ;;
	-m) echo "${host.unameM ?? "x86_64"}" ;;
	-o) echo "${host.unameO ?? "GNU/Linux"}" ;;
esac
`,
	);
	await writeExecutable(path.join(binDir, "ldd"), "#!/bin/sh\necho 'musl libc (x86_64)'\n");
	await writeExecutable(path.join(binDir, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${bunCalls}'\nexit 1\n`);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		HOME: dir,
		PI_INSTALL_DIR: installDir,
		PI_BUILD_URL: buildUrl,
	};
	delete env.TERMUX_VERSION;
	if (host.termuxVersion !== undefined) env.TERMUX_VERSION = host.termuxVersion;
	const proc = Bun.spawn(["sh", "scripts/install.sh", ...args], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr, installDir, bunCalls };
}

describe.skipIf(process.platform === "win32")("install.sh target selection", () => {
	test("installs the host target's build, verified against the answer's file sha256", async () => {
		const service = startService(sha256(BINARY));
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/latest/linux-musl-x86_64?channel=stable");
		expect(result.stdout).toContain("Using version: 1.0.0");
		expect(await fs.readdir(result.installDir)).toEqual(["omp"]);
		expect(await Bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
	});

	test("defaults to the Android binary on native Android and never invokes external Bun", async () => {
		const service = startService(sha256(BINARY), "omp-android-arm64");
		const result = await runInstall(service.url, [], { unameO: "Android", unameM: "aarch64" });

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/latest/android-arm64?channel=stable");
		expect(service.requests[1]).toContain("/dl/omp-android-arm64?");
		expect(await Bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
		expect(
			await Bun.file(result.bunCalls)
				.text()
				.catch(() => ""),
		).toBe("");
	});

	test("supports explicit Android --binary installs on Termux", async () => {
		const service = startService(sha256(BINARY), "omp-android-arm64");
		const result = await runInstall(service.url, ["--binary"], {
			unameO: "GNU/Linux",
			unameM: "aarch64",
			termuxVersion: "0.118",
		});

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/latest/android-arm64?channel=stable");
		expect(await Bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
		expect(
			await Bun.file(result.bunCalls)
				.text()
				.catch(() => ""),
		).toBe("");
	});

	test("rejects source installs on Termux with the binary-only path", async () => {
		const service = startService(sha256(BINARY), "omp-android-arm64");
		const result = await runInstall(service.url, ["--source"], {
			unameO: "GNU/Linux",
			unameM: "aarch64",
			termuxVersion: "0.118",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Source installs are not supported on Android/Termux");
		expect(result.stdout).toContain("--binary");
		expect(service.requests).toEqual([]);
		expect(
			await Bun.file(result.bunCalls)
				.text()
				.catch(() => ""),
		).toBe("");
	});

	test("rejects unsupported Android architectures instead of requesting Linux builds", async () => {
		const service = startService(sha256(BINARY), "omp-android-arm64");
		const result = await runInstall(service.url, ["--binary"], {
			unameO: "Android",
			unameM: "x86_64",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unsupported Android architecture: x64");
		expect(service.requests).toEqual([]);
		expect(
			await Bun.file(result.bunCalls)
				.text()
				.catch(() => ""),
		).toBe("");
	});

	test("rejects a Linux artifact returned for the Android target", async () => {
		const service = startService(sha256(BINARY), "omp-linux-arm64");
		const result = await runInstall(service.url, [], { unameO: "Android", unameM: "aarch64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("expected omp-android-arm64, got omp-linux-arm64");
		expect(service.requests).toEqual(["/api/products/omp/latest/android-arm64?channel=stable"]);
	});

	test("reports an Android binary that cannot start without Linux musl guidance", async () => {
		const brokenBinary = '#!/bin/sh\necho "Android runtime failure" >&2\nexit 127\n';
		const service = startService(sha256(brokenBinary), "omp-android-arm64", brokenBinary);
		const result = await runInstall(service.url, ["--binary"], { unameO: "Android", unameM: "aarch64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("cannot start");
		expect(result.stdout).toContain("Android runtime failure");
		expect(result.stdout).not.toContain("libstdc++");
	});

	test("refuses a download whose sha256 differs from the answer's file object", async () => {
		const service = startService(sha256("something else"));
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Checksum mismatch for omp-linux-musl-x64");
		expect(await fs.readdir(result.installDir)).toEqual([]);
	});

	test("--ref resolves a release tag through the versions endpoint and rejects other refs", async () => {
		const service = startService(sha256(BINARY));
		const tagged = await runInstall(service.url, ["--binary", "--ref", "v1.0.0"]);
		expect(tagged.exitCode, tagged.stdout + tagged.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/versions/1.0.0/linux-musl-x86_64");

		const branch = await runInstall(service.url, ["--binary", "--ref", "main"]);
		expect(branch.exitCode).toBe(1);
		expect(branch.stdout).toContain("use --source with --ref");
		expect(service.requests).toHaveLength(2);
	});
});
