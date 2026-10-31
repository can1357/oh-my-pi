export function vectorNorm(v: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < v.length; i += 1) {
		const raw = v[i] ?? 0;
		const val = Number.isFinite(raw) ? raw : 0;
		sum += val * val;
	}
	return Math.sqrt(sum);
}

export function cosineSimilarityWithNorms(
	a: ArrayLike<number>,
	aNorm: number,
	b: ArrayLike<number>,
	bNorm: number,
): number {
	if (aNorm === 0 || bNorm === 0) {
		return 0;
	}
	const length = a.length < b.length ? a.length : b.length;
	let dot = 0;
	for (let i = 0; i < length; i += 1) {
		const rawA = a[i] ?? 0;
		const rawB = b[i] ?? 0;
		const av = Number.isFinite(rawA) ? rawA : 0;
		const bv = Number.isFinite(rawB) ? rawB : 0;
		dot += av * bv;
	}
	return dot / (aNorm * bNorm);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length === 0 && b.length === 0) {
		return 0;
	}
	return cosineSimilarityWithNorms(a, vectorNorm(a), b, vectorNorm(b));
}
