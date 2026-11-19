import { exportFromFile } from "../../src/export/html";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath) throw new Error("Expected an input session file");
process.stdout.write(await exportFromFile(inputPath, outputPath));
