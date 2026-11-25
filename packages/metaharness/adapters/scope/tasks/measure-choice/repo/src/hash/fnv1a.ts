/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a(key: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index++) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
