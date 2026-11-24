// Installs one MCP eval namespace; `eval-namespaces.ts` appends the `{ name, methods }` spec call.
// Each method runs its session tool through the `__mcp__` bridge op, which applies the tool's own
// approval, maps its content to a value, and throws on a tool error.
(spec => {
	const namespace = {};
	for (const method in spec.methods) {
		const tool = spec.methods[method];
		const label = `${spec.name}.${method}`;
		namespace[method] = args => globalThis.__omp_call_tool__("__mcp__", { tool, label, args: args ?? {} });
	}
	globalThis[spec.name] = Object.freeze(namespace);
})
