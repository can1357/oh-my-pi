# OMP Julia prelude helpers (loaded once into the runner's top-level scope).

if !isdefined(Main, :__omp_prelude_loaded)
    global __omp_prelude_loaded = true
end

# -------------------------------------------------------------------------
# Internal-URL path resolution
# -------------------------------------------------------------------------

function __omp_url_decode(s::String)
    res = IOBuffer()
    i = 1
    len = ncodeunits(s)
    while i <= len
        c = Char(codeunit(s, i))
        if c == '%' && i + 2 <= len
            h_str = s[i+1:i+2]
            try
                b = parse(UInt8, h_str, base=16)
                write(res, b)
                i += 3
                continue
            catch
                # ignore format error
            end
        end
        write(res, c)
        i += 1
    end
    return String(take!(res))
end

function __omp_resolve_path(p::AbstractString)
    m = match(r"^([a-z][a-z0-9+.\-]*)://(.*)$"i, p)
    if m === nothing
        return abspath(p)
    end
    scheme = lowercase(string(m.captures[1]))
    roots_env = get(ENV, "PI_EVAL_LOCAL_ROOTS", "{}")
    roots = try
         Main.json_parse(roots_env)
    catch
         Dict{String, Any}()
    end
    root = get(roots, scheme, nothing)
    if root === nothing || isempty(root)
        error("Protocol paths are not supported by this helper: $p")
    end
    
    relative = __omp_url_decode(replace(string(m.captures[2]), '\\' => '/'))
    root_path = abspath(string(root))
    if isempty(relative)
        return root_path
    end
    
    if startswith(relative, '/') || ".." in split(relative, '/')
        error("Unsafe $scheme:// path (absolute or traversal): $p")
    end
    
    resolved = abspath(joinpath(root_path, relative))
    if resolved != root_path && !startswith(resolved, root_path * Base.Filesystem.path_separator)
        error("$scheme:// path escapes its root: $p")
    end
    return resolved
end

# -------------------------------------------------------------------------
# Display + status
# -------------------------------------------------------------------------


function display_image(base64_str::String, mime_type::String = "image/png")
    bundle = Dict(mime_type => base64_str)
    Main.emit_frame(Dict("type" => "display", "id" => Main.current_rid, "bundle" => bundle))
    return nothing
end

function __omp_emit_status(op::String, fields::AbstractDict=Dict{String, Any}())
    status = Dict{String, Any}("op" => op)
    for (k, v) in fields
        status[string(k)] = v
    end
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict("application/x-omp-status" => status)
    ))
    return nothing
end

# -------------------------------------------------------------------------
# File helpers
# -------------------------------------------------------------------------

function Base.read(path::AbstractString, offset::Integer=1, limit::Union{Integer, Nothing}=nothing)
    resolved = __omp_resolve_path(string(path))
    content = open(resolved, "r") do io
        Base.read(io, String)
    end
    lines = split(content, '\n')
    if offset > 1 || limit !== nothing
        st = max(1, offset)
        en = limit !== nothing ? min(length(lines), st + limit - 1) : length(lines)
        if st <= length(lines)
            content = join(lines[st:en], '\n')
        else
            content = ""
        end
    end
    
    preview = length(content) > 500 ? content[1:500] : content
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "read",
                "path" => resolved,
                "chars" => length(content),
                "preview" => preview
            )
        )
    ))
    return content
end

function Base.write(path::AbstractString, content::Any)
    resolved = __omp_resolve_path(string(path))
    mkpath(dirname(resolved))
    open(resolved, "w") do io
        Base.write(io, string(content))
    end
    
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "write",
                "path" => resolved,
                "chars" => length(string(content))
            )
        )
    ))
    return resolved
end

