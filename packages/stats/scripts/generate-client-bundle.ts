#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const GENERATED_FILE = path.join("src", "embedded-client.generated.txt");
const DIST_CLIENT_DIR = path.join("dist", "client");

const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";

const TAR_BLOCK_SIZE = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_MTIME_OFFSET = 136;
const TAR_MTIME_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;

// `--reset` restores the checked-in state: an empty file. The runtime treats
// blank (or any non-base64) content as "no archive embedded" and builds the
// dashboard from source instead; see src/embedded-client.ts.

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	files.sort();
	return files;
}

function readTarOctal(bytes: Uint8Array, offset: number, length: number): number {
	const value = Buffer.from(bytes.subarray(offset, offset + length))
		.toString("ascii")
		.replace(/\0.*$/, "")
		.trim();
	return value ? Number.parseInt(value, 8) : 0;
}

function writeTarOctal(bytes: Uint8Array, offset: number, length: number, value: number): void {
	const octal = value.toString(8);
	if (octal.length >= length) throw new Error(`Tar value ${value} does not fit in ${length} bytes`);
	bytes.fill(0x30, offset, offset + length - 1);
	bytes.set(Buffer.from(octal), offset + length - 1 - octal.length);
	bytes[offset + length - 1] = 0;
}

function normalizeTarMetadata(bytes: Uint8Array): void {
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= bytes.length; ) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every(byte => byte === 0)) return;

		const size = readTarOctal(header, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
		writeTarOctal(header, TAR_MTIME_OFFSET, TAR_MTIME_LENGTH, 0);
		header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH);

		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumOctal = checksum.toString(8).padStart(6, "0");
		if (checksumOctal.length > 6) throw new Error(`Tar checksum ${checksum} exceeds the header field`);
		header.set(Buffer.from(checksumOctal), TAR_CHECKSUM_OFFSET);
		header[TAR_CHECKSUM_OFFSET + 6] = 0;
		header[TAR_CHECKSUM_OFFSET + 7] = 0x20;

		offset += TAR_BLOCK_SIZE * (1 + Math.ceil(size / TAR_BLOCK_SIZE));
		if (offset > bytes.length) throw new Error("Tar entry extends beyond the archive");
	}
}

/** Build a byte-stable gzip archive of a directory for embedding in the OMP binary. */
export async function buildArchiveBase64(dir: string): Promise<string> {
	const files = await collectFiles(dir);
	const entries: Record<string, Uint8Array> = {};
	for (const filePath of files) {
		const relativePath = path.relative(dir, filePath).split(path.sep).join("/");
		entries[relativePath] = await Bun.file(filePath).bytes();
	}

	const archiveBytes = await new Bun.Archive(entries).bytes();
	normalizeTarMetadata(archiveBytes);
	return Buffer.from(Bun.gzipSync(archiveBytes, { level: 9 })).toString("base64");
}

async function main(): Promise<void> {
	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(GENERATED_FILE, "");
		console.log(`Reset ${GENERATED_FILE}`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		console.log(`Skipping ${GENERATED_FILE}; pass ${GENERATE_FLAG} to build the embedded bundle`);
		return;
	}

	await $`bun run build`;
	const archiveBase64 = await buildArchiveBase64(DIST_CLIENT_DIR);
	await Bun.write(GENERATED_FILE, archiveBase64);
	console.log(`Generated ${GENERATED_FILE}`);
}

if (import.meta.main) await main();
