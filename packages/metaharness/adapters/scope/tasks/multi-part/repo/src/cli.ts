import { countWords } from "./count";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: wc-lite <file>...");
	process.exit(1);
}

for (const file of files) {
	const counts = countWords(await Bun.file(file).text());
	console.log(`${counts.lines}\t${counts.words}\t${counts.chars}\t${file}`);
}
