import { __isExtensionParseCacheAvailableForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

process.stdout.write(__isExtensionParseCacheAvailableForTests() ? "AVAILABLE\n" : "UNAVAILABLE\n");
