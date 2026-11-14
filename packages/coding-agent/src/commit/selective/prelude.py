def _make_commit():
    async def _call(action, params):
        response = await _omp_prelude(
            "commit",
            {
                **{key: value for key, value in params.items() if value is not None},
                "action": action,
            },
        )
        # The bridge returns bare text when a call has no details.
        if isinstance(response, str):
            return response, None
        if not isinstance(response, dict):
            raise RuntimeError("commit returned an invalid response")
        return response.get("text") or "", response.get("details")

    def _units(units):
        return [str(unit) for unit in units] or None

    class _Draft:
        __slots__ = ("id", "details", "_text")

        def __init__(self, details, text):
            self.id = details["id"]
            self.details = details
            self._text = text

        def __repr__(self):
            return self._text

        async def _run(self, action, params, silent):
            text, details = await _call(action, {**params, "draft": self.id})
            if not silent and text:
                print(text)
            return text, details

        async def show(self, path=None, *, silent=False):
            text, _ = await self._run("show", {"path": path}, silent)
            return text

        async def take(self, path=None, *units, grep=None, silent=False):
            text, _ = await self._run(
                "take", {"path": path, "units": _units(units), "grep": grep}, silent
            )
            self._text = text
            return self

        async def drop(self, path=None, *units, grep=None, silent=False):
            text, _ = await self._run(
                "drop", {"path": path, "units": _units(units), "grep": grep}, silent
            )
            self._text = text
            return self

        async def only(self, *globs, silent=False):
            text, _ = await self._run("only", {"globs": list(globs)}, silent)
            self._text = text
            return self

        async def diff(self, *, silent=False):
            text, _ = await self._run("diff", {}, silent)
            return text

        async def commit(
            self, subject, body=None, *, fixes=None, amend=False, no_verify=False, silent=False
        ):
            if isinstance(fixes, (int, str)):
                fixes = [fixes]
            text, details = await self._run(
                "commit",
                {
                    "subject": subject,
                    "body": body,
                    "fixes": fixes,
                    "amend": amend or None,
                    "noVerify": no_verify or None,
                },
                silent,
            )
            # The committed draft is gone; continue with what remains.
            self.id = details["remaining"]["id"]
            self.details = details["remaining"]
            self._text = text
            return details

    class _Commit:
        __slots__ = ()

        def __repr__(self):
            return "commit"

        async def draft(self, agents=None, *, repo=None, silent=False):
            text, details = await _call("draft", {"agents": agents, "repo": repo})
            if not silent and text:
                print(text)
            return _Draft(details, text)

    return _Commit()


commit = _make_commit()
del _make_commit