function __omp_apply_query(data, query)
    if query === nothing || isempty(string(query))
        return data
    end
    q = strip(string(query))
    if startswith(q, ".")
        q = length(q) == 1 ? "" : q[2:end]
    end
    if isempty(q)
        return data
    end

    tokens = Vector{Tuple{Symbol, Any}}()
    buf = ""
    chars = collect(q)
    i = 1
    while i <= length(chars)
        ch = chars[i]
        if ch == '.'
            if !isempty(buf)
                push!(tokens, (:key, buf))
                buf = ""
            end
        elseif ch == '['
            if !isempty(buf)
                push!(tokens, (:key, buf))
                buf = ""
            end
            j = i + 1
            while j <= length(chars) && chars[j] != ']'
                j += 1
            end
            inner = j > i + 1 ? String(chars[(i + 1):(j - 1)]) : ""
            if startswith(inner, "\"") && endswith(inner, "\"")
                push!(tokens, (:key, length(inner) <= 2 ? "" : inner[2:end-1]))
            else
                push!(tokens, (:index, parse(Int, inner)))
            end
            i = j
        else
            buf *= string(ch)
        end
        i += 1
    end
    if !isempty(buf)
        push!(tokens, (:key, buf))
    end

    current = data
    for (kind, value) in tokens
        if kind == :index
            if !(current isa AbstractVector)
                return nothing
            end
            idx = Int(value)
            julia_idx = idx >= 0 ? idx + 1 : length(current) + idx + 1
            if julia_idx < 1 || julia_idx > length(current)
                return nothing
            end
            current = current[julia_idx]
        else
            key = string(value)
            if !(current isa AbstractDict) || !haskey(current, key)
                return nothing
            end
            current = current[key]
        end
    end
    return current
end

function __omp_json_text(value)
    if value === nothing
        return "null"
    end
    try
        return Main.json_serialize(value)
    catch
        return string(value)
    end
end

function __omp_optional_int(value, default::Int)
    if value === nothing
        return default
    elseif value isa Integer
        return Int(value)
    elseif value isa AbstractFloat
        return Int(trunc(value))
    elseif value isa AbstractString
        return parse(Int, value)
    end
    return Int(value)
end

