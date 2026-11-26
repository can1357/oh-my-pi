import type { ArtifactAllocator } from "@oh-my-pi/pi-coding-agent/tools/streaming-output";

/** Allocator that hands an `OutputSink` the fixed file `path` as spill `id`. */
export function spillTo(path: string, id: string): ArtifactAllocator {
	return async () => ({ id, path });
}
