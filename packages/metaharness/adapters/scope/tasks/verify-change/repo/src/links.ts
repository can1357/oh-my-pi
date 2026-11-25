import { slugify } from "./slug";

export interface Link {
	slug: string;
	url: string;
}

/** Links keyed by slug. A title whose slug is taken gets `-2`, `-3`, … appended. */
export class LinkTable {
	#links = new Map<string, Link>();

	add(title: string, url: string): Link {
		const base = slugify(title) || "link";
		let slug = base;
		for (let n = 2; this.#links.has(slug); n++) slug = `${base}-${n}`;
		const link = { slug, url };
		this.#links.set(slug, link);
		return link;
	}

	get(slug: string): Link | undefined {
		return this.#links.get(slug);
	}
}
