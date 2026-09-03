import "../../src/utils/changelog";

interface V8HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	strings: string[];
}

const LARGE_STRING_MIN_SIZE = 1024 * 1024;

Bun.gc(true);
const heap = JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
const { node_fields: nodeFields, node_types: nodeTypes } = heap.snapshot.meta;
const typeOffset = nodeFields.indexOf("type");
const nameOffset = nodeFields.indexOf("name");
const sizeOffset = nodeFields.indexOf("self_size");
const typeNames = nodeTypes[typeOffset];
if (typeOffset < 0 || nameOffset < 0 || sizeOffset < 0 || !Array.isArray(typeNames)) {
	throw new Error("Unexpected V8 heap snapshot schema");
}

let retainedChangelogStrings = 0;
for (let nodeOffset = 0; nodeOffset < heap.nodes.length; nodeOffset += nodeFields.length) {
	if (typeNames[heap.nodes[nodeOffset + typeOffset]!] !== "string") continue;
	const value = heap.strings[heap.nodes[nodeOffset + nameOffset]!];
	const selfSize = heap.nodes[nodeOffset + sizeOffset]!;
	if (value !== undefined && selfSize > LARGE_STRING_MIN_SIZE && value.startsWith("# Changelog")) {
		retainedChangelogStrings++;
	}
}

process.stdout.write(JSON.stringify({ retainedChangelogStrings }));
