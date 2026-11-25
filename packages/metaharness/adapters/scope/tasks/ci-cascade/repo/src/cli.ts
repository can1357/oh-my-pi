import { renderMarkdown } from "./render";

const file = process.argv[2];
if (!file) {
	console.error("usage: mdlite <file.md>");
	process.exit(1);
}
console.log(renderMarkdown(await Bun.file(file).text()));
