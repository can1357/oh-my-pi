from __future__ import annotations

# OMP prelude helpers (loaded once into the runner namespace)
if "__omp_prelude_loaded__" not in globals():
    __omp_prelude_loaded__ = True
    from pathlib import Path
    import os, json, math, re
    from urllib.parse import unquote

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
        if offset > 1 or limit is not None:
            lines = data.splitlines(keepends=True)
            start = max(0, offset - 1)
            end = start + limit if limit else len(lines)
            data = "".join(lines[start:end])
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

    class _ToolCallable:
        """Invokes one host-side tool via the loopback HTTP bridge."""

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

    class _ToolProxy:
        """`tool.<name>(args)` proxy mirroring the JS runtime bridge."""

        __slots__ = ()

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
        label=None,
        schema=None,
        schema_mode=None,
        isolated=None,
        apply=None,
        merge=None,
        handle=False,
    ):
        """Run a subagent and return its final output or structured data.

        `schema` overrides agent and session schemas. `schema_mode` is
        `"permissive"` or `"strict"`. `handle=True` returns the child output
        reference and metadata, with parsed data under `"data"` when available.
        """
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
        if handle:
            args["handle"] = True
        res = _bridge_call("__agent__", args)
        text = res.get("text") if isinstance(res, dict) else res
        has_data = isinstance(res, dict) and "data" in res
        parsed = res["data"] if has_data else json.loads(text) if schema is not None else text
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
        if has_data or schema is not None:
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

    def _concurrency_limit():
        """Worker-pool ceiling from the host ``task.maxConcurrency`` setting.

        An eval fan-out runs as wide as a ``task`` batch would. Returns ``0`` for
        unbounded (run every item at once); falls back to ``0`` if the host
        bridge is unreachable.
        """
        try:
            snap = _bridge_call("__concurrency__", {}) or {}
            n = int(snap.get("limit") or 0)
        except Exception:
            return 0
        return n if n > 0 else 0

    class _AwaitableList(list):
        """Completed list result accepted by both sync and ``await`` syntax."""

        def __await__(self):
            yield from ()
            return self


    def _pool_map(items, fn):
        """Run ``fn`` over ``items`` through a bounded thread pool.

        Preserves input order, barriers until every task settles, and raises the
        lowest-index exception if any task failed. Each task runs inside a copy
        of the submitting thread's context so the ``_CURRENT_RID`` ContextVar
        propagates and bridge calls (agent(), tool.*, etc.) keep working. The
        pool width tracks ``task.maxConcurrency`` (0 = run every item at once).
        """
        import concurrent.futures, contextvars

        items = list(items)
        if not items:
            return _AwaitableList()
        limit = _concurrency_limit()
        workers = min(limit, len(items)) if limit > 0 else len(items)
        results = _AwaitableList(None for _ in items)
        errors = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {}
            for i, item in enumerate(items):
                ctx = contextvars.copy_context()
                futures[pool.submit(ctx.run, fn, item)] = i
            for fut in concurrent.futures.as_completed(futures):
                i = futures[fut]
                try:
                    results[i] = fut.result()
                except BaseException as exc:  # noqa: BLE001 - propagate to caller
                    errors[i] = exc
        if errors:
            raise errors[min(errors)]
        return results

    def parallel(thunks):
        """Run zero-arg callables through a bounded pool, preserving input order.

        Barriers until all finish; re-raises the lowest-index exception if any
        thunk raised. Pool width tracks the task tool's ``task.maxConcurrency``.
        """
        thunks = list(thunks)
        for t in thunks:
            if not callable(t):
                raise TypeError("parallel() expects an iterable of zero-arg callables")
        return _pool_map(thunks, lambda t: t())

    def pipeline(items, *stages):
        """Map items left-to-right through one-arg stage callables.

        Every item clears stage N before any item enters stage N+1 (barrier per
        stage). Stage 1 receives the original item; later stages receive the
        previous stage's result. Pool width tracks ``task.maxConcurrency``.
        """
        current = _AwaitableList(items)
        for stage in stages:
            if not callable(stage):
                raise TypeError("pipeline() stages must be callables")
            current = _pool_map(current, stage)
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

    # llm_query's delegated-prompt shape lives in the static llm_query.md
    # template (injected at the top of this source as
    # __omp_llm_query_template__ by eval/py/prelude.ts); this single pass over
    # the placeholders is the whole interpolation, so a payload that itself
    # contains {{instructions}}/{{snippet}} is never re-scanned.
    _LLM_QUERY_TEMPLATE_RE = re.compile(r"\{\{(instructions|snippet)\}\}")

    def llm_query(snippet, instructions=None, *, model="default"):
        """Sub-LLM completion. `instructions` prefixes `snippet` when given."""
        if instructions is not None:
            prompt = _LLM_QUERY_TEMPLATE_RE.sub(
                lambda m: instructions if m.group(1) == "instructions" else snippet,
                __omp_llm_query_template__,
            )
        else:
            prompt = snippet
        return completion(prompt, model=model)

    def llm_query_batched(prompts, *, model="default"):
        """Parallel sub-LLM completions, preserving input order."""
        return parallel([lambda p=p: llm_query(p, model=model) for p in prompts])

    def rlm_query(prompt, *, agent=None):
        """Recursive subagent via agent(); returns its text output. `agent=None` (default) resolves the session's spawn-policy default. `agent` is resolved through globals() so the `agent` parameter does not shadow the module-level agent() helper."""
        return globals()["agent"](prompt, agent=agent)

    def rlm_query_batched(prompts, *, agent=None):
        """Parallel recursive subagents, preserving input order."""
        return parallel([lambda p=p: rlm_query(p, agent=agent) for p in prompts])

    def chunk(text, *, by="lines", size=100):
        """Split `text` into chunks of `size` lines, or into fixed ~`size`-token windows."""
        if by not in ("lines", "tokens"):
            raise ValueError(f"chunk by must be 'lines' or 'tokens', got {by!r}")
        if not isinstance(size, int) or size <= 0:
            raise ValueError("chunk size must be a positive integer")
        if by == "lines":
            # Scan line offsets incrementally (lazy finditer over the same
            # line-break separators splitlines() understands) instead of
            # text.splitlines(), which materializes a full list of every line
            # substring: for a large line-rich payload that list would coexist
            # with the joined chunk strings and the original text, tripling
            # memory use and risking an eval-worker OOM before any chunk is
            # delegated. Only `size` lines are buffered at a time.
            if text == "":
                return []
            chunks = []
            buf = []
            last = 0
            for m in _line_break_re.finditer(text):
                buf.append(text[last : m.start()])
                if len(buf) == size:
                    chunks.append("\n".join(buf))
                    buf = []
                last = m.end()
            if last < len(text):
                buf.append(text[last:])
            if buf:
                chunks.append("\n".join(buf))
            return chunks
        # Bounded by character count (~4 chars/token, matching metadata()'s
        # approx_tokens heuristic) rather than whitespace-word splitting: an
        # unbroken multi-MB line (minified JSON/base64/code) must still be
        # split into windows llm_query() can consume, regardless of whitespace.
        max_chars = size * 4
        return [text[i : i + max_chars] for i in range(0, len(text), max_chars)]

    def search(text, pattern, flags=0, *, limit=100, max_line_chars=1000):
        """Return 'L<lineno>: <line>' for each line matching the regex `pattern`, stopping after `limit` matches (default 100); a trailing '... (truncated, more matches may exist)' entry marks an early stop. Matching lines longer than `max_line_chars` characters (default 1000) are not cut from the line start — that could drop the matched region entirely (e.g. a key near the end of one minified JSON line) — instead a bounded window around the first match is kept, emitted as 'L<lineno>@<offset>: <window>' with '...' markers on cut sides and a '... (line truncated)' suffix for the right cut, so a single oversized line cannot blow up the result. Window edges are shifted onto code-point boundaries so a cut never bisects a surrogate pair into a lone half."""
        if not isinstance(limit, int) or limit <= 0:
            raise ValueError("search limit must be a positive integer")
        if not isinstance(max_line_chars, int) or max_line_chars <= 0:
            raise ValueError("search max_line_chars must be a positive integer")
        rx = re.compile(pattern, flags)
        # Incremental line scan via lazy finditer over _line_break_re (the
        # same Unicode line-break set splitlines() understands) instead of
        # text.splitlines(), which materializes a full list of every line
        # substring: search() only ever emits matching lines, so for a large
        # line-rich payload the list would double memory use before the first
        # hit is returned. Only one line is in flight at a time; 1-indexed
        # numbering and the rstrip() trim are identical to the old behavior.
        # The result list is bounded too: scanning stops as soon as `limit`
        # matches are retained (trailing marker appended), and each retained
        # match is itself capped at `max_line_chars` characters. An oversized
        # matching line is not cut from its start — that can drop the matched
        # region entirely (e.g. a key near the end of one minified JSON
        # line), defeating the discovery role — instead a bounded window
        # around the first match is kept, annotated with the match offset as
        # `L<n>@<offset>:`, "..." markers on any cut side, and a '... (line
        # truncated)' suffix for the right cut. A broad or frequent pattern on
        # a huge payload — including one unbroken multi-MB line, e.g.
        # minified JSON/base64, whose whole content a match would otherwise
        # copy — cannot grow the output past the input and OOM the eval
        # worker.
        def _entry(line):
            if not rx.search(line):
                return None
            content = line.rstrip()
            if len(content) <= max_line_chars:
                return f"L{line_no}: {content}"
            # Oversized line: keep a bounded window centered on the first
            # match instead of the line prefix, so the excerpt always
            # contains the matched region. The `L<n>@<offset>:` annotation
            # pins the window's character offset in the line; "..." marks a
            # cut on either side.
            first = rx.search(line)
            match_start = first.start() if first else 0
            k = max_line_chars // 2
            start = match_start - k
            end = match_start + (max_line_chars - k)
            if start < 0:
                start = 0
                end = min(len(line), max_line_chars)
            elif end > len(line):
                end = len(line)
                start = max(0, len(line) - max_line_chars)
            # Never slice through a surrogate pair: a window edge landing
            # between the two halves would emit a lone half that a JSON
            # round-trip turns into a U+FFFD replacement char, corrupting
            # the excerpt. Back `start` off a low surrogate (its high half
            # re-enters the window) and push `end` past a low surrogate
            # whose high half is inside the window, so both edges sit on
            # code-point boundaries (the same discipline chunk(by="tokens")
            # applies; Python strings are code-point sequences, so this only
            # matters when the payload itself carries surrogate code points,
            # e.g. a JSON-decoded \ud83d\ude00 escape). Lone surrogates in
            # the input itself are left alone — the cut never creates them.
            while start > 0 and start < len(line) and 0xDC00 <= ord(line[start]) <= 0xDFFF:
                start -= 1
            if (
                end > 0
                and end < len(line)
                and 0xDC00 <= ord(line[end]) <= 0xDFFF
                and 0xD800 <= ord(line[end - 1]) <= 0xDBFF
            ):
                end += 1
            left = "..." if start > 0 else ""
            right = "... (line truncated)" if end < len(line) else ""
            return f"L{line_no}@{start}: {left}{line[start:end].rstrip()}{right}"

        out = []
        line_no = 0
        last = 0
        for m in _line_break_re.finditer(text):
            line_no += 1
            line = text[last : m.start()]
            last = m.end()
            entry = _entry(line)
            if entry is not None:
                out.append(entry)
                if len(out) == limit and last < len(text):
                    out.append("... (truncated, more matches may exist)")
                    return out
        if last < len(text):
            line_no += 1
            entry = _entry(text[last:])
            if entry is not None:
                out.append(entry)
        return out

    _line_break_re = re.compile(r"\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]")
    _word_re = re.compile(r"\S+")

    def _count_lines_and_words(text):
        # Single-pass scans via re.finditer (lazy, discards each match
        # immediately) instead of text.splitlines()/text.split(), which
        # both materialize a full list of substrings for the whole
        # payload. metadata() sizes input before any chunk is delegated,
        # so a large document must not multiply memory here.
        boundaries = 0
        last_end = 0
        for m in _line_break_re.finditer(text):
            boundaries += 1
            last_end = m.end()
        lines = 0 if not text else boundaries + 1
        if boundaries and last_end == len(text):
            lines -= 1
        words = sum(1 for _ in _word_re.finditer(text))
        return lines, words

    def metadata(text):
        """Shape stats for a str or a list of strings."""
        if isinstance(text, str):
            lines, words = _count_lines_and_words(text)
            return {
                "type": "str",
                "chars": len(text),
                "lines": lines,
                "words": words,
                "approx_tokens": len(text) // 4,
            }
        return {
            "type": "list",
            "items": len(text),
            "chars": sum(len(s) for s in text),
            "approx_tokens": sum(len(s) for s in text) // 4,
        }
