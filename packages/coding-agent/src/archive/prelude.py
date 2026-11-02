def _make_archive():
    async def _call(action, params, silent):
        response = await _omp_prelude(
            "archive",
            {
                **{key: value for key, value in params.items() if value is not None},
                "action": action,
            },
        )
        if not isinstance(response, dict):
            raise RuntimeError("archive returned an invalid response")
        text = response.get("text")
        if not silent and isinstance(text, str) and text:
            print(text)
        return response.get("details")

    class _Archive:
        __slots__ = ()

        def __repr__(self):
            return "archive"

        async def projects(self, *, limit=None, silent=False):
            return await _call("projects", {"limit": limit}, silent)

        async def sessions(self, *, project=None, limit=None, silent=False):
            return await _call("sessions", {"project": project, "limit": limit}, silent)

        async def session(self, id, *, limit=None, silent=False):
            return await _call("session", {"id": id, "limit": limit}, silent)

        async def prompts(self, *, project=None, limit=None, silent=False):
            return await _call("prompts", {"project": project, "limit": limit}, silent)

        async def search(self, query, *, project=None, limit=None, silent=False):
            return await _call(
                "prompts", {"query": query, "project": project, "limit": limit}, silent
            )

        async def recaps(self, *, project=None, limit=None, silent=False):
            return await _call("recaps", {"project": project, "limit": limit}, silent)

    return _Archive()


archive = _make_archive()
del _make_archive
