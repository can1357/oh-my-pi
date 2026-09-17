import * as fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactManager } from "../session/artifacts";
import type { CodeWriteReceipt } from "./code-write";
import type { SingleResult } from "./types";

export function projectEvidenceDigest(rawOutput: string, reference: string): { output: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(rawOutput);
	if (bytes.byteLength <= 8000) return { output: rawOutput, truncated: false };
	const note = `\n[Incomplete evidence digest: capped at 8,000 UTF-8 bytes. Full output: ${reference}]`;
	const budget = 8000 - encoder.encode(note).byteLength;
	if (budget < 0) throw new Error("Evidence digest reference exceeds the 8,000-byte output budget.");
	return {
		output: new TextDecoder().decode(bytes.subarray(0, budget), { stream: true }) + note,
		truncated: true,
	};
}

/** Keep worker prose and source in artifacts, never in codeWrite parent-facing fields. */
export async function projectDelegatedIoResult(options: {
	result: SingleResult;
	kind: "code-write" | "evidence-digest";
	artifactsDir: string;
	artifactManager?: ArtifactManager;
	receipt?: CodeWriteReceipt;
}): Promise<void> {
	const { result, kind, artifactsDir, artifactManager, receipt } = options;
	const rawOutput = result.outputPath
		? await fs.readFile(result.outputPath, "utf8").catch(() => result.output)
		: result.output;
	const transcriptPath = path.join(artifactsDir, `${result.id}.jsonl`);
	const transcript = await fs.readFile(transcriptPath, "utf8").catch(() => "");
	const full =
		kind === "code-write" || result.error || result.isError
			? `${transcript}\n${JSON.stringify(result)}\n${rawOutput}`
			: rawOutput;
	const rawArtifact = path.join(artifactsDir, `${result.id}.delegated.log`);
	let reference: string;
	if (artifactManager) {
		reference = `artifact://${await artifactManager.save(full, kind)}`;
	} else {
		await fs.writeFile(rawArtifact, full);
		reference = rawArtifact;
	}
	result.delegatedIoKind = kind;
	result.transcriptArtifact = reference;
	result.extractedToolData = undefined;
	result.retryFailure = undefined;
	result.lastIntent = undefined;
	result.stderr = "";
	if (kind === "code-write") {
		const succeeded =
			result.exitCode === 0 &&
			!result.error &&
			!result.isError &&
			!result.aborted &&
			receipt?.changesApplied === true;
		result.output = succeeded
			? JSON.stringify(receipt)
			: `[Fusion I/O] codeWrite generation or integration failed. No successful receipt was produced. Inspect ${reference} for the retained diagnostic and transcript.`;
		if (!succeeded) {
			result.exitCode = 1;
			result.isError = true;
			result.error = result.output;
			result.mergeSummary = result.output;
			if (result.abortReason) result.abortReason = "codeWrite interrupted; inspect the retained artifact.";
		}
		result.nestedPatches = undefined;
		result.truncated = false;
	} else {
		const digest = projectEvidenceDigest(rawOutput, reference);
		result.output = digest.output;
		result.truncated = digest.truncated;
		if (result.error) result.error = `[Fusion I/O] Evidence digest failed; inspect ${reference}.`;
	}
	// Consumers of agent://, async completion and provider conversion may reopen outputPath.
	// Point every projected result at the bounded/native receipt, never the raw worker output.
	const projectedPath = path.join(artifactsDir, `${result.id}.md`);
	await fs.writeFile(projectedPath, result.output);
	result.outputPath = projectedPath;
	result.outputMeta = { lineCount: result.output.split("\n").length, charCount: result.output.length };
}
