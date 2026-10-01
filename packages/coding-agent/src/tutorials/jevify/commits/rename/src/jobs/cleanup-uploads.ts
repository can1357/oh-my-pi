import { logger } from "../log";

export const uploads = new Map<string, { size: number; referenced: boolean }>();

export function cleanupUploads(): number {
	let freed = 0;
	for (const [name, upload] of uploads) {
		if (upload.referenced) continue;
		freed += upload.size;
		uploads.delete(name);
	}
	logger.info("uploads cleaned", { freed });
	return freed;
}
