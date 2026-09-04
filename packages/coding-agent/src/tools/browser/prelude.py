def _make_browser():
    import re

    def _require_name(name, label):
        if not isinstance(name, str) or not name:
            raise TypeError(f"{label} expects a tab name")
        return name

    def _encode_arg(value):
        if isinstance(value, re.Pattern):
            if not isinstance(value.pattern, str):
                raise TypeError("browser helpers require regular expressions with string patterns")
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
            "browser",
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
            raise RuntimeError("browser returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        details = response.get("details")
        if not isinstance(details, dict):
            raise RuntimeError("browser returned invalid response details")
        return details

    async def _call(name, chain):
        details = await _invoke("call", {"name": name, "chain": chain})
        return details.get("value")

    class _Element:
        __slots__ = ("_name", "_handle_method", "_handle_value")

        def __init__(self, name, handle_method, handle_value):
            self._name = name
            self._handle_method = handle_method
            self._handle_value = handle_value

        def __repr__(self):
            return (
                f"<browser.Element tab={self._name!r} "
                f"{self._handle_method}={self._handle_value!r}>"
            )

        async def _method(self, method, args, kwargs):
            return await _call(
                self._name,
                [
                    {"method": self._handle_method, "args": [self._handle_value]},
                    {"method": method, "args": _arguments(args, kwargs)},
                ],
            )

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def hover(self, *args, **kwargs):
            return await self._method("hover", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def select(self, *args, **kwargs):
            return await self._method("select", args, kwargs)

        async def uploadFile(self, *args, **kwargs):
            return await self._method("uploadFile", args, kwargs)

        async def scrollIntoView(self, *args, **kwargs):
            return await self._method("scrollIntoView", args, kwargs)

        async def boundingBox(self, *args, **kwargs):
            return await self._method("boundingBox", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def isHidden(self, *args, **kwargs):
            return await self._method("isHidden", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

    class _Tab:
        __slots__ = ("_name",)

        def __init__(self, name):
            self._name = _require_name(name, "tab name")

        @property
        def name(self):
            """The host-side tab name used by this handle."""
            return self._name

        def __repr__(self):
            return f"<browser.Tab name={self._name!r}>"

        async def _method(self, method, args, kwargs):
            return await _call(
                self._name,
                [{"method": method, "args": _arguments(args, kwargs)}],
            )

        async def url(self, *args, **kwargs):
            return await self._method("url", args, kwargs)

        async def title(self, *args, **kwargs):
            return await self._method("title", args, kwargs)

        async def goto(self, *args, **kwargs):
            return await self._method("goto", args, kwargs)

        async def observe(self, *args, **kwargs):
            return await self._method("observe", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def extract(self, *args, **kwargs):
            return await self._method("extract", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scrollIntoView(self, *args, **kwargs):
            return await self._method("scrollIntoView", args, kwargs)

        async def select(self, *args, **kwargs):
            return await self._method("select", args, kwargs)

        async def uploadFile(self, *args, **kwargs):
            return await self._method("uploadFile", args, kwargs)

        async def waitForUrl(self, *args, **kwargs):
            return await self._method("waitForUrl", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

        async def waitFor(self, *args, **kwargs):
            return await self._method("waitFor", args, kwargs)

        async def waitForSelector(self, *args, **kwargs):
            return await self._method("waitForSelector", args, kwargs)

        def id(self, element_id):
            """Return a synchronous handle for a numeric observed element id."""
            if isinstance(element_id, bool) or not isinstance(element_id, int):
                raise TypeError("tab.id() expects an integer element id")
            return _Element(self._name, "id", element_id)

        def ref(self, ref_id):
            """Return a synchronous handle for an ARIA reference id."""
            if not isinstance(ref_id, str) or not ref_id:
                raise TypeError("tab.ref() expects a non-empty reference id")
            return _Element(self._name, "ref", ref_id)

        async def run(self, code, *, timeout=None):
            """Run a JavaScript code string in this tab and return its value."""
            if not isinstance(code, str) or not code.strip():
                raise TypeError("tab.run() expects a JavaScript code string")
            details = await _invoke(
                "run",
                {"name": self._name, "code": code, "timeout": timeout},
            )
            return details.get("value")

        async def close(self, *, kill=None, timeout=None):
            """Close this tab handle's host-side tab."""
            await _invoke(
                "close",
                {"name": self._name, "kill": kill, "timeout": timeout},
            )

    class _Browser:
        __slots__ = ()

        def __repr__(self):
            return "<browser>"

        async def open(
            self,
            *,
            name=None,
            url=None,
            app=None,
            viewport=None,
            wait_until=None,
            dialogs=None,
            timeout=None,
        ):
            """Open or attach to a browser tab and return its handle."""
            if name is not None:
                _require_name(name, "browser.open()")
            details = await _invoke(
                "open",
                {
                    "name": name,
                    "url": url,
                    "app": app,
                    "viewport": viewport,
                    "wait_until": wait_until,
                    "dialogs": dialogs,
                    "timeout": timeout,
                },
            )
            opened_name = details.get("name")
            if not isinstance(opened_name, str) or not opened_name:
                raise RuntimeError("browser.open() returned an invalid tab name")
            return _Tab(opened_name)

        def tab(self, name="main"):
            """Re-acquire a synchronous handle for an existing named tab."""
            return _Tab(_require_name(name, "browser.tab()"))

        async def close(self, *, name=None, all=None, kill=None, timeout=None):
            """Close one or all managed browser tabs."""
            if name is not None:
                _require_name(name, "browser.close()")
            await _invoke(
                "close",
                {"name": name, "all": all, "kill": kill, "timeout": timeout},
            )

    return _Browser()


browser = _make_browser()
del _make_browser
