// @ts-check
/**
 * GitHub Pages serves this site under the project path (/oh-my-pi/), so every
 * internal URL needs the `base` prefix. Astro prefixes the links it generates
 * (sidebar, pagination, assets) but not absolute paths authored in markdown —
 * and the docs convention is exactly those (`[Sessions](/features/sessions/)`,
 * per src/content/docs/_template.md). This rehype plugin prepends `base` to
 * root-relative hrefs/srcs in rendered content so authored links resolve under
 * the project path, with zero content edits and surviving upstream syncs.
 *
 * Wired via the `@astrojs/mdx` integration in astro.config.mjs (covers
 * Starlight content collections) and via `markdown.processor: unified(...)`
 * (covers standalone .md pages like the 404 fallback).
 */

/** @import { Root, Element } from 'hast'; */

const DEFAULT_BASE = '/oh-my-pi/';

/**
 * @param {{ base?: string }} [options]
 */
export function rehypePrefixBase(options = {}) {
	const base = options.base ?? DEFAULT_BASE;
	const prefix = base.replace(/\/$/, '');

	/**
	 * @param {string} value
	 * @returns {string}
	 */
	const rewrite = (value) =>
		value.startsWith('/') && !value.startsWith('//') && !value.startsWith(prefix)
			? `${prefix}${value}`
			: value;

	/**
	 * @param {Root | Element} node
	 */
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'element') {
			const { properties } = node;
			if (properties) {
				if (typeof properties.href === 'string') properties.href = rewrite(properties.href);
				if (typeof properties.src === 'string') properties.src = rewrite(properties.src);
			}
		}
		const children = node.children;
		if (!Array.isArray(children)) return;
		for (const child of children) {
			if (child && child.type === 'element') visit(child);
		}
	};

	return (tree) => {
		visit(tree);
	};
}
