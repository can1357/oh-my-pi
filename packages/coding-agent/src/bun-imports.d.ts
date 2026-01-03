/**
 * Type declarations for Bun's import attributes.
 * These allow importing non-JS files as text or JSON at build time.
 */

// Markdown files imported as text
declare module "*.md" {
	const content: string;
	export default content;
}

// CSS files imported as text
declare module "*.css" {
	const content: string;
	export default content;
}

// HTML files imported as text
declare module "*.html" {
	const content: string;
	export default content;
}

// Text files imported as text
declare module "*.txt" {
	const content: string;
	export default content;
}
