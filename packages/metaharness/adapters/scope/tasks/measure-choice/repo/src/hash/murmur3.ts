const encoder = new TextEncoder();

function rotl(value: number, bits: number): number {
	return (value << bits) | (value >>> (32 - bits));
}

/** 32-bit MurmurHash3 over the key's UTF-8 bytes, four bytes at a time. */
export function murmur3(key: string): number {
	const bytes = encoder.encode(key);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const blocks = bytes.length >> 2;
	let hash = 0x9747b28c;
	for (let block = 0; block < blocks; block++) {
		let k = view.getUint32(block * 4, true);
		k = Math.imul(k, 0xcc9e2d51);
		k = rotl(k, 15);
		k = Math.imul(k, 0x1b873593);
		hash ^= k;
		hash = rotl(hash, 13);
		hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
	}
	let tail = 0;
	for (let index = bytes.length - 1; index >= blocks * 4; index--) tail = (tail << 8) | bytes[index];
	if (bytes.length & 3) {
		tail = Math.imul(tail, 0xcc9e2d51);
		tail = rotl(tail, 15);
		tail = Math.imul(tail, 0x1b873593);
		hash ^= tail;
	}
	hash ^= bytes.length;
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	hash ^= hash >>> 16;
	return hash >>> 0;
}
