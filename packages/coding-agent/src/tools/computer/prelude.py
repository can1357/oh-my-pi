def _make_computer():
    import re

    def _encode_arg(value):
        if isinstance(value, re.Pattern):
            if not isinstance(value.pattern, str):
                raise TypeError("computer helpers require regular expressions with string patterns")
            flags = ""
            if value.flags & re.IGNORECASE:
                flags += "i"
            if value.flags & re.MULTILINE:
                flags += "m"
            if value.flags & re.DOTALL:
                flags += "s"
            return {"__omp_re": {"source": value.pattern, "flags": flags}}
        return value

    def _arguments(args, kwargs):
        values = list(args)
        while values and values[-1] is None:
            values.pop()
        values = [_encode_arg(value) for value in values]
        options = {
            key: _encode_arg(value)
            for key, value in kwargs.items()
            if value is not None
        }
        if options:
            values.append(options)
        return values

    async def _invoke(action, options):
        response = await _omp_prelude(
            "computer",
            {
                **{
                    key: value
                    for key, value in options.items()
                    if value is not None
                },
                "action": action,
            },
        )
        if not isinstance(response, dict):
            raise RuntimeError("computer returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        details = response.get("details")
        return details if isinstance(details, dict) else {}

    async def _call(chain):
        details = await _invoke("call", {"chain": chain})
        return details.get("value")

    def _step(method, args, kwargs):
        return {"method": method, "args": _arguments(args, kwargs)}

    class _Element:
        __slots__ = ("ref", "role", "nativeRole", "title", "description", "enabled", "focused", "childCount")

        def __init__(self, snapshot):
            for field in self.__slots__:
                setattr(self, field, snapshot.get(field))

        def __repr__(self):
            return f"<computer.Element ref={self.ref!r} role={self.role!r}>"

        async def _method(self, method, args, kwargs):
            return await _call([_step("ref", (self.ref,), {}), _step(method, args, kwargs)])

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def setValue(self, *args, **kwargs):
            return await self._method("setValue", args, kwargs)

        async def bounds(self, *args, **kwargs):
            return await self._method("bounds", args, kwargs)

        async def attributes(self, *args, **kwargs):
            return await self._method("attributes", args, kwargs)

        async def actions(self, *args, **kwargs):
            return await self._method("actions", args, kwargs)

        async def perform(self, *args, **kwargs):
            return await self._method("perform", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def parent(self):
            snapshot = await self._method("parent", (), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def children(self):
            return [_Element(snapshot) for snapshot in await self._method("children", (), {})]

    class _Window:
        __slots__ = ("id", "app", "title", "pid", "bounds", "focused")

        def __init__(self, snapshot):
            for field in self.__slots__:
                setattr(self, field, snapshot.get(field))

        def __repr__(self):
            return f"<computer.Window id={self.id!r} app={self.app!r}>"

        async def _method(self, method, args, kwargs):
            return await _call([_step("window", (self.id,), {}), _step(method, args, kwargs)])

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def move(self, *args, **kwargs):
            return await self._method("move", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def raise_(self, *args, **kwargs):
            return await self._method("raise", args, kwargs)

        async def ax(self, *args, **kwargs):
            return await self._method("ax", args, kwargs)

        async def find(self, *args, **kwargs):
            return [_Element(snapshot) for snapshot in await self._method("find", args, kwargs)]

        async def ref(self, ref):
            """Resolve a live accessibility element by its `[ref=eN]` tag."""
            snapshot = await _call([_step("ref", (ref,), {})])
            return _Element(snapshot) if isinstance(snapshot, dict) else None

    class _Clipboard:
        __slots__ = ()

        async def read(self):
            return await _call([_step("clipboard.read", (), {})])

        async def write(self, text):
            return await _call([_step("clipboard.write", (text,), {})])

    class _Computer:
        __slots__ = ("clipboard",)

        def __init__(self):
            self.clipboard = _Clipboard()

        def __repr__(self):
            return "<computer>"

        async def _method(self, method, args, kwargs):
            return await _call([_step(method, args, kwargs)])

        async def displays(self, *args, **kwargs):
            return await self._method("displays", args, kwargs)

        async def windows(self, *args, **kwargs):
            return await self._method("windows", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def move(self, *args, **kwargs):
            return await self._method("move", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def window(self, *args, **kwargs):
            """Resolve one window by opaque id or by `app`/`title` filter keywords."""
            snapshot = await self._method("window", args, kwargs)
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        async def focusedWindow(self):
            snapshot = await self._method("focusedWindow", (), {})
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        async def elementAt(self, x, y):
            snapshot = await self._method("elementAt", (x, y), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def focusedElement(self):
            snapshot = await self._method("focusedElement", (), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def ref(self, ref):
            """Resolve a live accessibility element by its `[ref=eN]` tag."""
            snapshot = await self._method("ref", (ref,), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def run(self, code, *, read_only=None, timeout=None):
            """Run a JavaScript code string in the persistent desktop session and return its value."""
            if not isinstance(code, str):
                raise TypeError("computer.run() expects a JavaScript code string")
            details = await _invoke(
                "run",
                {"code": code, "read_only": read_only, "timeout": timeout},
            )
            return details.get("value")

        async def capabilities(self):
            """Return native backend capabilities and permission state, or None when unavailable."""
            details = await _invoke("capabilities", {})
            return details if "backend" in details else None

        async def close(self):
            """End the persistent desktop session; later calls fail."""
            await _invoke("close", {})

    return _Computer()


computer = _make_computer()
del _make_computer
