import * as fs from "node:fs";
import { parseToolFileHeader } from "@oh-my-pi/pi-tui/overlays/extensions/inspector-model";

const TOOL_HEADER_BYTES = 4096;
const toolHeaderCache = new Map<string, { mtimeMs: number; description: string | undefined }>();

export function toolFileHeaderDescription(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try {
		const stat = fs.statSync(filePath);
		const cached = toolHeaderCache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.description;
		const fd = fs.openSync(filePath, "r");
		try {
			const length = Math.min(TOOL_HEADER_BYTES, stat.size);
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fd, buf, 0, length, 0);
			const description = parseToolFileHeader(buf.toString("utf8", 0, n));
			toolHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, description });
			return description;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}
