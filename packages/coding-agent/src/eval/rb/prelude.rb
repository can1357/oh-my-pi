# frozen_string_literal: false
# OMP Ruby prelude helpers (loaded once into the runner's TOPLEVEL_BINDING).
#
# Mirrors eval/py/prelude.py: defines the cross-runtime helper surface
# (display/read/write/env/output, the `tool` bridge proxy,
# completion/agent/parallel/pipeline/log/phase/budget). Host-side helpers reach
# the coding-agent over the same loopback HTTP tool bridge the Python prelude
# uses (PI_TOOL_BRIDGE_URL/TOKEN/SESSION). Path helpers honor PI_EVAL_LOCAL_ROOTS
# so `write("local://x")` lands where `read local://x` resolves.
#
# `__omp_*` primitives (emit/present/status/scrub/run_id) are provided by
# runner.rb; this file only consumes them.

unless defined?($__omp_prelude_loaded) && $__omp_prelude_loaded
  $__omp_prelude_loaded = true

  require "json"

  # -------------------------------------------------------------------------
  # Internal-URL path resolution
  # -------------------------------------------------------------------------

  def __omp_url_decode(str)
    str.gsub(/%([0-9A-Fa-f]{2})/) { [Regexp.last_match(1)].pack("H2") }.force_encoding(Encoding::UTF_8)
  end

  # Map a helper path to a real filesystem path. A `scheme://…` whose scheme has
  # an injected on-disk root (PI_EVAL_LOCAL_ROOTS, e.g. `local://`) is rewritten
  # under that root; plain paths pass through; any other `scheme://` is rejected.
  def __omp_resolve_path(path)
    return path unless path.is_a?(String)
    m = path.match(%r{\A([a-z][a-z0-9+.\-]*)://(.*)\z}i)
    return path unless m
    scheme = m[1].downcase
    roots =
      begin
        raw = ENV["PI_EVAL_LOCAL_ROOTS"]
        raw && !raw.empty? ? JSON.parse(raw) : {}
      rescue StandardError
        {}
      end
    root = roots.is_a?(Hash) ? roots[scheme] : nil
    raise "Protocol paths are not supported by this helper: #{path}" if root.nil? || root.to_s.empty?
    relative = __omp_url_decode(m[2].tr("\\", "/"))
    root_path = File.absolute_path(root.to_s)
    return root_path if relative.empty?
    if relative.start_with?("/") || relative.split("/").include?("..")
      raise "Unsafe #{scheme}:// path (absolute or traversal): #{path}"
    end
    resolved = File.absolute_path(File.join(root_path, relative))
    unless resolved == root_path || resolved.start_with?(root_path + File::SEPARATOR)
      raise "#{scheme}:// path escapes its root: #{path}"
    end
    resolved
  end

  # -------------------------------------------------------------------------
  # Display + status
  # -------------------------------------------------------------------------

  def display(value)
    __omp_present(value, "display")
    nil
  end

  # Emit a base64 image as a display output. `mime_type` is "image/png" (default)
  # or "image/jpeg"; the host surfaces it as an inspectable image block.
  def display_image(base64, mime_type: "image/png")
    __omp_emit_display({ mime_type.to_s => base64.to_s })
    nil
  end

  def env(key = nil, value = nil)
    if key.nil?
      items = ENV.to_h.sort.to_h
      __omp_emit_status("env", "count" => items.size, "keys" => items.keys.first(20))
      return items
    end
    unless value.nil?
      ENV[key.to_s] = value.to_s
      __omp_emit_status("env", "key" => key.to_s, "value" => value.to_s, "action" => "set")
      return value
    end
    val = ENV[key.to_s]
    __omp_emit_status("env", "key" => key.to_s, "value" => val, "action" => "get")
    val
  end

  # -------------------------------------------------------------------------
  # File helpers
  # -------------------------------------------------------------------------

  def read(path, offset = 1, limit = nil)
    resolved = __omp_resolve_path(path)
    data = File.read(resolved.to_s, encoding: Encoding::UTF_8)
    if offset > 1 || !limit.nil?
      lines = data.lines
      start = [offset - 1, 0].max
      finish = limit ? start + limit : lines.length
      data = lines[start...finish].to_a.join
    end
    __omp_emit_status("read", "path" => resolved.to_s, "chars" => data.length, "preview" => __omp_scrub(data[0, 500].to_s))
    data
  end

  def write(path, content)
    resolved = __omp_resolve_path(path)
    require "fileutils"
    FileUtils.mkdir_p(File.dirname(resolved.to_s))
    File.write(resolved.to_s, content.to_s)
    __omp_emit_status("write", "path" => resolved.to_s, "chars" => content.to_s.length)
    resolved.to_s
  end

  # -------------------------------------------------------------------------
  # Task/agent output reader
  # -------------------------------------------------------------------------

  def __omp_apply_query(data, query)
    return data if query.nil? || query.empty?
    q = query.strip
    q = q[1..] if q.start_with?(".")
    return data if q.empty?
    tokens = []
    buf = +""
    i = 0
    while i < q.length
      ch = q[i]
      if ch == "."
        unless buf.empty?
          tokens << [:key, buf]
          buf = +""
        end
      elsif ch == "["
        unless buf.empty?
          tokens << [:key, buf]
          buf = +""
        end
        j = i + 1
        j += 1 while j < q.length && q[j] != "]"
        inner = q[(i + 1)...j]
        if inner.start_with?('"') && inner.end_with?('"')
          tokens << [:key, inner[1..-2]]
        else
          tokens << [:index, inner.to_i]
        end
        i = j
      else
        buf << ch
      end
      i += 1
    end
    tokens << [:key, buf] unless buf.empty?

    current = data
    tokens.each do |kind, value|
      if kind == :index
        return nil unless current.is_a?(Array) && value < current.length
        current = current[value]
      else
        return nil unless current.is_a?(Hash) && current.key?(value)
        current = current[value]
      end
    end
    current
  end

  def output(*ids, format: "raw", query: nil, offset: nil, limit: nil)
    artifacts_dir = ENV["PI_ARTIFACTS_DIR"]
    if artifacts_dir.nil? || artifacts_dir.empty?
      session_file = ENV["PI_SESSION_FILE"]
      if session_file.nil? || session_file.empty?
        __omp_emit_status("output", "error" => "No session file available")
        raise "No session - output artifacts unavailable"
      end
      artifacts_dir = session_file.sub(/\.[^.]*\z/, "")
    end
    unless File.directory?(artifacts_dir)
      __omp_emit_status("output", "error" => "Artifacts directory not found", "path" => artifacts_dir)
      raise "No artifacts directory found: #{artifacts_dir}"
    end
    raise ArgumentError, "At least one output ID is required" if ids.empty?
    if query && (!offset.nil? || !limit.nil?)
      __omp_emit_status("output", "error" => "query cannot be combined with offset/limit")
      raise ArgumentError, "query cannot be combined with offset/limit"
    end

    results = []
    not_found = []
    ids.each do |output_id|
      path = File.join(artifacts_dir, "#{output_id}.md")
      unless File.exist?(path)
        not_found << output_id
        next
      end
      raw = File.read(path, encoding: Encoding::UTF_8)
      raw_lines = raw.split("\n", -1)
      total_lines = raw_lines.length
      selected = raw
      range_info = nil

      if query
        json_value =
          begin
            JSON.parse(raw)
          rescue JSON::ParserError => e
            __omp_emit_status("output", "id" => output_id, "error" => "Not valid JSON: #{e.message}")
            raise "Output #{output_id} is not valid JSON: #{e.message}"
          end
        result_value = __omp_apply_query(json_value, query)
        selected =
          begin
            result_value.nil? ? "null" : JSON.pretty_generate(result_value)
          rescue StandardError
            result_value.to_s
          end
      elsif !offset.nil? || !limit.nil?
        start_line = [offset || 1, 1].max
        if start_line > total_lines
          __omp_emit_status("output", "id" => output_id, "error" => "Offset #{start_line} beyond end (#{total_lines} lines)")
          raise "Offset #{start_line} is beyond end of output (#{total_lines} lines) for #{output_id}"
        end
        effective_limit = limit || (total_lines - start_line + 1)
        end_line = [total_lines, start_line + effective_limit - 1].min
        selected = raw_lines[(start_line - 1)...end_line].join("\n")
        range_info = { "start_line" => start_line, "end_line" => end_line, "total_lines" => total_lines }
      end

      selected = selected.gsub(/\e\[[0-9;]*m/, "") if format == "stripped"

      if format == "json"
        entry = {
          "id" => output_id,
          "path" => path,
          "line_count" => query ? selected.split("\n").length : total_lines,
          "char_count" => query ? selected.length : raw.length,
          "content" => selected,
        }
        entry["range"] = range_info if range_info
        entry["query"] = query if query
        results << entry
      else
        results << { "id" => output_id, "content" => selected }
      end
    end

    unless not_found.empty?
      available = Dir.glob(File.join(artifacts_dir, "*.md")).map { |f| File.basename(f, ".md") }.sort
      msg = "Output not found: #{not_found.join(", ")}"
      unless available.empty?
        msg += "\n\nAvailable outputs: #{available.first(20).join(", ")}"
        msg += " (and #{available.length - 20} more)" if available.length > 20
      end
      __omp_emit_status("output", "not_found" => not_found, "available_count" => available.length)
      raise msg
    end

    if ids.length == 1
      if format == "json"
        __omp_emit_status("output", "id" => ids[0], "chars" => results[0]["char_count"])
        return results[0]
      end
      __omp_emit_status("output", "id" => ids[0], "chars" => results[0]["content"].length)
      return results[0]["content"]
    end

    if format == "json"
      __omp_emit_status("output", "count" => results.length, "total_chars" => results.sum { |r| r["char_count"] })
      return results
    end
    combined = results.map { |r| { "id" => r["id"], "content" => r["content"] } }
    __omp_emit_status("output", "count" => combined.length, "total_chars" => combined.sum { |r| r["content"].length })
    combined
  end

  # -------------------------------------------------------------------------
  # Host tool bridge (loopback HTTP) — `tool.<name>(args)`, completion, agent.
  # -------------------------------------------------------------------------

  module OmpBridge
    INTENT_FIELD = "i"

    module_function

    def proxy_env
      base = ENV["PI_TOOL_BRIDGE_URL"]
      token = ENV["PI_TOOL_BRIDGE_TOKEN"]
      session = ENV["PI_TOOL_BRIDGE_SESSION"]
      if base.nil? || base.empty? || token.nil? || token.empty? || session.nil? || session.empty?
        raise "tool bridge is unavailable in this kernel"
      end
      [base.sub(%r{/+\z}, ""), token, session]
    end

    def call(name, args)
      require "net/http"
      require "uri"
      base, token, session = proxy_env
      uri = URI("#{base}/v1/tool")
      payload = JSON.generate("session" => session, "run" => $__omp_current_rid, "name" => name, "args" => args)
      http = Net::HTTP.new(uri.hostname, uri.port)
      http.open_timeout = 10
      http.read_timeout = 7 * 24 * 3600
      req = Net::HTTP::Post.new(uri)
      req["Content-Type"] = "application/json"
      req["Authorization"] = "Bearer #{token}"
      req.body = payload
      resp = http.request(req)
      data =
        begin
          JSON.parse(resp.body.to_s)
        rescue JSON::ParserError
          raise "bridge call #{name.inspect}: non-JSON response: #{resp.body.to_s[0, 200].inspect}"
        end
      unless data.is_a?(Hash) && data["ok"]
        raise((data.is_a?(Hash) ? data["error"] : nil) || "bridge call #{name.inspect} failed")
      end
      data["value"]
    end

    def stringify_keys(hash)
      out = {}
      hash.each { |k, v| out[k.to_s] = v }
      out
    end

    def tool_call(name, positional, kwargs)
      merged =
        if positional.nil?
          {}
        elsif positional.is_a?(Hash)
          stringify_keys(positional)
        else
          raise ArgumentError, "tool.#{name}(...) expects a Hash of arguments (got #{positional.class})"
        end
      merged.merge!(stringify_keys(kwargs)) if kwargs && !kwargs.empty?
      merged[INTENT_FIELD] = "rb prelude" unless merged.key?(INTENT_FIELD)
      call(name, merged)
    end
  end

  # `tool[:name]` form — a reusable one-tool callable.
  class OmpToolCallable
    def initialize(name)
      @name = name
    end

    def call(args = nil, **kwargs)
      OmpBridge.tool_call(@name, args, kwargs)
    end

    def to_proc
      method(:call).to_proc
    end

    def inspect
      "#<tool.#{@name}>"
    end
  end

  # `tool.<name>(args)` proxy. BasicObject so helper methods defined on Object
  # (read/write/…) never shadow a tool name — every call routes to the bridge.
  class OmpToolProxy < BasicObject
    def method_missing(name, args = nil, **kwargs)
      ::OmpBridge.tool_call(name.to_s, args, kwargs)
    end

    def [](name)
      ::OmpToolCallable.new(name.to_s)
    end

    def respond_to_missing?(_name, _include_private = false)
      true
    end

    def inspect
      session = ::ENV["PI_TOOL_BRIDGE_SESSION"]
      session ? "#<tool proxy session=#{session}>" : "#<tool proxy unavailable>"
    end
  end

  def tool
    $__omp_tool_proxy ||= OmpToolProxy.new
  end

  def completion(prompt, model: "default", system: nil, schema: nil)
    args = { "prompt" => prompt, "model" => model }
    args["system"] = system unless system.nil?
    args["schema"] = schema unless schema.nil?
    res = OmpBridge.call("__completion__", args)
    text = res.is_a?(Hash) ? res["text"] : res
    schema.nil? ? text : JSON.parse(text)
  end

  def agent(prompt, agent: "task", model: nil, label: nil, schema: nil, isolated: nil, apply: nil, merge: nil, handle: false)
    args = { "prompt" => prompt }
    args["agent"] = agent unless agent.nil?
    args["model"] = model unless model.nil?
    args["label"] = label unless label.nil?
    args["schema"] = schema unless schema.nil?
    # Isolation knobs mirror the `task` tool: strict opt-in via `isolated`,
    # with `apply`/`merge` controlling the post-run patch/branch merge.
    args["isolated"] = !!isolated unless isolated.nil?
    args["apply"] = !!apply unless apply.nil?
    args["merge"] = !!merge unless merge.nil?
    # Tell the bridge a handle is wanted so it preserves the backing artifacts.
    args["handle"] = true if handle
    res = OmpBridge.call("__agent__", args)
    text = res.is_a?(Hash) ? res["text"] : res
    parsed = schema.nil? ? text : JSON.parse(text)
    return parsed unless handle
    details = res.is_a?(Hash) ? res["details"] : nil
    if !details.is_a?(Hash) || details["id"].nil?
      return { "text" => text, "output" => text, "handle" => nil, "id" => nil, "agent" => nil }
    end
    node = {
      "text" => text,
      "output" => text,
      "handle" => "agent://#{details["id"]}",
      "id" => details["id"],
      "agent" => details["agent"],
    }
    node["data"] = parsed unless schema.nil?
    {
      "isolated" => "isolated",
      "patchPath" => "patch_path",
      "branchName" => "branch_name",
      "nestedPatches" => "nested_patches",
      "changesApplied" => "changes_applied",
      "isolationSummary" => "isolation_summary",
    }.each do |src_key, dst_key|
      node[dst_key] = details[src_key] if details.key?(src_key)
    end
    node
  end

  # -------------------------------------------------------------------------
  # Concurrency: parallel / pipeline over a bounded pool (task.maxConcurrency).
  # -------------------------------------------------------------------------

  def __omp_concurrency_limit
    snap = (OmpBridge.call("__concurrency__", {}) rescue nil) || {}
    n = (snap["limit"] || 0).to_i
    n > 0 ? n : 0
  rescue StandardError
    0
  end

  def __omp_pool_map(items)
    arr = items.to_a
    return [] if arr.empty?
    limit = __omp_concurrency_limit
    workers = limit > 0 ? [limit, arr.length].min : arr.length
    results = Array.new(arr.length)
    errors = {}
    emut = Mutex.new
    queue = Queue.new
    arr.each_index { |i| queue << i }
    threads = workers.times.map do
      Thread.new do
        loop do
          idx =
            begin
              queue.pop(true)
            rescue ThreadError
              break
            end
          begin
            results[idx] = yield(arr[idx])
          rescue Exception => e # rubocop:disable Lint/RescueException
            emut.synchronize { errors[idx] = e }
          end
        end
      end
    end
    begin
      threads.each(&:join)
    rescue Exception # rubocop:disable Lint/RescueException
      threads.each { |t| (t.kill rescue nil) }
      raise
    end
    raise errors[errors.keys.min] unless errors.empty?
    results
  end

  def parallel(thunks)
    list = thunks.to_a
    list.each do |t|
      raise TypeError, "parallel() expects an iterable of zero-arg callables" unless t.respond_to?(:call)
    end
    __omp_pool_map(list) { |t| t.call }
  end

  def pipeline(items, *stages)
    current = items.to_a
    stages.each do |stage|
      raise TypeError, "pipeline() stages must be callables" unless stage.respond_to?(:call)
      current = __omp_pool_map(current) { |item| stage.call(item) }
    end
    current
  end

  # -------------------------------------------------------------------------
  # Progress + budget
  # -------------------------------------------------------------------------

  def log(message)
    __omp_emit_status("log", "message" => message.to_s)
    nil
  end

  def phase(title)
    $__omp_current_phase = title.to_s
    __omp_emit_status("phase", "title" => title.to_s)
    nil
  end

  # Live view of the host Goal Mode token budget via the host bridge.
  class OmpBudget
    def total
      snap = (OmpBridge.call("__budget__", {}) || {})
      snap["total"]
    end

    def hard
      snap = (OmpBridge.call("__budget__", {}) || {})
      snap["hard"] ? true : false
    end

    def spent
      snap = (OmpBridge.call("__budget__", {}) || {})
      (snap["spent"] || 0).to_i
    end

    def remaining
      snap = (OmpBridge.call("__budget__", {}) || {})
      total = snap["total"]
      return Float::INFINITY if total.nil?
      [0, total - (snap["spent"] || 0).to_i].max
    end

    def inspect
      snap = ((OmpBridge.call("__budget__", {}) rescue nil) || {})
      "#<budget total=#{snap["total"].inspect} spent=#{snap["spent"].inspect}>"
    rescue StandardError
      "#<budget unavailable>"
    end
  end

  def budget
    $__omp_budget ||= OmpBudget.new
  end
end
