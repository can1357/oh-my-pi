/**
 * Type declarations for Bun's import attributes.
 * These allow importing non-JS files as text at build time.
 */

// Markdown files imported as text
declare module "*.md" {
	const content: string;
	export default content;
}

// Text files imported as text
declare module "*.txt" {
	const content: string;
	export default content;
}
