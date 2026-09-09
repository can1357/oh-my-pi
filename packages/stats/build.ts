import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";

/**
 * Extract Tailwind class names from source files by scanning for className attributes.
 */
async function extractTailwindClasses(dir: string): Promise<Set<string>> {
	const classes = new Set<string>();
	const classPattern = /className\s*=\s*["'`]([^"'`]+)["'`]/g;

	async function scanDir(currentDir: string): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await scanDir(fullPath);
			} else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
				const content = await Bun.file(fullPath).text();
				const matches = content.matchAll(classPattern);
				for (const match of matches) {
					for (const cls of match[1].split(/\s+/)) {
						if (cls) classes.add(cls);
					}
				}
			}
		}
	}

	await scanDir(dir);
	return classes;
}

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });

// Build Tailwind CSS
console.log("Building Tailwind CSS...");
const sourceCss = await Bun.file("./src/client/styles.css").text();
const candidates = await extractTailwindClasses("./src/client");
const baseDir = path.resolve("./src/client");

const compiler = await compile(sourceCss, {
	base: baseDir,
	onDependency: () => {},
});
const tailwindOutput = compiler.build([...candidates]);
await Bun.write("./dist/client/styles.css", tailwindOutput);

// Build React app
console.log("Building React app...");
const result = await Bun.build({
	entrypoints: ["./src/client/index.tsx"],
	outdir: "./dist/client",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

// Create index.html
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <script>
      (function () {
        try {
          var stored = localStorage.getItem("omp-stats-theme");
          var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          var theme = stored === "light" || stored === "dark" ? stored : system;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