function output(ids...; format="raw", query=nothing, offset=nothing, limit=nothing)
    artifacts_dir = get(ENV, "PI_ARTIFACTS_DIR", "")
    if isempty(artifacts_dir)
        session_file = get(ENV, "PI_SESSION_FILE", "")
        if isempty(session_file)
            __omp_emit_status("output", Dict{String, Any}("error" => "No session file available"))
            error("No session - output artifacts unavailable")
        end
        artifacts_dir = replace(session_file, r"\.[^.]*$" => "")
    end
    if !isdir(artifacts_dir)
        __omp_emit_status("output", Dict{String, Any}("error" => "Artifacts directory not found", "path" => artifacts_dir))
        error("No artifacts directory found: $artifacts_dir")
    end
    if isempty(ids)
        __omp_emit_status("output", Dict{String, Any}("error" => "No IDs provided"))
        error("At least one output ID is required")
    end
    if query !== nothing && (offset !== nothing || limit !== nothing)
        __omp_emit_status("output", Dict{String, Any}("error" => "query cannot be combined with offset/limit"))
        error("query cannot be combined with offset/limit")
    end

    results = Vector{Dict{String, Any}}()
    not_found = String[]
    for output_id_value in ids
        output_id = string(output_id_value)
        output_path = joinpath(artifacts_dir, output_id * ".md")
        if !isfile(output_path)
            push!(not_found, output_id)
            continue
        end

        raw = open(output_path, "r") do io
            Base.read(io, String)
        end
        raw_lines = split(raw, '\n'; keepempty=true)
        total_lines = length(raw_lines)
        selected = raw
        range_info = nothing

        if query !== nothing
            json_value = try
                Main.json_parse(raw)
            catch err
                __omp_emit_status("output", Dict{String, Any}("id" => output_id, "error" => "Not valid JSON: $(err)"))
                error("Output $output_id is not valid JSON: $(err)")
            end
            result_value = __omp_apply_query(json_value, query)
            selected = __omp_json_text(result_value)
        elseif offset !== nothing || limit !== nothing
            start_line = max(1, __omp_optional_int(offset, 1))
            if start_line > total_lines
                __omp_emit_status("output", Dict{String, Any}("id" => output_id, "error" => "Offset $start_line beyond end ($total_lines lines)"))
                error("Offset $start_line is beyond end of output ($total_lines lines) for $output_id")
            end
            effective_limit = limit === nothing ? total_lines - start_line + 1 : __omp_optional_int(limit, total_lines - start_line + 1)
            end_line = min(total_lines, start_line + effective_limit - 1)
            selected = join(raw_lines[start_line:end_line], '\n')
            range_info = Dict{String, Any}("start_line" => start_line, "end_line" => end_line, "total_lines" => total_lines)
        end

        if format == "stripped"
            selected = replace(selected, r"\x1b\[[0-9;]*m" => "")
        end

        if format == "json"
            entry = Dict{String, Any}(
                "id" => output_id,
                "path" => output_path,
                "line_count" => query !== nothing ? length(split(selected, '\n')) : total_lines,
                "char_count" => query !== nothing ? length(selected) : length(raw),
                "content" => selected
            )
            if range_info !== nothing
                entry["range"] = range_info
            end
            if query !== nothing
                entry["query"] = query
            end
            push!(results, entry)
        else
            push!(results, Dict{String, Any}("id" => output_id, "content" => selected))
        end
    end

    if !isempty(not_found)
        available = sort([replace(name, r"\.md$" => "") for name in readdir(artifacts_dir) if endswith(name, ".md")])
        msg = "Output not found: $(join(not_found, ", "))"
        if !isempty(available)
            shown = available[1:min(20, length(available))]
            msg *= "\n\nAvailable outputs: $(join(shown, ", "))"
            if length(available) > 20
                msg *= " (and $(length(available) - 20) more)"
            end
        end
        __omp_emit_status("output", Dict{String, Any}("not_found" => not_found, "available_count" => length(available)))
        error(msg)
    end

    if length(ids) == 1
        if format == "json"
            __omp_emit_status("output", Dict{String, Any}("id" => string(ids[1]), "chars" => results[1]["char_count"]))
            return results[1]
        end
        __omp_emit_status("output", Dict{String, Any}("id" => string(ids[1]), "chars" => length(results[1]["content"])))
        return results[1]["content"]
    end

    if format == "json"
        __omp_emit_status("output", Dict{String, Any}("count" => length(results), "total_chars" => sum(r["char_count"] for r in results)))
        return results
    end

    __omp_emit_status("output", Dict{String, Any}("count" => length(results), "total_chars" => sum(length(r["content"]) for r in results)))
    return results
end

function env(key=nothing, value=nothing)
    if key === nothing
        items = Dict{String, String}()
        for (k, v) in ENV
            items[k] = v
        end
        keys_list = sort(collect(keys(items)))
        Main.emit_frame(Dict(
            "type" => "display",
            "id" => Main.current_rid,
            "bundle" => Dict(
                "application/x-omp-status" => Dict(
                    "op" => "env",
                    "count" => length(items),
                    "keys" => keys_list[1:min(20, length(keys_list))]
                )
            )
        ))
        return items
    end
    
    k = string(key)
    if value !== nothing
        v = string(value)
        ENV[k] = v
        Main.emit_frame(Dict(
            "type" => "display",
            "id" => Main.current_rid,
            "bundle" => Dict(
                "application/x-omp-status" => Dict(
                    "op" => "env",
                    "key" => k,
                    "value" => v,
                    "action" => "set"
                )
            )
        ))
        return v
    end
    
    v = get(ENV, k, nothing)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "env",
                "key" => k,
                "value" => v,
                "action" => "get"
            )
        )
    ))
    return v
end

# -------------------------------------------------------------------------
# Dynamic bridge proxy
# -------------------------------------------------------------------------

using Downloads

