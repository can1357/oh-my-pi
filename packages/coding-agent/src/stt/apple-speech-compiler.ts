// Subpath import: cli.ts reaches this module through the smoke probe, and the
// pi-utils barrel would pull native addons into normal CLI startup.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils/which";

const MINIMUM_SPEECH_SDK_MAJOR = 26;
let toolchainAvailability: Promise<boolean> | null = null;

/** Whether an SDK version can compile the macOS 26 SpeechAnalyzer API. */
export function isAppleSpeechSdkVersionSupported(version: string): boolean {
	const sdkMajor = Number.parseInt(version.trim().split(".", 1)[0] ?? "", 10);
	return Number.isFinite(sdkMajor) && sdkMajor >= MINIMUM_SPEECH_SDK_MAJOR;
}

async function probeAppleSpeechSidecarToolchain(): Promise<boolean> {
	if (process.platform !== "darwin" || !$which("swiftc")) return false;
	const xcrun = $which("xcrun");
	if (!xcrun) return false;
	const proc = Bun.spawn([xcrun, "--sdk", "macosx", "--show-sdk-version"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (exitCode !== 0) return false;
	return isAppleSpeechSdkVersionSupported(stdout);
}

/** Whether this host can compile the optional macOS 26 SpeechAnalyzer helper. */
export function canCompileAppleSpeechSidecar(): Promise<boolean> {
	toolchainAvailability ??= probeAppleSpeechSidecarToolchain();
	return toolchainAvailability;
}

/** Darwin architecture accepted by the SpeechAnalyzer sidecar toolchain. */
export type AppleSpeechArchitecture = "arm64" | "x64";

/** Inputs for the shared build-time and runtime sidecar compiler. */
export interface AppleSpeechCompileOptions {
	architecture: AppleSpeechArchitecture;
	outputPath: string;
	sourcePath: string;
}

/** Compile and ad-hoc sign the native SpeechAnalyzer helper for one Darwin architecture. */
export async function compileAppleSpeechSidecar(options: AppleSpeechCompileOptions): Promise<void> {
	if (!(await canCompileAppleSpeechSidecar())) {
		throw new Error("Apple SpeechAnalyzer compilation requires Xcode 26 or newer with the macOS 26 SDK.");
	}
	const swiftc = $which("swiftc");
	if (!swiftc) throw new Error("Swift compiler disappeared after the SpeechAnalyzer toolchain probe.");
	await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
	const targetArchitecture = options.architecture === "x64" ? "x86_64" : options.architecture;
	const proc = Bun.spawn(
		[
			swiftc,
			"-parse-as-library",
			"-O",
			"-target",
			`${targetArchitecture}-apple-macos26.0`,
			"-framework",
			"Speech",
			"-framework",
			"AVFAudio",
			"-framework",
			"CoreMedia",
			"-o",
			options.outputPath,
			options.sourcePath,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, , stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`SpeechAnalyzer sidecar build failed: ${stderr.trim() || `swiftc exited ${exitCode}`}`);
	}
	await fs.chmod(options.outputPath, 0o755);

	const codesign = $which("codesign");
	if (!codesign) return;
	const sign = Bun.spawn([codesign, "--force", "--sign", "-", options.outputPath], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [signExitCode, , signStderr] = await Promise.all([
		sign.exited,
		new Response(sign.stdout as ReadableStream<Uint8Array>).text(),
		new Response(sign.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (signExitCode !== 0) {
		throw new Error(
			`SpeechAnalyzer sidecar signing failed: ${signStderr.trim() || `codesign exited ${signExitCode}`}`,
		);
	}
}
