// Installs one MCP eval namespace; `eval-namespaces.ts` appends the `{ name, methods }` spec call.
// Each method calls its session tool through the eval tool bridge, so the tool's own approval applies.
(spec => {
	const call = async (tool, args) => {
		const value = await globalThis.__omp_call_tool__(tool, args ?? {});
		if (value === null || typeof value !== "object") return value;
		if (value.hasError) throw new Error(value.text || `${spec.name} call failed`);
		return value.details?.structuredContent ?? value.text;
	};
	const namespace = {};
	for (const method in spec.methods) {
		const tool = spec.methods[method];
		namespace[method] = args => call(tool, args);
	}
	globalThis[spec.name] = Object.freeze(namespace);
})
