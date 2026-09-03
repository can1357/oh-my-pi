import * as fs from "node:fs";
import "@babel/traverse";

const modules = Object.keys(require.cache)
	.filter(modulePath => {
		const normalizedPath = modulePath.replaceAll("\\", "/");
		return (
			normalizedPath.includes("/node_modules/@babel/traverse/") ||
			normalizedPath.includes("/node_modules/@babel/types/")
		);
	})
	.sort();
const bytes = modules.reduce((total, modulePath) => total + fs.statSync(modulePath).size, 0);

process.stdout.write(JSON.stringify({ modules: modules.length, bytes, paths: modules }));
