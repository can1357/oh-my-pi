export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const length = a.length > b.length ? a.length : b.length;
	if (length === 0) {
		return 0;
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i += 1) {
		const rawA = a[i] ?? 0;
		const rawB = b[i] ?? 0;
		const av = Number.isFinite(rawA) ? rawA : 0;
		const bv = Number.isFinite(rawB) ? rawB : 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
