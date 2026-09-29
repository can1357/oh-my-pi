import * as fs from "node:fs/promises";

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });

// Bundle the React app. CSS imported from TSX modules is emitted alongside as index.css.
console.log("Building dashboard client...");
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

// The inline script applies the persisted theme before first paint (no flash).
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>omp stats</title>
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
    <link rel="stylesheet" href="index.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
