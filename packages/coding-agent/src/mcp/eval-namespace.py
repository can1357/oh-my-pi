# Installs one MCP eval namespace; `eval-namespaces.ts` appends the call binding its global.
# Each method runs its session tool through the `__mcp__` bridge op, which applies the tool's own
# approval, maps its content to a value, and raises on a tool error.
def _omp_mcp_namespace(name, methods):
    _bridge = _bridge_call
    _to_thread = _omp_asyncio.to_thread

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
            label = f"{name}.{method}"

            async def _method(args=None, /, **kwargs):
                if args is None:
                    merged = dict(kwargs)
                elif isinstance(args, dict):
                    merged = {**args, **kwargs}
                else:
                    raise TypeError(f"{label}(...) expects keyword arguments or one dict (got {type(args).__name__})")
                return await _to_thread(_bridge, "__mcp__", {"tool": tool, "label": label, "args": merged})

            _method.__name__ = method
            _method.__qualname__ = label
            return _method

    return _Namespace()
