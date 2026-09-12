import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AppleSpeechArchitecture, compileAppleSpeechSidecar } from "../src/stt/apple-speech-compiler";

const packageDir = path.join(import.meta.dir, "..");
const sourcePath = path.join(packageDir, "src", "stt", "speech-analyzer.swift");

/** Compile the SpeechAnalyzer helper for one Darwin release architecture. */
export async function buildAppleSpeechSidecar(
	architecture: AppleSpeechArchitecture,
	outputPath: string,
): Promise<void> {
	await compileAppleSpeechSidecar({ architecture, outputPath, sourcePath });
}

/** Build a temporary helper and return its bytes for Bun's compiled-binary embed. */
export async function buildAppleSpeechSidecarBase64(architecture: AppleSpeechArchitecture): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-speech-analyzer-build-"));
	const outputPath = path.join(directory, "omp-speech-analyzer");
	try {
		await buildAppleSpeechSidecar(architecture, outputPath);
		return Buffer.from(await Bun.file(outputPath).bytes()).toString("base64");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
