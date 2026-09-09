export function sha256Hex16(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

const idSeed = crypto.getRandomValues(new Uint32Array(2));
let idCounter = 0;

function nextIdNonce(): string {
	idCounter = (idCounter + 1) >>> 0;
	return `${idSeed[0]?.toString(36) ?? "0"}:${idSeed[1]?.toString(36) ?? "0"}:${idCounter.toString(36)}`;
}

export function generateId(content: string, now: Date = new Date()): string {
	return sha256Hex16(`${content}\0${now.toISOString()}\0${nextIdNonce()}`);
}

export function stableMemoryId(content: string, source = ""): string {
	return source ? sha256Hex16(`${content}\0${source}`) : sha256Hex16(content);
}
