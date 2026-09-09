from __future__ import annotations

# OMP prelude helpers (loaded once into the runner namespace)
if "__omp_prelude_loaded__" not in globals():
    __omp_prelude_loaded__ = True
    from pathlib import Path
    import os, json, math, re
    import asyncio as _asyncio
    import collections.abc as _collections_abc
    import inspect as _inspect
    import keyword as _keyword
    import types as _types
    import typing as _typing
    from urllib.parse import quote as _url_quote, unquote

    INTENT_FIELD = "i"

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

    def __omp_consume_bridge_progress__(name: str, event):
        """Render one correlated host update before its bridge response settles."""
        if isinstance(event, dict) and isinstance(event.get("op"), str):
            _omp_display({"application/x-omp-status": event}, raw=True)
        else:
            _emit_status("tool", name=name, update=event)

    def __omp_install_prelude_helpers__(specs):
        """Install extension helper stubs from the authenticated host snapshot."""
        def make_helper(helper_name, helper_signature):
            def helper(*args, **kwargs):
                bound = helper_signature.bind(*args, **kwargs)
                bound.apply_defaults()
                return _bridge_call(
                    "__prelude__:" + helper_name,
                    dict(bound.arguments),
                )

            return helper

        for spec in specs:
            name = spec.get("name")
            if (
                not isinstance(name, str)
                or not name.isidentifier()
                or _keyword.iskeyword(name)
            ):
                raise RuntimeError(f"invalid prelude helper name: {name!r}")
            if name in globals():
                raise RuntimeError(f"prelude helper shadows an existing global: {name}")

            parameters = []
            for parameter_spec in spec.get("params", ()):
                parameter_name = parameter_spec.get("name")
                if (
                    not isinstance(parameter_name, str)
                    or not parameter_name.isascii()
                    or not parameter_name.isidentifier()
                    or _keyword.iskeyword(parameter_name)
                ):
                    raise RuntimeError(
                        f"invalid prelude helper parameter name: {parameter_name!r}"
                    )
                default_json = parameter_spec.get("default_json")
                default = (
                    _inspect.Parameter.empty
                    if default_json is None
                    else json.loads(default_json)
                )
                annotation_text = parameter_spec.get("annotation")
                annotation = (
                    _inspect.Parameter.empty
                    if annotation_text is None
                    else annotation_text
                )
                kind = (
                    _inspect.Parameter.KEYWORD_ONLY
                    if parameter_spec.get("keyword_only")
                    else _inspect.Parameter.POSITIONAL_OR_KEYWORD
                )
                parameters.append(
                    _inspect.Parameter(
                        parameter_name,
                        kind,
                        default=default,
                        annotation=annotation,
                    )
                )
            signature = _inspect.Signature(parameters)
            helper = make_helper(name, signature)
            helper.__name__ = name
            helper.__qualname__ = name
            helper.__doc__ = spec.get("doc") or ""
            helper.__signature__ = signature
            globals()[name] = helper

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
        `local://`, via OMP_EVAL_LOCAL_ROOTS) is rewritten under that root so it
        lands where `read local://…` resolves — not a literal `local:/`
        directory under the cwd (which `Path("local://x")` collapses to). Plain
        paths pass through unchanged; any other `scheme://` is rejected."""
        if not isinstance(path, str):
            return Path(path)
        match = _OMP_INTERNAL_URL_RE.match(path)
        if not match:
            return Path(path)
        scheme = match.group(1).lower()
        roots_config = globals().get("OMP_EVAL_LOCAL_ROOTS")
        if roots_config is None:
            roots_config = os.environ.get("OMP_EVAL_LOCAL_ROOTS")
        try:
            roots = roots_config if isinstance(roots_config, dict) else json.loads(roots_config or "{}")
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
        """Read current task, job, or CAS output through the host Read authority.

        Plain IDs resolve through ``agent://`` against the journal-derived live
        session/job projection. Explicit ``agent://`` and ``artifact://sha256/``
        addresses are passed through unchanged. This helper never derives a
        legacy sidecar path from the session journal.

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
        if not ids:
            _emit_status("output", error="No IDs provided")
            raise ValueError("At least one output ID is required")

        if query and (offset is not None or limit is not None):
            _emit_status("output", error="query cannot be combined with offset/limit")
            raise ValueError("query cannot be combined with offset/limit")

        results: list[dict] = []
        not_found: list[str] = []

        for output_id in ids:
            if not isinstance(output_id, str) or not output_id:
                raise TypeError("output IDs must be nonempty strings")
            output_uri = (
                output_id
                if _OMP_INTERNAL_URL_RE.match(output_id)
                else f"agent://{_url_quote(output_id, safe='@._-')}"
            )
            delegated_range = (
                output_uri.lower().startswith("artifact://")
                and query is None
                and (offset is not None or limit is not None)
            )
            if delegated_range:
                selector = _read_line_selector(offset or 1, limit)
                read_uri = output_uri + (f":{selector}" if selector is not None else ":raw")
            else:
                read_uri = (
                    output_uri
                    if (
                        "?" in output_uri
                        or output_uri.endswith(":raw")
                        or not output_uri.lower().startswith(("agent://", "artifact://"))
                    )
                    else output_uri + ":raw"
                )
            try:
                resolved = (
                    ""
                    if delegated_range and limit is not None and limit <= 0
                    else _read_tool_text(read_uri)
                )
            except Exception:
                not_found.append(output_id)
                continue

            # agent:// returns a journal-derived envelope so callers can query
            # metadata while raw mode retains the historical final-output
            # behavior. artifact:// returns the CAS body directly.
            envelope = None
            if output_uri.lower().startswith("agent://"):
                try:
                    candidate = json.loads(resolved)
                    if isinstance(candidate, dict):
                        envelope = candidate
                except (json.JSONDecodeError, TypeError):
                    pass
            raw_value = (
                envelope.get("output")
                if envelope is not None and "output" in envelope
                else resolved
            )
            if isinstance(raw_value, str):
                raw_content = raw_value
            else:
                raw_content = json.dumps(raw_value, ensure_ascii=False)
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
            elif delegated_range:
                start_line = max(1, offset or 1)
                end_line = start_line + max(0, total_lines - 1)
                range_info = {
                    "start_line": start_line,
                    "end_line": end_line,
                    "total_lines": None,
                }
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
                    "uri": output_uri,
                    "line_count": total_lines
                    if not query
                    else len(selected_content.splitlines()),
                    "char_count": len(raw_content)
                    if not query
                    else len(selected_content),
                    "content": selected_content,
                }
                if envelope is not None:
                    for key in ("kind", "status", "data", "result"):
                        if key in envelope:
                            result_data[key] = envelope[key]
                if range_info:
                    result_data["range"] = range_info
                if query:
                    result_data["query"] = query
                results.append(result_data)
            else:
                results.append({"id": output_id, "content": selected_content})

        # Handle not found
        if not_found:
            error_msg = f"Output not found: {', '.join(not_found)}"
            _emit_status("output", not_found=not_found)
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

    def _bridge_call(name: str, args: dict):
        """Invoke one authenticated host call outside the cell compute timeout."""
        bridge = globals().get("__omp_bridge_call__")
        if not callable(bridge):
            raise RuntimeError("tool bridge is unavailable in this kernel")
        pause = globals().get("__omp_timeout_pause__")
        resume = globals().get("__omp_timeout_resume__")
        if callable(pause):
            pause()
        try:
            result = bridge(name, args)
            if isinstance(result, dict) and "__omp_bridge_value__" in result:
                for update in result.get("__omp_bridge_updates__", ()):
                    _emit_status("tool", name=name, update=update)
                return result["__omp_bridge_value__"]
            return result
        finally:
            if callable(resume):
                resume()

    class _ToolCallable:
        """Invokes one host-side tool through the authenticated direct bridge."""

        __slots__ = ("_name",)

        def __init__(self, name: str):
            self._name = name

        def __repr__(self) -> str:
            return f"<tool.{self._name}>"

        def __call__(self, args=None, /, **kwargs):
            if args is None:
                merged: dict = {}
            elif isinstance(args, dict):
                merged = dict(args)
            else:
                raise TypeError(
                    f"tool.{self._name}(...) expects a dict of arguments (got {type(args).__name__})"
                )
            merged.update(kwargs)
            if INTENT_FIELD not in merged:
                merged[INTENT_FIELD] = "py prelude"
            return _bridge_call(self._name, merged)

    def _eval_tool_annotation_schema(annotation) -> dict:
        """Map the useful subset of Python annotations to JSON Schema."""
        if annotation is _inspect.Parameter.empty or annotation is _typing.Any:
            return {}
        origin = _typing.get_origin(annotation)
        args = _typing.get_args(annotation)
        if origin is _typing.Annotated:
            schema = _eval_tool_annotation_schema(args[0])
            description = next((item for item in args[1:] if isinstance(item, str)), None)
            return {**schema, "description": description} if description is not None else schema
        if origin is _typing.Literal:
            return {"enum": list(args)}
        if origin in (_typing.Union, _types.UnionType):
            non_null = [item for item in args if item is not type(None)]
            if len(non_null) == 1 and len(non_null) != len(args):
                return {
                    "anyOf": [
                        _eval_tool_annotation_schema(non_null[0]),
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
        array_origins = {list, tuple, set, _collections_abc.Sequence}
        if annotation in array_origins or origin in array_origins:
            schema = {"type": "array"}
            if args:
                schema["items"] = _eval_tool_annotation_schema(args[0])
            return schema
        object_origins = {dict, _collections_abc.Mapping}
        if annotation in object_origins or origin in object_origins:
            schema = {"type": "object"}
            if len(args) >= 2:
                schema["additionalProperties"] = _eval_tool_annotation_schema(args[1])
            return schema
        return {}

    def _eval_tool_schema(fn) -> dict:
        """Infer one eval-defined tool's closed object schema."""
        signature = _inspect.signature(fn)
        try:
            hints = _typing.get_type_hints(fn, include_extras=True)
        except Exception:
            hints = getattr(fn, "__annotations__", {})
        properties = {}
        required = []
        for parameter in signature.parameters.values():
            if parameter.kind is _inspect.Parameter.POSITIONAL_ONLY:
                raise TypeError("tool parameters must be keyword-capable")
            if parameter.kind in (
                _inspect.Parameter.VAR_POSITIONAL,
                _inspect.Parameter.VAR_KEYWORD,
            ):
                continue
            schema = _eval_tool_annotation_schema(
                hints.get(parameter.name, parameter.annotation)
            )
            if parameter.default is _inspect.Parameter.empty:
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

    class _EvalDefinedTool:
        """One process-local handler plus its immutable advertised contract."""

        __slots__ = (
            "name",
            "fn",
            "description",
            "parameters",
            "rev",
            "handler",
        )

        def __init__(
            self,
            name,
            fn,
            description,
            parameters,
            rev,
            handler,
        ):
            self.name = name
            self.fn = fn
            self.description = description
            self.parameters = parameters
            self.rev = rev
            self.handler = handler

        def describe(self, generation) -> dict:
            return {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
                "rev": self.rev,
                "handler": self.handler,
                "generation": generation,
            }

    __omp_eval_tools__: dict[str, _EvalDefinedTool] = {}
    __omp_eval_tool_generation__ = 0
    globals()["__omp_eval_tools__"] = __omp_eval_tools__

    def _eval_tool_jsonable(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {str(key): _eval_tool_jsonable(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_eval_tool_jsonable(item) for item in value]
        return repr(value)

    def __omp_eval_tool_request__(request):
        """Describe or invoke a generation-fenced handler in this namespace."""
        if not isinstance(request, dict):
            return {"ok": False, "error": "eval tool request must be an object"}
        operation = request.get("op")
        if operation == "describe":
            requested = request.get("names")
            if requested is None or requested == []:
                requested = list(__omp_eval_tools__)
            if not isinstance(requested, list) or not all(
                isinstance(name, str) for name in requested
            ):
                return {"ok": False, "error": "eval tool names must be strings"}
            return {
                "ok": True,
                "generation": __omp_eval_tool_generation__,
                "tools": [
                    __omp_eval_tools__[name].describe(
                        __omp_eval_tool_generation__
                    )
                    for name in requested
                    if name in __omp_eval_tools__
                ],
                "missing": [
                    name for name in requested if name not in __omp_eval_tools__
                ],
            }
        if operation != "call":
            return {"ok": False, "error": f"unknown eval tool operation {operation!r}"}
        name = request.get("name")
        spec = __omp_eval_tools__.get(name)
        if spec is None:
            return {"ok": False, "error": f"eval tool {name!r} is not defined"}
        if (
            request.get("generation") != __omp_eval_tool_generation__
            or request.get("rev") != spec.rev
            or request.get("handler") != spec.handler
        ):
            return {
                "ok": False,
                "error": f"eval tool {name!r} registration is stale",
            }
        args = request.get("args")
        if not isinstance(args, dict):
            return {"ok": False, "error": "eval tool arguments must be an object"}
        try:
            value = spec.fn(**args)
            if _inspect.isawaitable(value):
                value = _asyncio.run(value)
            return {"ok": True, "value": _eval_tool_jsonable(value)}
        except BaseException as error:
            return {
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            }

    class _ToolProxy:
        """Define eval tools or invoke host tools through one stable surface."""

        __slots__ = ()

        def __call__(
            self,
            fn=None,
            /,
            *,
            name=None,
            description=None,
            rev=1,
        ):
            if fn is None:
                return lambda decorated: self(
                    decorated,
                    name=name,
                    description=description,
                    rev=rev,
                )
            if not callable(fn):
                raise TypeError("@tool expects a function")
            resolved_name = name or getattr(fn, "__name__", "")
            if (
                not isinstance(resolved_name, str)
                or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", resolved_name)
                is None
            ):
                raise ValueError(f"invalid tool name {resolved_name!r}")
            if (
                not isinstance(rev, int)
                or isinstance(rev, bool)
                or rev <= 0
                or rev > 65535
            ):
                raise ValueError("tool revision must be an integer from 1 through 65535")
            schema = _eval_tool_schema(fn)
            resolved_description = (
                description
                if isinstance(description, str) and description
                else _inspect.getdoc(fn) or f"Python tool {resolved_name}"
            )
            global __omp_eval_tool_generation__
            __omp_eval_tool_generation__ += 1
            handler = os.urandom(16).hex()
            __omp_eval_tools__[resolved_name] = _EvalDefinedTool(
                resolved_name,
                fn,
                resolved_description,
                schema,
                rev,
                handler,
            )
            _emit_status(
                "tool_define",
                name=resolved_name,
                rev=rev,
                params=list(schema["properties"]),
            )
            return fn

        def defined(self) -> list[str]:
            return list(__omp_eval_tools__)

        def undefine(self, name) -> bool:
            global __omp_eval_tool_generation__
            removed = __omp_eval_tools__.pop(name, None) is not None
            if removed:
                __omp_eval_tool_generation__ += 1
            return removed

        def __getattr__(self, name: str) -> _ToolCallable:
            if name.startswith("_"):
                raise AttributeError(name)
            return _ToolCallable(name)

        def __getitem__(self, name: str) -> _ToolCallable:
            return _ToolCallable(name)

        def __repr__(self) -> str:
            session = globals().get("__omp_bridge_session__")
            return (
                f"<tool proxy session={session}>"
                if session
                else "<tool proxy unavailable>"
            )

    tool = _ToolProxy()

    def completion(prompt, *, model="default", system=None, schema=None):
        """Oneshot, stateless completion against a model tier.

        `model` selects a tier: "smol", "default" (the session's active model),
        or "slow". Pass `system` for a system prompt. Pass a JSON-Schema dict
        as `schema` to force a structured response; the parsed object is then
        returned instead of the completion text.
        """
        args = {"prompt": prompt, "model": model}
        if system is not None:
            args["system"] = system
        if schema is not None:
            args["schema"] = schema
        res = _bridge_call("__completion__", args)
        text = res.get("text") if isinstance(res, dict) else res
        return json.loads(text) if schema is not None else text

    def agent(
        prompt,
        *,
        agent="task",
        name=None,
        effort=None,
        outputSchema=None,
        schemaMode=None,
        isolated=None,
        apply=None,
        merge=None,
        handle=False,
    ):
        """Run a subagent and return its final output or structured data.

        `outputSchema` overrides agent and session schemas. `schemaMode` is
        `"permissive"` or `"strict"`. `handle=True` returns the child output
        reference and metadata, with parsed data under `"data"` when available.
        """
        args = {"prompt": prompt}
        if agent is not None:
            args["agent"] = agent
        if name is not None:
            args["name"] = name
        if effort is not None:
            args["effort"] = effort
        if outputSchema is not None:
            args["outputSchema"] = outputSchema
        if schemaMode is not None:
            args["schemaMode"] = schemaMode
        if isolated is not None:
            args["isolated"] = bool(isolated)
        if apply is not None:
            args["apply"] = bool(apply)
        if merge is not None:
            args["merge"] = bool(merge)
        if handle:
            args["handle"] = True
        res = _bridge_call("__agent__", args)
        text = res.get("text") if isinstance(res, dict) else res
        has_data = isinstance(res, dict) and res.get("data") is not None
        if outputSchema is not None and isinstance(res, dict) and res.get("schema") is not None and not has_data:
            parsed = {"error": res["schema"], "text": text}
        else:
            parsed = res["data"] if has_data else json.loads(text) if outputSchema is not None else text
        if not handle:
            return parsed
        details = res.get("details") if isinstance(res, dict) else None
        if not isinstance(details, dict) or details.get("id") is None:
            return {
                "text": text,
                "output": text,
                "handle": None,
                "id": None,
                "agent": None,
            }
        node = {
            "text": text,
            "output": text,
            "handle": f"agent://{details['id']}",
            "id": details["id"],
            "agent": details.get("agent"),
        }
        if has_data or outputSchema is not None:
            node["data"] = parsed
        for src_key, dst_key in (
            ("isolated", "isolated"),
            ("patchPath", "patch_path"),
            ("branchName", "branch_name"),
            ("nestedPatches", "nested_patches"),
            ("changesApplied", "changes_applied"),
            ("isolationSummary", "isolation_summary"),
        ):
            if src_key in details:
                node[dst_key] = details[src_key]
        return node

    if "__workpool__" in globals().get("__omp_bridge_capabilities__", ()):
        class WorkPool:
            """Pool of persistent subagents fed through the authenticated host bridge."""

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
            """Create a persistent parent-owned subagent pool."""
            args = {"op": "create"}
            if agent is not None:
                args["agent"] = agent
            if name is not None:
                args["name"] = name
            if context is not None:
                args["context"] = context
            if tools is not None:
                if isinstance(tools, (str, bytes)):
                    raise TypeError("workpool tools must be an iterable of names")
                requested_tools = list(tools)
                if not all(
                    isinstance(tool_name, str) and tool_name
                    for tool_name in requested_tools
                ):
                    raise TypeError("workpool tools must be non-empty strings")
                if len(set(requested_tools)) != len(requested_tools):
                    raise ValueError("workpool tools must not contain duplicates")
                missing_tools = [
                    tool_name
                    for tool_name in requested_tools
                    if tool_name not in __omp_eval_tools__
                ]
                if missing_tools:
                    available = ", ".join(sorted(__omp_eval_tools__)) or "none"
                    raise LookupError(
                        "unknown eval tool(s): "
                        + ", ".join(missing_tools)
                        + f"; available: {available}"
                    )
                args["tools"] = requested_tools
                args["tool_registrations"] = [
                    __omp_eval_tools__[tool_name].describe(
                        __omp_eval_tool_generation__
                    )
                    for tool_name in requested_tools
                ]
            result = _bridge_call("__workpool__", args)
            if not isinstance(result, dict) or not isinstance(result.get("name"), str):
                raise RuntimeError("workpool() did not return a pool")
            return WorkPool(result["name"], result.get("agent"), result.get("limit"))

    def _concurrency_limit():
        """Return the live worker-pool ceiling, or ``None`` for unlimited."""
        try:
            snap = _bridge_call("__concurrency__", {}) or {}
            n = int(snap.get("limit") or 0)
        except Exception:
            return 32
        if n < 0:
            return 32
        return None if n == 0 else n

    class _AwaitableList(list):
        """Completed list result accepted by both sync and ``await`` syntax."""

        def __await__(self):
            yield from ()
            return self


    def _pool_map(items, fn, *, allSettled=False):
        """Run ``fn`` over ``items`` through a bounded, ordered worker pool.

        The default cancels queued siblings on the first failure. ``allSettled``
        waits for every item and returns ordered fulfilled/rejected records.
        Each worker inherits the submitting bridge ContextVar.
        """
        import concurrent.futures, contextvars

        items = list(items)
        if not items:
            return _AwaitableList()
        limit = _concurrency_limit()
        workers = len(items) if limit is None else min(limit, len(items))
        results = _AwaitableList(None for _ in items)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
        futures = {}
        failed = False
        try:
            for i, item in enumerate(items):
                ctx = contextvars.copy_context()
                futures[pool.submit(ctx.run, fn, item)] = i
            if allSettled:
                for fut in concurrent.futures.as_completed(futures):
                    i = futures[fut]
                    try:
                        results[i] = {"status": "fulfilled", "value": fut.result()}
                    except BaseException as exc:  # noqa: BLE001 - settlement captures reason
                        results[i] = {"status": "rejected", "reason": exc}
                return results
            pending = set(futures)
            while pending:
                done, pending = concurrent.futures.wait(
                    pending, return_when=concurrent.futures.FIRST_EXCEPTION
                )
                for fut in done:
                    i = futures[fut]
                    try:
                        results[i] = fut.result()
                    except BaseException:
                        failed = True
                        for sibling in pending:
                            sibling.cancel()
                        raise
            return results
        except BaseException:
            failed = True
            for sibling in futures:
                sibling.cancel()
            raise
        finally:
            pool.shutdown(wait=not failed, cancel_futures=failed)

    def parallel(thunks, *, allSettled=False):
        """Run zero-arg callables through a bounded pool, preserving input order.

        Barriers until all finish; re-raises the lowest-index exception if any
        thunk raised. Pool width honors the live host limit; zero is unlimited.
        """
        thunks = list(thunks)
        for t in thunks:
            if not callable(t):
                raise TypeError("parallel() expects an iterable of zero-arg callables")
        return _pool_map(thunks, lambda t: t(), allSettled=allSettled)

    def pipeline(items, *stages, allSettled=False):
        """Map items left-to-right through one-arg stage callables.

        Every item clears stage N before any item enters stage N+1 (barrier per
        stage). Stage 1 receives the original item; later stages receive the
        previous stage's result. Pool width honors the live host limit; zero is unlimited.
        """
        current = _AwaitableList(items)
        for stage in stages:
            if not callable(stage):
                raise TypeError("pipeline() stages must be callables")
            current = _pool_map(current, stage, allSettled=allSettled)
        return current

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