function __omp_call_bridge(name::String, args::Dict{String, Any})
    base_url = get(ENV, "PI_TOOL_BRIDGE_URL", nothing)
    token = get(ENV, "PI_TOOL_BRIDGE_TOKEN", nothing)
    session = get(ENV, "PI_TOOL_BRIDGE_SESSION", nothing)
    
    if base_url === nothing || token === nothing || session === nothing
        error("Tool bridge is not available in this cell.")
    end
    
    url = base_url
    if !endswith(url, "/v1/tool")
        url = endswith(url, "/") ? (url * "v1/tool") : (url * "/v1/tool")
    end

    payload_dict = Dict(
        "session" => session,
        "run" => Main.current_rid,
        "name" => name,
        "args" => args
    )
    payload_json = Main.json_serialize(payload_dict)
    
    headers = [
        "Authorization" => "Bearer $token",
        "Content-Type" => "application/json"
    ]
    
    io_out = IOBuffer()
    response = Downloads.request(
        url,
        method="POST",
        headers=headers,
        input=IOBuffer(payload_json),
        output=io_out
    )
    
    resp_str = String(take!(io_out))
    if response.status != 200
        error("Tool bridge call failed with status $(response.status): $resp_str")
    end
    
    parsed_resp = Main.json_parse(resp_str)
    
    ok = get(parsed_resp, "ok", false)
    if !ok
        err_msg = get(parsed_resp, "error", "Unknown error")
        error("Tool bridge error: $err_msg")
    end
    
    return get(parsed_resp, "value", nothing)
end

struct OmpToolProxy end

struct OmpToolCallable
    name::String
end

function (tc::OmpToolCallable)(args...; kwargs...)
    args_dict = Dict{String, Any}()
    if length(args) == 1 && args[1] isa AbstractDict
        for (k, v) in args[1]
            args_dict[string(k)] = v
        end
    end
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    
    return __omp_call_bridge("tool:" * tc.name, args_dict)
end

function Base.getproperty(::OmpToolProxy, sym::Symbol)
    return OmpToolCallable(string(sym))
end

const tool = OmpToolProxy()

# -------------------------------------------------------------------------
# Agent calls
# -------------------------------------------------------------------------

function completion(prompt::String; model="default", system=nothing, schema=nothing, kwargs...)
    args_dict = Dict{String, Any}("prompt" => prompt, "model" => model)
    if system !== nothing
        args_dict["system"] = system
    end
    if schema !== nothing
        args_dict["schema"] = schema
    end
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    res = __omp_call_bridge("__completion__", args_dict)
    text = res isa AbstractDict ? get(res, "text", res) : res
    return schema === nothing ? text : Main.json_parse(string(text))
end

function agent(prompt::String; agent="task", model=nothing, label=nothing, schema=nothing, isolated=nothing, apply=nothing, merge=nothing, handle=false, kwargs...)
    args_dict = Dict{String, Any}("prompt" => prompt)
    if agent !== nothing
        args_dict["agent"] = agent
    end
    if model !== nothing
        args_dict["model"] = model
    end
    if label !== nothing
        args_dict["label"] = label
    end
    if schema !== nothing
        args_dict["schema"] = schema
    end
    # Isolation knobs mirror the `task` tool: strict opt-in via `isolated`,
    # with `apply`/`merge` controlling the post-run patch/branch merge.
    if isolated !== nothing
        args_dict["isolated"] = Bool(isolated)
    end
    if apply !== nothing
        args_dict["apply"] = Bool(apply)
    end
    if merge !== nothing
        args_dict["merge"] = Bool(merge)
    end
    handle_result = handle
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    # Tell the bridge a handle is wanted so it preserves the backing artifacts.
    if handle_result
        args_dict["handle"] = true
    end
    res = __omp_call_bridge("__agent__", args_dict)
    text = res isa AbstractDict ? get(res, "text", res) : res
    parsed = schema === nothing ? text : Main.json_parse(string(text))
    if !handle_result
        return parsed
    end
    details = res isa AbstractDict ? get(res, "details", nothing) : nothing
    if !(details isa AbstractDict) || get(details, "id", nothing) === nothing
        return Dict{String, Any}("text" => text, "output" => text, "handle" => nothing, "id" => nothing, "agent" => nothing)
    end
    node = Dict{String, Any}(
        "text" => text,
        "output" => text,
        "handle" => "agent://" * string(get(details, "id", nothing)),
        "id" => get(details, "id", nothing),
        "agent" => get(details, "agent", nothing)
    )
    if schema !== nothing
        node["data"] = parsed
    end
    for (src_key, dst_key) in (
        ("isolated", "isolated"),
        ("patchPath", "patch_path"),
        ("branchName", "branch_name"),
        ("nestedPatches", "nested_patches"),
        ("changesApplied", "changes_applied"),
        ("isolationSummary", "isolation_summary"),
    )
        if haskey(details, src_key)
            node[dst_key] = details[src_key]
        end
    end
    return node
