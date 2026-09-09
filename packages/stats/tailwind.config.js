/** @type {import('tailwindcss').Config} */
import * as path from "node:path";
export default {
	content: [path.join(import.meta.dir, "src", "client", "**/*.{js,jsx,ts,tsx}")],
	darkMode: "class",
	theme: {
		extend: {
			colors: {
				page: "var(--bg-page)",
				surface: "var(--bg-surface)",
				elevated: "var(--bg-elevated)",
				"border-subtle": "var(--border-subtle)",
				"border-default": "var(--border-default)",
				"text-primary": "var(--text-primary)",
				"text-secondary": "var(--text-secondary)",
				"text-muted": "var(--text-muted)",
				pink: "var(--accent-pink)",
				cyan: "var(--accent-cyan)",
				violet: "var(--accent-violet)",
			},
			fontFamily: {
				sans: [
					"-apple-system",
					"BlinkMacSystemFont",
					'"Segoe UI"',
					"Roboto",
					"Helvetica",
					"Arial",
					"sans-serif",
				],
			},
			borderRadius: {
				sm: "var(--radius-sm)",
				md: "var(--radius-md)",
				lg: "var(--radius-lg)",
			},
		},
	},
	plugins: [],
};
