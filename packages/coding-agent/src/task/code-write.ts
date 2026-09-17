import * as fs from "node:fs/promises";
import path from "node:path";
import {
	assertCodeWriteTarget,
	canonicalNewPath,
	type DelegatedIo,
	isPathWithinWorkspace,
} from "../session/delegated-io";
import type { CodeWriteRequest } from "./types";

export interface PreparedCodeWrite {
	request: CodeWriteRequest;
	workspaceRoot: string;
	reference: string;
	target: string;
}

/** Allocation-free local text and canonical new-target validation. */
export async function prepareCodeWrite(
	request: CodeWriteRequest,
	cwd: string,
	signal?: AbortSignal,
): Promise<PreparedCodeWrite> {
	if (
		!request ||
		[request.spec, request.reference, request.target].some(value => typeof value !== "string" || !value.trim())
	) {
		throw new Error("Task codeWrite requires non-empty spec, reference, and target.");
	}
	const spec = request.spec.trim();
	const referenceArg = request.reference.trim();
	const targetArg = request.target.trim();
	if ([referenceArg, targetArg].some(value => /^[a-z][a-z\d+.-]*:\/\//i.test(value))) {
		throw new Error("Task codeWrite requires local filesystem paths, not URLs.");
	}
	if (targetArg.split(/[\\/]/).includes("..")) throw new Error("Task codeWrite rejects target path traversal.");
	const workspaceRoot = await fs.realpath(cwd);
	const reference = await fs.realpath(path.resolve(workspaceRoot, referenceArg));
	const target = await canonicalNewPath(path.resolve(workspaceRoot, targetArg));
	if (!isPathWithinWorkspace(workspaceRoot, target)) throw new Error("Task codeWrite target escapes the workspace.");
	if (process.platform === "win32" ? reference.toLowerCase() === target.toLowerCase() : reference === target) {
		throw new Error("Task codeWrite target must differ from reference.");
	}
	await assertCodeWriteTarget({ kind: "code-write", reference, target, workspaceRoot });
	const file = await fs.open(reference, "r");
	try {
		if (!(await file.stat()).isFile()) throw new Error("Task codeWrite reference must be a local text file.");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const buffer = new Uint8Array(64 * 1024);
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer);
			if (!bytesRead) break;
			const chunk = buffer.subarray(0, bytesRead);
			if (chunk.includes(0)) throw new Error("Task codeWrite reference must be text, not binary.");
			decoder.decode(chunk, { stream: true });
		}
		decoder.decode();
	} finally {
		await file.close();
	}
	return {
		request: {
			spec,
			reference: path.relative(workspaceRoot, reference),
			target: path.relative(workspaceRoot, target),
		},
		workspaceRoot,
		reference,
		target,
	};
}

export interface CodeWriteReceipt {
	kind: "code-write";
	target: string;
	lines: number;
	bytes: number;
	sha256: string;
	changesApplied: boolean;
}

/** Observe the generated file, never the worker's completion prose. */
export async function observeCodeWrite(
	contract: Extract<DelegatedIo, { kind: "code-write" }>,
	targetLabel: string,
): Promise<CodeWriteReceipt> {
	const root = await fs.realpath(contract.workspaceRoot);
	const target = await fs.realpath(contract.target);
	if (!isPathWithinWorkspace(root, target) || (await fs.lstat(contract.target)).isSymbolicLink())
		throw new Error("Generated target escaped its workspace.");
	const content = await fs.readFile(target);
	if (!content.length) throw new Error("Generated target is empty.");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (!/\.(md|markdown|mdx)$/i.test(targetLabel) && /^\s*(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*\r?\n\1\s*$/.test(text)) {
		throw new Error("Generated non-Markdown target has an invalid full-file outer fence.");
	}
	return {
		kind: "code-write",
		target: targetLabel,
		lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
		bytes: content.byteLength,
		sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
		changesApplied: false,
	};
}
