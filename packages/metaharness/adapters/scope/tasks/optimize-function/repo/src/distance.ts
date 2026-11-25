/**
 * Edit distance between two strings: the fewest single-character insertions, deletions, and
 * substitutions that turn `a` into `b`.
 */
export function editDistance(a: string, b: string): number {
	const memo = new Map<string, number>();
	const solve = (i: number, j: number): number => {
		if (i === a.length) return b.length - j;
		if (j === b.length) return a.length - i;
		const key = `${i}:${j}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		const distance =
			a[i] === b[j] ? solve(i + 1, j + 1) : 1 + Math.min(solve(i + 1, j), solve(i, j + 1), solve(i + 1, j + 1));
		memo.set(key, distance);
		return distance;
	};
	return solve(0, 0);
}
