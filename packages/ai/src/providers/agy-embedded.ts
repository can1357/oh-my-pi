export interface EmbeddedAgyTransport {
	sha256: string;
	filename: string;
	size: number;
	zstdPath: string;
}

// Standalone builds replace this module through Bun.build({ files }), exactly
// like the native addon manifest. Source runs use the real dist executable.
export const embeddedAgyTransport: EmbeddedAgyTransport | null = null;
