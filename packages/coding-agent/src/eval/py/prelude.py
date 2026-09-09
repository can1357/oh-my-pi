from __future__ import annotations

# OMP prelude helpers (loaded once into the runner namespace)
if "__omp_prelude_loaded__" not in globals():
    __omp_prelude_loaded__ = True
    from pathlib import Path
    import asyncio, collections.abc, inspect, os, json, math, re, types, typing
    from urllib.parse import unquote


    # __omp_display is injected by runner.py before the prelude executes; it
    # mirrors IPython's display() semantics with the same MIME bundle output.
    _omp_display = __omp_display  # type: ignore[name-defined]

    _PRESENTABLE_REPRS = (
        "_repr_mimebundle_",
        "_repr_html_",
        "_repr_json_",
        "_repr_markdown_",
        "_repr_png_",
        "_repr_jpeg_",
        "_repr_svg_",
        "_repr_latex_",
    )

    def display(value):
        """Render a value. Falls back to a JSON+text/plain bundle for plain dict/list/tuple."""
        if any(hasattr(value, attr) for attr in _PRESENTABLE_REPRS):
            _omp_display(value)
            return
        if isinstance(value, (dict, list, tuple)):
            try:
                bundle = {"application/json": value, "text/plain": repr(value)}
                _omp_display(bundle, raw=True)
                return
            except Exception:
                pass
        _omp_display(value)

    def _emit_status(op: str, **data):
        """Emit structured status event for TUI rendering."""
        _omp_display({"application/x-omp-status": {"op": op, **data}}, raw=True)

    def env(key: str | None = None, value: str | None = None):
        """Get/set environment variables."""
        if key is None:
            items = dict(sorted(os.environ.items()))
            _emit_status("env", count=len(items), keys=list(items.keys())[:20])
            return items
        if value is not None:
            os.environ[key] = value
            _emit_status("env", key=key, value=value, action="set")
            return value
        val = os.environ.get(key)
        _emit_status("env", key=key, value=val, action="get")
        return val

    _OMP_INTERNAL_URL_RE = re.compile(r"^([a-z][a-z0-9+.-]*)://(.*)$", re.IGNORECASE)

    def _should_delegate_read(path: str | Path) -> bool:
        return (
            isinstance(path, str)
            and _OMP_INTERNAL_URL_RE.match(path) is not None
            and not path.lower().startswith("local://")
        )

    def _read_line_selector(offset: int, limit: int | None) -> str | None:
        if offset <= 1 and limit is None:
            return None
        start = max(1, offset)
        if limit is None:
            return f"{start}-"
        return f"{start}-{start + limit - 1}"

    def _read_tool_text(path: str) -> str:
        result = _bridge_call("read", {"path": path})
        if isinstance(result, dict) and "text" in result:
            return result["text"]
        return result

    def _resolve_omp_path(path: str | Path) -> Path:
        """Map a helper path to a real filesystem Path.

        A `scheme://…` whose scheme has an injected on-disk root (e.g.
        `local://`, via PI_EVAL_LOCAL_ROOTS) is rewritten under that root so it
        lands where `read local://…` resolves — not a literal `local:/`
        directory under the cwd (which `Path("local://x")` collapses to). Plain
        paths pass through unchanged; any other `scheme://` is rejected."""
        if not isinstance(path, str):
            return Path(path)
        match = _OMP_INTERNAL_URL_RE.match(path)
        if not match:
            return Path(path)
        scheme = match.group(1).lower()
        try:
            roots = json.loads(os.environ.get("PI_EVAL_LOCAL_ROOTS") or "{}")
        except (ValueError, TypeError):
            roots = {}
        root = roots.get(scheme) if isinstance(roots, dict) else None
        if not root:
            raise ValueError(f"Protocol paths are not supported by this helper: {path}")
        relative = unquote(match.group(2).replace("\\", "/"))
        # Mirror the host `path.resolve`/`resolveLocalUrlToPath`: normalize and
        # make absolute WITHOUT realpath'ing symlinks (Path.resolve would turn
        # /tmp into /private/tmp and diverge from the read-side resolution).
        root_path = os.path.abspath(root)
        if relative == "":
            return Path(root_path)
        rel_path = Path(relative)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise ValueError(f"Unsafe {scheme}:// path (absolute or traversal): {path}")
        resolved = os.path.abspath(os.path.join(root_path, relative))
        if resolved != root_path and not resolved.startswith(root_path + os.sep):
            raise ValueError(f"{scheme}:// path escapes its root: {path}")
        return Path(resolved)

    def read(path: str | Path, offset: int = 1, limit: int | None = None) -> str:
        """Read file or read-tool URI contents. offset/limit are 1-indexed lines."""
        if _should_delegate_read(path):
            if limit is not None and limit <= 0:
                return ""
            selector = _read_line_selector(offset, limit)
            tool_path = path if selector is None else f"{path}:{selector}"
            return _read_tool_text(tool_path)
        p = _resolve_omp_path(path)
        data = p.read_text(encoding="utf-8")
        lines = data.splitlines(keepends=True)
        if offset > 1 or limit is not None:
            start = max(0, offset - 1)
            end = start + limit if limit else len(lines)
            lines = lines[start:end]
            data = "".join(lines)
        preview = data[:500]
        _emit_status("read", path=str(p), chars=len(data), preview=preview)
        return data

    def write(path: str | Path, content: str) -> Path:
        """Write file contents (create parents)."""
        p = _resolve_omp_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        _emit_status("write", path=str(p), chars=len(content))
        return p

    def output(
        *ids: str,
        format: str = "raw",
        query: str | None = None,
        offset: int | None = None,
        limit: int | None = None,
    ) -> str | dict | list[dict]:
        """Read task/agent output by ID. Returns text or JSON depending on format.

        Args:
            *ids: Output IDs to read (e.g., 'scout_0', 'reviewer_1')
            format: 'raw' (default), 'json' (dict with metadata), 'stripped' (no ANSI)
            query: jq-like query for JSON outputs (e.g., '.endpoints[0].file')
            offset: Line number to start reading from (1-indexed)
            limit: Maximum number of lines to read

        Returns:
            Single ID: str (format='raw'/'stripped') or dict (format='json')
            Multiple IDs: list of dict with 'id' and 'content'/'data' keys

        Examples:
            output('scout_0')  # Read as raw text
            output('reviewer_0', format='json')  # Read with metadata
            output('scout_0', query='.files[0]')  # Extract JSON field
            output('scout_0', offset=10, limit=20)  # Lines 10-29
            output('scout_0', 'reviewer_1')  # Read multiple outputs
        """
        # Prefer PI_ARTIFACTS_DIR so subagents resolve through the parent's
        # shared artifacts dir; fall back to deriving from PI_SESSION_FILE
        # for legacy callers / top-level sessions where the two coincide.
        artifacts_dir = os.environ.get("PI_ARTIFACTS_DIR")
        if not artifacts_dir:
            session_file = os.environ.get("PI_SESSION_FILE")
            if not session_file:
                _emit_status("output", error="No session file available")
                raise RuntimeError("No session - output artifacts unavailable")
            artifacts_dir = session_file.rsplit(".", 1)[0]  # Strip .jsonl extension
        if not Path(artifacts_dir).exists():
            _emit_status(
                "output", error="Artifacts directory not found", path=artifacts_dir
            )
            raise RuntimeError(f"No artifacts directory found: {artifacts_dir}")

        if not ids:
            _emit_status("output", error="No IDs provided")
            raise ValueError("At least one output ID is required")

        if query and (offset is not None or limit is not None):
            _emit_status("output", error="query cannot be combined with offset/limit")
            raise ValueError("query cannot be combined with offset/limit")

        results: list[dict] = []
        not_found: list[str] = []

        for output_id in ids:
            output_path = Path(artifacts_dir) / f"{output_id}.md"
            if not output_path.exists():
                not_found.append(output_id)
                continue

            raw_content = output_path.read_text(encoding="utf-8")
            raw_lines = raw_content.splitlines()
            total_lines = len(raw_lines)

            selected_content = raw_content
            range_info: dict | None = None

            # Handle query
            if query:
                try:
                    json_value = json.loads(raw_content)
                except json.JSONDecodeError as e:
                    _emit_status("output", id=output_id, error=f"Not valid JSON: {e}")
                    raise ValueError(f"Output {output_id} is not valid JSON: {e}")

                # Apply jq-like query
                result_value = _apply_query(json_value, query)
                try:
                    selected_content = (
                        json.dumps(result_value, indent=2)
                        if result_value is not None
                        else "null"
                    )
                except (TypeError, ValueError):
                    selected_content = str(result_value)

            # Handle offset/limit
            elif offset is not None or limit is not None:
                start_line = max(1, offset or 1)
                if start_line > total_lines:
                    _emit_status(
                        "output",
                        id=output_id,
                        error=f"Offset {start_line} beyond end ({total_lines} lines)",
                    )
                    raise ValueError(
                        f"Offset {start_line} is beyond end of output ({total_lines} lines) for {output_id}"
                    )

                effective_limit = (
                    limit if limit is not None else total_lines - start_line + 1
                )
                end_line = min(total_lines, start_line + effective_limit - 1)
                selected_lines = raw_lines[start_line - 1 : end_line]
                selected_content = "\n".join(selected_lines)
                range_info = {
                    "start_line": start_line,
                    "end_line": end_line,
                    "total_lines": total_lines,
                }

            # Strip ANSI codes if requested
            if format == "stripped":
                import re

                selected_content = re.sub(r"\x1b\[[0-9;]*m", "", selected_content)

            # Build result
            if format == "json":
                result_data = {
                    "id": output_id,
                    "path": str(output_path),
                    "line_count": total_lines
                    if not query
                    else len(selected_content.splitlines()),
                    "char_count": len(raw_content)
                    if not query
                    else len(selected_content),
                    "content": selected_content,
                }
                if range_info:
                    result_data["range"] = range_info
                if query:
                    result_data["query"] = query
                results.append(result_data)
            else:
                results.append({"id": output_id, "content": selected_content})

        # Handle not found
        if not_found:
            available = sorted([f.stem for f in Path(artifacts_dir).glob("*.md")])
            error_msg = f"Output not found: {', '.join(not_found)}"
            if available:
                error_msg += f"\n\nAvailable outputs: {', '.join(available[:20])}"
                if len(available) > 20:
                    error_msg += f" (and {len(available) - 20} more)"
            _emit_status("output", not_found=not_found, available_count=len(available))
            raise FileNotFoundError(error_msg)

        # Return format
        if len(ids) == 1:
            if format == "json":
                _emit_status("output", id=ids[0], chars=results[0]["char_count"])
                return results[0]
            _emit_status("output", id=ids[0], chars=len(results[0]["content"]))
            return results[0]["content"]

        # Multiple IDs
        if format == "json":
            total_chars = sum(r["char_count"] for r in results)
            _emit_status("output", count=len(results), total_chars=total_chars)
            return results

        combined_output: list[dict] = []
        for r in results:
            combined_output.append({"id": r["id"], "content": r["content"]})
        total_chars = sum(len(r["content"]) for r in combined_output)
        _emit_status("output", count=len(combined_output), total_chars=total_chars)
        return combined_output

    def _apply_query(data: any, query: str) -> any:
        """Apply jq-like query to data. Supports .key, [index], and chaining."""
        if not query:
            return data

        query = query.strip()
        if query.startswith("."):
            query = query[1:]
        if not query:
            return data

        # Parse query into tokens
        tokens = []
        current_token = ""
        i = 0
        while i < len(query):
            ch = query[i]
            if ch == ".":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
            elif ch == "[":
                if current_token:
                    tokens.append(("key", current_token))
                    current_token = ""
                # Find matching ]
                j = i + 1
                while j < len(query) and query[j] != "]":
                    j += 1
                bracket_content = query[i + 1 : j]
                if bracket_content.startswith('"') and bracket_content.endswith('"'):
                    tokens.append(("key", bracket_content[1:-1]))
                else:
                    tokens.append(("index", int(bracket_content)))
                i = j
            else:
                current_token += ch
            i += 1
        if current_token:
            tokens.append(("key", current_token))

        # Apply tokens
        current = data
        for token_type, value in tokens:
            if token_type == "index":
                if not isinstance(current, list) or value >= len(current):
                    return None
                current = current[value]
            elif token_type == "key":
                if not isinstance(current, dict) or value not in current:
                    return None
                current = current[value]

        return current

    def _tool_proxy_from_env() -> tuple[str, str, str]:
        base = os.environ.get("PI_TOOL_BRIDGE_URL")
        token = os.environ.get("PI_TOOL_BRIDGE_TOKEN")
        session = os.environ.get("PI_TOOL_BRIDGE_SESSION")
        if not base or not token or not session:
            raise RuntimeError("tool bridge is unavailable in this kernel")
        return (base.rstrip("/"), token, session)

    import urllib.error, urllib.request

    # urllib discovers environment and macOS SystemConfiguration proxies. This
    # host-owned loopback endpoint must always connect directly.
    _BRIDGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _bridge_call(name: str, args: dict):
        """POST one request to the host tool bridge and return its `value`."""
        base, token, session = _tool_proxy_from_env()
        _run_id_getter = globals().get("__omp_current_run_id__")
        _run_id = (
            _run_id_getter()
            if callable(_run_id_getter)
            else globals().get("__omp_run_id__")
        )
        payload = json.dumps(
            {"session": session, "run": _run_id, "name": name, "args": args}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/v1/tool",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )
        try:
            with _BRIDGE_OPENER.open(req) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(
                f"bridge call {name!r}: non-JSON response: {body[:200]!r}"
            ) from None
        if not isinstance(data, dict) or not data.get("ok"):
            msg = (data or {}).get("error") if isinstance(data, dict) else None
            raise RuntimeError(msg or f"bridge call {name!r} failed")
        return data.get("value")

    def _surface_bridged_tool_images(value):
        """Surface bridge metadata/images without leaking opaque payloads to cell code."""
        if not isinstance(value, dict):
            return value
        images = value.get("images")
        if not isinstance(images, list) or not images:
            return value
        displayed = 0
        for image in images:
            if not isinstance(image, dict):
                continue
            data = image.get("data")
            mime_type = image.get("mimeType")
            if not isinstance(data, str) or not isinstance(mime_type, str):
                continue
            _omp_display({mime_type: data}, raw=True)
            displayed += 1
        if displayed == 0:
            return value
        surfaced = {key: item for key, item in value.items() if key != "images"}
        suffix = "" if displayed == 1 else "s"
        surfaced["images"] = f"({displayed} image{suffix} displayed)"
        return surfaced

    async def _omp_prelude(name: str, parameters):
        """Invoke one enabled eval prelude capability through the host bridge."""
        value = await asyncio.to_thread(
            _bridge_call,
            "__prelude__",
            {"name": name, "parameters": parameters},
        )
        return _surface_bridged_tool_images(value)

    class _ToolCallable:
        """Invokes one host-side tool via the loopback HTTP bridge."""

        __slots__ = ("_name",)

        def __init__(self, name: str):
            self._name = name

        def __repr__(self) -> str:
            return f"<tool.{self._name}>"

        async def __call__(self, args=None, /, **kwargs):
            if args is None:
                merged: dict = {}
            elif isinstance(args, dict):
                merged = dict(args)
            else:
                raise TypeError(
                    f"tool.{self._name}(...) expects a dict of arguments (got {type(args).__name__})"
                )
            merged.update(kwargs)
            value = await asyncio.to_thread(_bridge_call, self._name, merged)
            return _surface_bridged_tool_images(value)

    def _annotation_schema(annotation) -> dict:
        """Map supported Python annotations to JSON Schema."""
        if annotation is inspect.Parameter.empty or annotation is typing.Any:
            return {}

        origin = typing.get_origin(annotation)
        args = typing.get_args(annotation)
        if origin is typing.Annotated:
            schema = _annotation_schema(args[0])
            description = next((item for item in args[1:] if isinstance(item, str)), None)
            if description is not None:
                schema = {**schema, "description": description}
            return schema
        if origin is typing.Literal:
            return {"enum": list(args)}
        if origin in (typing.Union, types.UnionType):
            non_null = [item for item in args if item is not type(None)]
            if len(non_null) == 1 and len(non_null) != len(args):
                return {
                    "anyOf": [
                        _annotation_schema(non_null[0]),
                        {"type": "null"},
                    ]
                }
            return {}

        if annotation is str:
            return {"type": "string"}
        if annotation is int:
            return {"type": "integer"}
        if annotation is float:
            return {"type": "number"}
        if annotation is bool:
            return {"type": "boolean"}

        array_origins = {
            list,
            tuple,
            set,
            collections.abc.Sequence,
        }
        if annotation in array_origins or origin in array_origins:
            schema = {"type": "array"}
            if args:
                schema["items"] = _annotation_schema(args[0])
            return schema

        object_origins = {
            dict,
            collections.abc.Mapping,
        }
        if annotation in object_origins or origin in object_origins:
            schema = {"type": "object"}
            if len(args) >= 2:
                schema["additionalProperties"] = _annotation_schema(args[1])
            return schema
        return {}

    def _tool_schema(fn) -> dict:
        """Infer one eval-defined tool's object schema from its signature."""
        signature = inspect.signature(fn)
        try:
            hints = typing.get_type_hints(fn, include_extras=True)
        except Exception:
            hints = getattr(fn, "__annotations__", {})
        properties = {}
        required = []
        for parameter in signature.parameters.values():
            if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                raise TypeError("tool parameters must be keyword-capable")
            if parameter.kind in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            ):
                continue
            schema = _annotation_schema(hints.get(parameter.name, parameter.annotation))
            if parameter.default is inspect.Parameter.empty:
                required.append(parameter.name)
            else:
                try:
                    json.dumps(parameter.default)
                except (TypeError, ValueError):
                    pass
                else:
                    schema = {**schema, "default": parameter.default}
            properties[parameter.name] = schema
        return {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        }

    class _EvalTool:
        """Kernel-owned function and its model-facing tool metadata."""

        __slots__ = ("name", "fn", "description", "parameters")

        def __init__(self, name, fn, description, parameters):
            self.name = name
            self.fn = fn
            self.description = description
            self.parameters = parameters

        def describe(self) -> dict:
            return {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }

    __omp_tools__: dict[str, _EvalTool] = {}
    globals()["__omp_tools__"] = __omp_tools__
    _TOOL_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

    class _ToolProxy:
        """Define kernel tools or invoke host-side tools by attribute."""

        __slots__ = ()

        def __call__(self, fn=None, /, *, name=None, description=None):
            if fn is None:
                return lambda decorated: self(
                    decorated,
                    name=name,
                    description=description,
                )
            if not callable(fn):
                raise TypeError("@tool expects a function")
            resolved_name = name or getattr(fn, "__name__", "")
            if not isinstance(resolved_name, str) or _TOOL_NAME_RE.fullmatch(resolved_name) is None:
                raise ValueError(f"invalid tool name {resolved_name!r}")
            schema = _tool_schema(fn)
            resolved_description = (
                description
                if isinstance(description, str) and description
                else inspect.getdoc(fn) or f"Python tool {resolved_name}"
            )
            __omp_tools__[resolved_name] = _EvalTool(
                resolved_name,
                fn,
                resolved_description,
                schema,
            )
            _emit_status(
                "tool_define",
                name=resolved_name,
                params=list(schema["properties"]),
            )
            return fn

        def defined(self) -> list[str]:
            return list(__omp_tools__)

        def undefine(self, name) -> bool:
            return __omp_tools__.pop(name, None) is not None

        def __getattr__(self, name: str) -> _ToolCallable:
            if name.startswith("_"):
                raise AttributeError(name)
            return _ToolCallable(name)

        def __getitem__(self, name: str) -> _ToolCallable:
            return _ToolCallable(name)

        def __repr__(self) -> str:
            session = os.environ.get("PI_TOOL_BRIDGE_SESSION")
            return (
                f"<tool proxy session={session}>"
                if session
                else "<tool proxy unavailable>"
            )

    tool = _ToolProxy()

    _HANDLE_UNSET = object()

    class _Handle:
        """Shared process-local agent/completion handle behavior."""

        __slots__ = ("id", "_schema", "_result")

        kind = ""

        def __init__(self, id, schema=None):
            self.id = id
            self._schema = schema
            self._result = _HANDLE_UNSET

        @property
        def status(self):
            snapshot = _bridge_call(
                "__status__",
                {"item": {"kind": self.kind, "id": self.id}},
            )
            return snapshot.get("status") if isinstance(snapshot, dict) else "failed"

        def done(self):
            return self.status != "running"

        def wait(self, timeout=None):
            if self._result is not _HANDLE_UNSET:
                return self._result
            return wait([self], timeout=timeout)[0]

        def cancel(self):
            result = _bridge_call(
                "__cancel__",
                {"item": {"kind": self.kind, "id": self.id}},
            )
            return bool(result.get("cancelled")) if isinstance(result, dict) else False

        def __await__(self):
            return asyncio.get_running_loop().run_in_executor(
                None,
                self.wait,
            ).__await__()

    class AgentHandle(_Handle):
        """Background subagent handle returned by ``agent()``."""

        __slots__ = ("agent", "handle")
        kind = "agent"

        def __init__(self, id, agent, schema=None):
            super().__init__(id, schema)
            self.agent = agent
            self.handle = f"agent://{id}"

        def __repr__(self):
            return f"<agent {self.id} ({self.agent})>"

        def send(self, message):
            return _bridge_call(
                "hub",
                {
                    "op": "send",
                    "to": self.id,
                    "message": str(message),
                    "i": "agent handle",
                },
            )

        def output(self, **kwargs):
            return output(self.id, **kwargs)

    class CompletionHandle(_Handle):
        """Background one-shot completion handle returned by ``completion()``."""

        __slots__ = ()
        kind = "completion"

        def __repr__(self):
            return f"<completion {self.id}>"

    def _handle_value(handle, snapshot):
        status = snapshot.get("status") if isinstance(snapshot, dict) else "failed"
        if status == "running":
            raise TimeoutError(f"{handle.kind} handle {handle.id} is still running")
        if status in ("failed", "cancelled"):
            message = (
                snapshot.get("error")
                if isinstance(snapshot, dict)
                else f"{handle.kind} handle {handle.id} failed"
            )
            raise RuntimeError(message or f"{handle.kind} handle {handle.id} failed")
        if isinstance(snapshot, dict) and "data" in snapshot:
            value = snapshot["data"]
        else:
            text = snapshot.get("text", "") if isinstance(snapshot, dict) else ""
            value = json.loads(text) if handle._schema is not None else text
        handle._result = value
        return value

    def wait(handles, timeout=None, *, raise_errors=True):
        """Wait for agent/completion handles in input order."""
        items = [handles] if isinstance(handles, _Handle) else list(handles)
        for handle in items:
            if not isinstance(handle, _Handle):
                raise TypeError("wait() expects agent or completion handles")
        results = [None] * len(items)
        pending = []
        pending_indexes = []
        for index, handle in enumerate(items):
            if handle._result is _HANDLE_UNSET:
                pending.append({"kind": handle.kind, "id": handle.id})
                pending_indexes.append(index)
            else:
                results[index] = handle._result
        if pending:
            args = {"items": pending}
            if timeout is not None:
                args["timeoutMs"] = max(0, float(timeout) * 1000)
            response = _bridge_call("__wait__", args)
            snapshots = response.get("items", []) if isinstance(response, dict) else []
            for index, handle, snapshot in zip(
                pending_indexes,
                (items[index] for index in pending_indexes),
                snapshots,
            ):
                try:
                    results[index] = _handle_value(handle, snapshot)
                except RuntimeError as error:
                    results[index] = error
            if len(snapshots) != len(pending):
                raise RuntimeError("wait() returned an incomplete handle result")
        if raise_errors:
            for result in results:
                if isinstance(result, RuntimeError):
                    raise result
        return results

    def completion(prompt, *, model="default", system=None, schema=None):
        """Start a stateless completion and return its handle."""
        args = {"prompt": prompt, "model": model}
        if system is not None:
            args["system"] = system
        if schema is not None:
            args["schema"] = schema
        result = _bridge_call("__completion__", args)
        if not isinstance(result, dict) or not isinstance(result.get("id"), str):
            raise RuntimeError("completion() did not return a handle")
        return CompletionHandle(result["id"], schema)

    def agent(
        prompt,
        *,
        agent=None,
        label=None,
        schema=None,
        schema_mode=None,
        isolated=None,
        apply=None,
        merge=None,
        tools=None,
    ):
        """Start a background subagent and return its handle."""
        args = {"prompt": prompt}
        if agent is not None:
            args["agent"] = agent
        if label is not None:
            args["label"] = label
        if schema is not None:
            args["schema"] = schema
        if schema_mode is not None:
            args["schemaMode"] = schema_mode
        if isolated is not None:
            args["isolated"] = bool(isolated)
        if apply is not None:
            args["apply"] = bool(apply)
        if merge is not None:
            args["merge"] = bool(merge)
        if tools is not None:
            args["tools"] = list(tools)
        result = _bridge_call("__agent__", args)
        if not isinstance(result, dict) or not isinstance(result.get("id"), str):
            raise RuntimeError("agent() did not return a handle")
        return AgentHandle(result["id"], result.get("agent"), schema)

    class WorkPool:
        """Pool of keep-alive subagents fed through the host workpool bridge."""

        __slots__ = ("name", "agent", "limit")

        def __init__(self, name, agent, limit):
            self.name = name
            self.agent = agent
            self.limit = limit

        def push(self, *items):
            if not all(isinstance(item, str) for item in items):
                raise TypeError("WorkPool.push() expects string items")
            result = _bridge_call(
                "__workpool__",
                {"op": "push", "name": self.name, "items": list(items)},
            )
            return result.get("ids", []) if isinstance(result, dict) else []

        def status(self):
            return _bridge_call(
                "__workpool__",
                {"op": "status", "name": self.name},
            )

        def peek(self):
            return _bridge_call(
                "__workpool__",
                {"op": "peek", "name": self.name},
            )

        def close(self):
            return _bridge_call(
                "__workpool__",
                {"op": "close", "name": self.name},
            )

        def __repr__(self):
            return f"<workpool {self.name} ({self.agent}) {self.limit} agents>"

    def workpool(agent=None, *, name=None, context=None, tools=None):
        """Create a pool of keep-alive subagents."""
        args = {"op": "create"}
        if agent is not None:
            args["agent"] = agent
        if name is not None:
            args["name"] = name
        if context is not None:
            args["context"] = context
        if tools is not None:
            args["tools"] = list(tools)
        result = _bridge_call("__workpool__", args)
        if not isinstance(result, dict) or not isinstance(result.get("name"), str):
            raise RuntimeError("workpool() did not return a pool")
        return WorkPool(result["name"], result.get("agent"), result.get("limit"))

    def log(message):
        """Emit a status ``log`` event for TUI rendering."""
        _emit_status("log", message=str(message))
        return None

    def phase(title):
        """Record the current readable phase and emit a status ``phase`` event."""
        globals()["__omp_current_phase__"] = str(title)
        _emit_status("phase", title=str(title))
        return None

    class _Budget:
        """Live view of the host Goal Mode token budget via the host bridge."""

        @property
        def total(self):
            snap = _bridge_call("__budget__", {})
            return (snap or {}).get("total")

        @property
        def hard(self):
            snap = _bridge_call("__budget__", {})
            return bool((snap or {}).get("hard"))

        def spent(self):
            snap = _bridge_call("__budget__", {})
            return int((snap or {}).get("spent") or 0)

        def remaining(self):
            snap = _bridge_call("__budget__", {}) or {}
            total = snap.get("total")
            if total is None:
                return math.inf
            return max(0, total - int(snap.get("spent") or 0))

        def __repr__(self):
            try:
                snap = _bridge_call("__budget__", {}) or {}
                return f"<budget total={snap.get('total')} spent={snap.get('spent')}>"
            except Exception:
                return "<budget unavailable>"

    budget = _Budget()
