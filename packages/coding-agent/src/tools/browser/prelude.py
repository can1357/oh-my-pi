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

        async def dblclick(self, *args, **kwargs):
            return await self._method("dblclick", args, kwargs)

        async def check(self, *args, **kwargs):
            return await self._method("check", args, kwargs)

        async def uncheck(self, *args, **kwargs):
            return await self._method("uncheck", args, kwargs)

        async def highlight(self, *args, **kwargs):
            return await self._method("highlight", args, kwargs)

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

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def styles(self, *args, **kwargs):
            return await self._method("styles", args, kwargs)

        async def isEnabled(self, *args, **kwargs):
            return await self._method("isEnabled", args, kwargs)

        async def isChecked(self, *args, **kwargs):
            return await self._method("isChecked", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

    class _Frame:
        __slots__ = ("_name", "_selector")

        def __init__(self, name, selector):
            self._name = name
            self._selector = selector

        def __repr__(self):
            return f"<browser.Frame tab={self._name!r} selector={self._selector!r}>"

        async def _method(self, method, args, kwargs):
            return await _call(
                self._name,
                [
                    {"method": "frame", "args": [self._selector]},
                    {"method": method, "args": _arguments(args, kwargs)},
                ],
            )

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def count(self, *args, **kwargs):
            return await self._method("count", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

        async def waitFor(self, *args, **kwargs):
            return await self._method("waitFor", args, kwargs)

        async def waitForSelector(self, *args, **kwargs):
            return await self._method("waitForSelector", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

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

        async def back(self, *args, **kwargs):
            return await self._method("back", args, kwargs)

        async def forward(self, *args, **kwargs):
            return await self._method("forward", args, kwargs)

        async def reload(self, *args, **kwargs):
            return await self._method("reload", args, kwargs)

        async def pushState(self, *args, **kwargs):
            return await self._method("pushState", args, kwargs)

        async def frames(self, *args, **kwargs):
            return await self._method("frames", args, kwargs)

        async def dialog(self, *args, **kwargs):
            return await self._method("dialog", args, kwargs)

        async def handleDialog(self, *args, **kwargs):
            return await self._method("handleDialog", args, kwargs)

        async def setDialogs(self, *args, **kwargs):
            return await self._method("setDialogs", args, kwargs)

        async def observe(self, *args, **kwargs):
            return await self._method("observe", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def a11y(self, *args, **kwargs):
            return await self._method("a11y", args, kwargs)

        async def webmcpList(self, *args, **kwargs):
            return await self._method("webmcpList", args, kwargs)

        async def webmcpInvoke(self, *args, **kwargs):
            return await self._method("webmcpInvoke", args, kwargs)

        async def webmcpEvents(self, *args, **kwargs):
            return await self._method("webmcpEvents", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def diffScreenshot(self, *args, **kwargs):
            return await self._method("diffScreenshot", args, kwargs)

        async def pdf(self, *args, **kwargs):
            return await self._method("pdf", args, kwargs)

        async def extract(self, *args, **kwargs):
            return await self._method("extract", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def dblclick(self, *args, **kwargs):
            return await self._method("dblclick", args, kwargs)

        async def hover(self, *args, **kwargs):
            return await self._method("hover", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def check(self, *args, **kwargs):
            return await self._method("check", args, kwargs)

        async def uncheck(self, *args, **kwargs):
            return await self._method("uncheck", args, kwargs)

        async def keyDown(self, *args, **kwargs):
            return await self._method("keyDown", args, kwargs)

        async def keyUp(self, *args, **kwargs):
            return await self._method("keyUp", args, kwargs)

        async def mouseMove(self, *args, **kwargs):
            return await self._method("mouseMove", args, kwargs)

        async def mouseDown(self, *args, **kwargs):
            return await self._method("mouseDown", args, kwargs)

        async def mouseUp(self, *args, **kwargs):
            return await self._method("mouseUp", args, kwargs)

        async def clickAt(self, *args, **kwargs):
            return await self._method("clickAt", args, kwargs)

        async def wheel(self, *args, **kwargs):
            return await self._method("wheel", args, kwargs)

        async def highlight(self, *args, **kwargs):
            return await self._method("highlight", args, kwargs)

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

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def count(self, *args, **kwargs):
            return await self._method("count", args, kwargs)

        async def box(self, *args, **kwargs):
            return await self._method("box", args, kwargs)

        async def styles(self, *args, **kwargs):
            return await self._method("styles", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def isEnabled(self, *args, **kwargs):
            return await self._method("isEnabled", args, kwargs)

        async def isChecked(self, *args, **kwargs):
            return await self._method("isChecked", args, kwargs)

        async def waitForText(self, *args, **kwargs):
            return await self._method("waitForText", args, kwargs)

        async def emulate(self, *args, **kwargs):
            return await self._method("emulate", args, kwargs)

        async def devices(self, *args, **kwargs):
            return await self._method("devices", args, kwargs)

        async def clipboardRead(self, *args, **kwargs):
            return await self._method("clipboardRead", args, kwargs)

        async def clipboardWrite(self, *args, **kwargs):
            return await self._method("clipboardWrite", args, kwargs)

        async def clipboardCopy(self, *args, **kwargs):
            return await self._method("clipboardCopy", args, kwargs)

        async def clipboardPaste(self, *args, **kwargs):
            return await self._method("clipboardPaste", args, kwargs)

        async def cookies(self, *args, **kwargs):
            return await self._method("cookies", args, kwargs)

        async def setCookies(self, *args, **kwargs):
            return await self._method("setCookies", args, kwargs)

        async def clearCookies(self, *args, **kwargs):
            return await self._method("clearCookies", args, kwargs)

        async def storage(self, *args, **kwargs):
            return await self._method("storage", args, kwargs)

        async def setStorage(self, *args, **kwargs):
            return await self._method("setStorage", args, kwargs)

        async def clearStorage(self, *args, **kwargs):
            return await self._method("clearStorage", args, kwargs)

        async def saveState(self, *args, **kwargs):
            return await self._method("saveState", args, kwargs)

        async def loadState(self, *args, **kwargs):
            return await self._method("loadState", args, kwargs)

        async def addInitScript(self, *args, **kwargs):
            return await self._method("addInitScript", args, kwargs)

        async def removeInitScript(self, *args, **kwargs):
            return await self._method("removeInitScript", args, kwargs)

        async def initScripts(self, *args, **kwargs):
            return await self._method("initScripts", args, kwargs)

        async def waitForDownload(self, *args, **kwargs):
            return await self._method("waitForDownload", args, kwargs)

        async def downloads(self, *args, **kwargs):
            return await self._method("downloads", args, kwargs)

        async def console(self, *args, **kwargs):
            return await self._method("console", args, kwargs)

        async def errors(self, *args, **kwargs):
            return await self._method("errors", args, kwargs)

        async def clearConsole(self, *args, **kwargs):
            return await self._method("clearConsole", args, kwargs)

        async def traceStart(self, *args, **kwargs):
            return await self._method("traceStart", args, kwargs)

        async def traceStop(self, *args, **kwargs):
            return await self._method("traceStop", args, kwargs)

        async def profileStart(self, *args, **kwargs):
            return await self._method("profileStart", args, kwargs)

        async def profileStop(self, *args, **kwargs):
            return await self._method("profileStop", args, kwargs)

        async def metrics(self, *args, **kwargs):
            return await self._method("metrics", args, kwargs)

        async def route(self, *args, **kwargs):
            return await self._method("route", args, kwargs)

        async def unroute(self, *args, **kwargs):
            return await self._method("unroute", args, kwargs)

        async def routes(self, *args, **kwargs):
            return await self._method("routes", args, kwargs)

        async def requests(self, *args, **kwargs):
            return await self._method("requests", args, kwargs)

        async def request(self, *args, **kwargs):
            return await self._method("request", args, kwargs)

        async def clearRequests(self, *args, **kwargs):
            return await self._method("clearRequests", args, kwargs)

        async def harStart(self, *args, **kwargs):
            return await self._method("harStart", args, kwargs)

        async def harStop(self, *args, **kwargs):
            return await self._method("harStop", args, kwargs)

        async def allowedDomains(self, *args, **kwargs):
            return await self._method("allowedDomains", args, kwargs)

        async def vitals(self, *args, **kwargs):
            return await self._method("vitals", args, kwargs)

        async def reactEnable(self, *args, **kwargs):
            return await self._method("reactEnable", args, kwargs)

        async def reactTree(self, *args, **kwargs):
            return await self._method("reactTree", args, kwargs)

        async def reactInspect(self, *args, **kwargs):
            return await self._method("reactInspect", args, kwargs)

        async def reactRenders(self, *args, **kwargs):
            return await self._method("reactRenders", args, kwargs)

        async def reactSuspense(self, *args, **kwargs):
            return await self._method("reactSuspense", args, kwargs)

        async def recordStart(self, *args, **kwargs):
            return await self._method("recordStart", args, kwargs)

        async def recordStop(self, *args, **kwargs):
            return await self._method("recordStop", args, kwargs)

        async def recordRestart(self, *args, **kwargs):
            return await self._method("recordRestart", args, kwargs)

        async def recording(self, *args, **kwargs):
            return await self._method("recording", args, kwargs)

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

        def frame(self, selector_or_name_or_url):
            """Return a synchronous proxy for a child frame."""
            if not isinstance(selector_or_name_or_url, str) or not selector_or_name_or_url:
                raise TypeError("tab.frame() expects a non-empty selector, name, or URL")
            return _Frame(self._name, selector_or_name_or_url)

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
            allowed_domains=None,
            init_scripts=None,
            downloads=None,
            user_agent=None,
            ignore_https_errors=None,
            allow_file_access=None,
            headed=None,
            timeout=None,
            persist=None,
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
                    "allowed_domains": allowed_domains,
                    "init_scripts": init_scripts,
                    "downloads": downloads,
                    "user_agent": user_agent,
                    "ignore_https_errors": ignore_https_errors,
                    "allow_file_access": allow_file_access,
                    "headed": headed,
                    "timeout": timeout,
                    "persist": persist,
                },
            )
            opened_name = details.get("name")
            if not isinstance(opened_name, str) or not opened_name:
                raise RuntimeError("browser.open() returned an invalid tab name")
            return _Tab(opened_name)

        def tab(self, name="main"):
            """Re-acquire a synchronous handle for an existing named tab."""
            return _Tab(_require_name(name, "browser.tab()"))

        async def tabs(self):
            """List managed browser tabs."""
            details = await _invoke("tabs", {})
            value = details.get("value")
            return value if isinstance(value, list) else []

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
