/**
 * `parseV8HeapSnapshot`, the decoder every heap test reads its snapshots through (this thread's, and the ones a
 * worker writes), against snapshots whose schema lacks what `HeapGraph` reads.
 */
import { describe, expect, it } from "bun:test";
import { HeapGraph, parseV8HeapSnapshot, type V8HeapSnapshot } from "./heap-snapshot";

/**
 * Two nodes: node 0, an object `Holder` of 16 bytes, whose property `text` is node 1, the 5-byte string `hello`.
 * Each node has five fields (`id` is one `HeapGraph` does not read); each edge has three.
 */
function minimal(): V8HeapSnapshot {
	return {
		snapshot: {
			meta: {
				node_fields: ["type", "name", "id", "self_size", "edge_count"],
				node_types: [["object", "string"], "string", "number", "number", "number"],
				edge_fields: ["type", "name_or_index", "to_node"],
				edge_types: [["property", "element"], "string_or_number", "node"],
			},
		},
		nodes: [0, 0, 1, 16, 1, 1, 1, 2, 5, 0],
		// `to_node` is the index of the target's first field: node 1 starts at 5.
		edges: [0, 2, 5],
		strings: ["Holder", "hello", "text"],
	};
}

describe("parseV8HeapSnapshot", () => {
	it("decodes a snapshot that has every field HeapGraph reads into nodes, edges and strings", () => {
		// If this regresses, every heap test fails to read a well-formed snapshot, or reads its nodes, edges or
		// sizes at the wrong offsets and counts copies of the wrong strings.
		const graph = new HeapGraph(parseV8HeapSnapshot(minimal()));
		expect({
			holder: { type: graph.type(0), name: graph.name(0), edges: graph.edges(0) },
			text: graph.stringNodes(text => text === "hello").map(node => ({ node, size: graph.selfSize(node) })),
			holdersOfText: graph.objectsWithStringProperty("text", "hello"),
		}).toEqual({
			holder: { type: "object", name: "Holder", edges: [{ type: "property", name: "text", to: 1 }] },
			text: [{ node: 1, size: 5 }],
			holdersOfText: [0],
		});
	});

	// If one of these regresses, a snapshot without a field `HeapGraph` reads, or with a record cut short, decodes
	// anyway: `HeapGraph` reads that field at index -1 or past a record's end, and a heap test counts sizes of
	// `undefined` or walks the wrong edges instead of failing on the snapshot.
	const malformed: ReadonlyArray<{ name: string; change: (snapshot: V8HeapSnapshot) => void; error: string }> = [
		{
			name: "node fields without self_size",
			change: snapshot => {
				snapshot.snapshot.meta.node_fields[3] = "size";
			},
			error: "V8 heap snapshot schema: snapshot.meta.node_fields lacks self_size",
		},
		{
			name: "node fields without edge_count",
			change: snapshot => {
				snapshot.snapshot.meta.node_fields[4] = "edges";
			},
			error: "V8 heap snapshot schema: snapshot.meta.node_fields lacks edge_count",
		},
		{
			name: "edge fields without to_node",
			change: snapshot => {
				snapshot.snapshot.meta.edge_fields[2] = "to";
			},
			error: "V8 heap snapshot schema: snapshot.meta.edge_fields lacks to_node",
		},
		{
			name: "node types without the names of the node type field",
			change: snapshot => {
				snapshot.snapshot.meta.node_types[0] = "object";
			},
			error: "V8 heap snapshot schema: snapshot.meta.node_types has no list of names for the node type field",
		},
		{
			name: "edge types without the names of the edge type field",
			change: snapshot => {
				snapshot.snapshot.meta.edge_types[0] = "property";
			},
			error: "V8 heap snapshot schema: snapshot.meta.edge_types has no list of names for the edge type field",
		},
		{
			name: "nodes that end inside a record",
			change: snapshot => {
				snapshot.nodes.push(0);
			},
			error: "V8 heap snapshot schema: nodes has 11 numbers, not whole records of 5 node fields",
		},
		{
			name: "edges that end inside a record",
			change: snapshot => {
				snapshot.edges.pop();
			},
			error: "V8 heap snapshot schema: edges has 2 numbers, not whole records of 3 edge fields",
		},
	];
	for (const { name, change, error } of malformed) {
		it(`rejects a snapshot with ${name}, naming what is wrong`, () => {
			const snapshot = minimal();
			change(snapshot);
			expect(() => parseV8HeapSnapshot(snapshot)).toThrow(error);
		});
	}
});
