import { __rewriteLegacyExtensionSourceForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

const source = 'import value from "./dependency.js";\n';
const rewritten = await __rewriteLegacyExtensionSourceForTests(source, "/tmp/extension.ts", "7");
process.stdout.write(rewritten);