end

function Base.log(message::AbstractString)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "log",
                "message" => message
            )
        )
    ))
    return nothing
end

function phase(title::String)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "phase",
                "title" => title
            )
        )
    ))
    return nothing
end

# -------------------------------------------------------------------------
# Concurrency
# -------------------------------------------------------------------------

function _concurrency_limit()
    try
        snap = __omp_call_bridge("__concurrency__", Dict{String, Any}())
        limit_val = snap isa AbstractDict ? get(snap, "limit", 0) : snap
        return limit_val isa Number ? max(Int(limit_val), 0) : 0
    catch
        return 0
    end
end

function _pool_map(items, fn)
    if isempty(items)
        return []
    end
    limit = _concurrency_limit()
    
    n = length(items)
    results = Vector{Any}(undef, n)
    errors = Dict{Int, Any}()
    
    sem = limit > 0 ? Channel{Nothing}(limit) : nothing
    
    @sync for i in 1:n
        if sem !== nothing
            put!(sem, nothing)
        end
        item = items[i]
        idx = i
        @async begin
            try
                res = fn(item)
                results[idx] = res
            catch err
                errors[idx] = err
            finally
                if sem !== nothing
                    take!(sem)
                end
            end
        end
    end
    
    if !isempty(errors)
        min_idx = minimum(keys(errors))
        throw(errors[min_idx])
    end
    return results
end

function parallel(thunks)
    return _pool_map(thunks, t -> t())
end

function pipeline(items, stages...)
    curr = collect(items)
    for stage in stages
        curr = _pool_map(curr, stage)
    end
    return curr
end

# -------------------------------------------------------------------------
# Budget
# -------------------------------------------------------------------------

struct OmpBudgetProxy end

function __omp_budget_snapshot()
    try
        snap = __omp_call_bridge("__budget__", Dict{String, Any}())
        return snap isa AbstractDict ? snap : Dict{String, Any}()
    catch
        return Dict{String, Any}()
    end
end

function __omp_budget_int(value, default::Int=0)
    if value isa Integer
        return Int(value)
    elseif value isa AbstractFloat
        return Int(trunc(value))
    elseif value isa AbstractString
        try
            return parse(Int, value)
        catch
            return default
        end
    end
    return default
end

function Base.getproperty(::OmpBudgetProxy, sym::Symbol)
    if sym === :total
        snap = __omp_budget_snapshot()
        return get(snap, "total", nothing)
    elseif sym === :hard
        snap = __omp_budget_snapshot()
        return get(snap, "hard", false) == true
    elseif sym === :spent
        return () -> __omp_budget_int(get(__omp_budget_snapshot(), "spent", 0), 0)
    elseif sym === :remaining
        return () -> begin
            snap = __omp_budget_snapshot()
            total = get(snap, "total", nothing)
            if total === nothing
                return Inf
            end
            return max(0, __omp_budget_int(total, 0) - __omp_budget_int(get(snap, "spent", 0), 0))
        end
    end
    error("Unknown budget metric: $sym")
end

const budget = OmpBudgetProxy()
