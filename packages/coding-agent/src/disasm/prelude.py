def _make_dsm():
    async def _call(action, parameters=None):
        response = await _omp_prelude(
            "dsm",
            {
                **{key: value for key, value in (parameters or {}).items() if value is not None},
                "action": action,
            },
        )
        if not isinstance(response, dict) or not isinstance(response.get("details"), dict) or "value" not in response["details"]:
            raise RuntimeError("dsm returned an invalid response")
        return response["details"]["value"]

    class _Database:
        __slots__ = ("id", "backend", "ref", "path", "info", "_lease", "_handle", "_backend")

        def __init__(self, descriptor):
            self.id = descriptor["id"]
            self.backend = descriptor["backend"]
            self.ref = descriptor["ref"]
            self.path = descriptor["path"]
            self.info = descriptor["info"]
            self._lease = descriptor["lease"]
            self._handle = descriptor["handle"]
            self._backend = descriptor["backend"]

        def __repr__(self):
            return f"dsm.Database({self.backend}:{self.id})"

        def handle(self):
            return self._handle

        async def _run(self, action, parameters=None):
            return await _call(action, {**(parameters or {}), "lease": self._lease, "backend": self._backend})

        async def view(self, view="overview"):
            return await self._run("view", {"view": view})

        async def exec(self, code, *, timeout=None):
            return await self._run("exec", {"code": code, "timeout": timeout})

        async def rename(self, target, name):
            return await self._run("rename", {"target": target, "name": name})

        async def comment(self, target, text, *, repeatable=False):
            return await self._run("comment", {"target": target, "text": text, "repeatable": repeatable})

        async def set_type(self, target, decl):
            return await self._run("set_type", {"target": target, "decl": decl})

        async def make_function(self, target):
            return await self._run("make_function", {"target": target})

        async def save(self):
            return await self._run("save")

        async def close(self, *, save=True):
            return await self._run("close", {"save": save})

    class _Dsm:
        __slots__ = ()

        def __repr__(self):
            return "dsm"

        async def open(self, path):
            return _Database(await _call("open", {"path": path}))

        async def list(self):
            return await _call("list")

        async def get(self, ref=None):
            return _Database(await _call("get", {"ref": ref}))

    return _Dsm()


dsm = _make_dsm()
del _make_dsm
