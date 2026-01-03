/**
 * Bun macro that inlines HTML template with CSS/JS at compile time.
 * This runs during `bun build` and embeds the result as a string.
 */
export async function getTemplate(): Promise<string> {
	const dir = new URL(".", import.meta.url).pathname;

	// Read all files
	const html = await Bun.file(`${dir}template.html`).text();
	const css = await Bun.file(`${dir}template.css`).text();
	const js = await Bun.file(`${dir}template.js`).text();

	// Minify CSS
	const minifiedCss = css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();

	// Inline everything
	return html
		.replace("<template-css/>", `<style>${minifiedCss}</style>`)
		.replace("<template-js/>", `<script>${js}</script>`);
}
