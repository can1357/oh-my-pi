declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.txt" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "*.rb" {
	const content: string;
	export default content;
}

declare module "*.jl" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.sh" {
	const content: string;
	export default content;
}

declare module "*.applescript" {
	const content: string;
	export default content;
}

declare module "*.bdf" {
	const content: string;
	export default content;
}

// Session-export template assets imported as text (coding-agent src/export/html).
// No `*.html` declaration: bun-types claims that pattern as HTMLBundle, so the
// text import casts at the use site instead.
declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*/template.js" {
	const content: string;
	export default content;
}

declare module "*.generated.js" {
	const content: string;
	export default content;
}

