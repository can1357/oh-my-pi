# Installs one MCP eval namespace; `eval-namespaces.ts` appends the call binding its global.
# Each method calls its session tool through the eval tool bridge, so the tool's own approval applies.
def _omp_mcp_namespace(name, methods):
    _tool_callable = _ToolCallable

    async def _call(tool, args, kwargs):
        value = await _tool_callable(tool)(args, **kwargs)
        if not isinstance(value, dict):
            return value
        if value.get("hasError"):
            raise RuntimeError(value.get("text") or f"{name} call failed")
        details = value.get("details")
        structured = details.get("structuredContent") if isinstance(details, dict) else None
        return structured if structured is not None else value.get("text")

    class _Namespace:
        __slots__ = ()

        def __repr__(self):
            return f"<mcp namespace {name}: {', '.join(sorted(methods))}>"

        def __dir__(self):
            return sorted(methods)

        def __getattr__(self, method):
            tool = methods.get(method)
            if tool is None:
                raise AttributeError(f"{name} has no method {method!r}; read xd://eval/{name}")

            async def _method(args=None, /, **kwargs):
                return await _call(tool, args, kwargs)

            _method.__name__ = method
            _method.__qualname__ = f"{name}.{method}"
            return _method

    return _Namespace()
