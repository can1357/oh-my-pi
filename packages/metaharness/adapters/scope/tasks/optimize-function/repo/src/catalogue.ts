/** The product catalogue, and seeded misspellings of its names for benchmarks and tests. */

const MATERIALS = [
	"Stainless Steel",
	"Bamboo",
	"Ceramic",
	"Recycled Glass",
	"Cast Iron",
	"Silicone",
	"Walnut",
	"Copper",
	"Linen",
	"Titanium",
];
const ITEMS = [
	"Water Bottle",
	"Cutting Board",
	"Coffee Mug",
	"Storage Jar",
	"Frying Pan",
	"Baking Mat",
	"Serving Tray",
	"Measuring Cup",
	"Tea Towel",
	"Camping Spork",
	"Lunch Box",
	"Salad Bowl",
];
const VARIANTS = [
	"Small",
	"Medium",
	"Large",
	"Set of 2",
	"Set of 4",
	"750ml",
	"1 Litre",
	"Matte Black",
	"Natural",
	"Limited Edition",
];

/** Every catalogue name: material, item, variant. */
export const CATALOGUE: readonly string[] = MATERIALS.flatMap(material =>
	ITEMS.flatMap(item => VARIANTS.map(variant => `${material} ${item} ${variant}`)),
);

/** How a shopper or supplier mangles a name. */
export type Mangle = "typos" | "truncated" | "shouting";

/** Seeded PRNG (mulberry32). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function mangle(name: string, how: Mangle, next: () => number): string {
	if (how === "truncated") return name.slice(0, name.length - 1 - Math.floor(next() * 4));
	if (how === "shouting") return `  ${name.toUpperCase()} `;
	const chars = [...name];
	for (let typo = 0; typo < 2; typo++) {
		const at = Math.floor(next() * chars.length);
		if (next() < 0.5) chars.splice(at, 1);
		else chars[at] = "x";
	}
	return chars.join("");
}

/** `count` mangled catalogue names; the same `seed` always yields the same list. */
export function mangledNames(count: number, how: Mangle, seed = 11): string[] {
	const next = random(seed);
	return Array.from({ length: count }, () => mangle(CATALOGUE[Math.floor(next() * CATALOGUE.length)], how, next));
}
