def _make_archive():
    import re as _re

    _flag_letters = ((_re.IGNORECASE, "i"), (_re.MULTILINE, "m"), (_re.DOTALL, "s"))

    def _normalize(params):
        """Plain JSON params: datetimes become ISO strings; a compiled pattern becomes its source, its flags merged into `flags`."""
        normalized = {}
        flags = params.get("flags") or ""
        for key, value in params.items():
            if value is None:
                continue
            if hasattr(value, "isoformat"):
                value = value.isoformat()
            elif isinstance(value, _re.Pattern):
                for flag, letter in _flag_letters:
                    if value.flags & flag and letter not in flags:
                        flags += letter
                value = value.pattern
            normalized[key] = value
        if flags:
            normalized["flags"] = flags
        return normalized

    async def _call(action, params, silent):
        response = await _omp_prelude("archive", {**_normalize(params), "action": action})
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

        async def projects(self, *, since=None, until=None, limit=None, silent=False):
            return await _call("projects", {"since": since, "until": until, "limit": limit}, silent)

        async def sessions(self, *, project=None, since=None, until=None, limit=None, silent=False):
            return await _call(
                "sessions", {"project": project, "since": since, "until": until, "limit": limit}, silent
            )

        async def session(self, id, *, limit=None, silent=False):
            return await _call("session", {"id": id, "limit": limit}, silent)

        async def prompts(self, *, query=None, project=None, since=None, until=None, limit=None, silent=False):
            return await _call(
                "prompts",
                {"query": query, "project": project, "since": since, "until": until, "limit": limit},
                silent,
            )

        async def search(self, query, *, project=None, since=None, until=None, limit=None, silent=False):
            return await _call(
                "search",
                {"query": query, "project": project, "since": since, "until": until, "limit": limit},
                silent,
            )

        async def recaps(self, *, project=None, since=None, until=None, limit=None, silent=False):
            return await _call(
                "recaps", {"project": project, "since": since, "until": until, "limit": limit}, silent
            )

        async def calls(
            self,
            *,
            tool=None,
            match=None,
            result=None,
            error=None,
            flags=None,
            project=None,
            subagents=None,
            since=None,
            until=None,
            limit=None,
            silent=False,
        ):
            return await _call(
                "calls",
                {
                    "tool": tool,
                    "match": match,
                    "result": result,
                    "error": error,
                    "flags": flags,
                    "project": project,
                    "subagents": subagents,
                    "since": since,
                    "until": until,
                    "limit": limit,
                },
                silent,
            )

        async def grep(
            self,
            pattern,
            *,
            sources=None,
            tool=None,
            flags=None,
            project=None,
            subagents=None,
            since=None,
            until=None,
            limit=None,
            silent=False,
        ):
            return await _call(
                "grep",
                {
                    "pattern": pattern,
                    "sources": sources,
                    "tool": tool,
                    "flags": flags,
                    "project": project,
                    "subagents": subagents,
                    "since": since,
                    "until": until,
                    "limit": limit,
                },
                silent,
            )

        async def stats(
            self,
            *,
            by=None,
            tool=None,
            match=None,
            result=None,
            error=None,
            flags=None,
            project=None,
            subagents=None,
            since=None,
            until=None,
            limit=None,
            silent=False,
        ):
            return await _call(
                "stats",
                {
                    "by": by,
                    "tool": tool,
                    "match": match,
                    "result": result,
                    "error": error,
                    "flags": flags,
                    "project": project,
                    "subagents": subagents,
                    "since": since,
                    "until": until,
                    "limit": limit,
                },
                silent,
            )

        async def messages(self, id, *, kinds=None, since=None, until=None, limit=None, silent=False):
            return await _call(
                "messages", {"id": id, "kinds": kinds, "since": since, "until": until, "limit": limit}, silent
            )

    return _Archive()


archive = _make_archive()
del _make_archive
