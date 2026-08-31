//! Container and cloud command output filters.

use std::fmt::Write as _;

use serde_json::Value;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"ps"
				| "images"
				| "logs" | "compose"
				| "build"
				| "pull" | "push"
				| "get" | "describe"
				| "status"
				| "list" | "ls"
				| "install"
				| "upgrade"
				| "template"
				| "lint" | "apply"
				| "delete"
				| "rollout"
				| "scale"
				| "create"
				| "wait" | "label"
				| "annotate"
				| "up" | "down"
				| "start"
				| "stop" | "restart"
				| "rm"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"docker" => filter_docker(ctx, &cleaned, exit_code),
		"kubectl" => filter_kubectl(ctx, &cleaned, exit_code),
		"helm" => filter_helm(ctx, &cleaned, exit_code),
		_ => head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn filter_docker(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if is_log_command(ctx) {
		return filter_docker_logs(input);
	}
	if exit_code != 0 {
		return input.to_string();
	}
	if is_docker_listing_command(ctx) {
		return if is_table_command(ctx) {
			compact_table(input, 12)
		} else {
			input.to_string()
		};
	}
	// start/stop/restart/rm output is container names or confirmation messages;
	// compact_build_or_progress would strip legitimate lines that happen to
	// contain progress substrings (e.g. a container named "my-Downloading-app").
	if is_docker_lifecycle_command(ctx) {
		return head_tail_dedup(input);
	}
	// docker-compose up / docker compose up (attached mode) streams container
	// logs, not build progress.  Lines like "Downloading", "Waiting",
	// "Extracting" that appear here are real application log lines, not
	// layer-pull status noise.  Route through the log filter so they are
	// preserved.
	//
	// Two detection paths:
	//   • legacy `docker-compose up` — detect.rs normalises the binary name to
	//     "docker" and sets subcommand="up" directly.
	//   • Compose v2 `docker compose up` — subcommand="compose", action found
	//     by scanning past compose global options (same pattern as the listing
	//     and lifecycle helpers).
	if is_compose_up_command(ctx) {
		return filter_docker_logs(input);
	}
	compact_build_or_progress(input)
}

fn filter_kubectl(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 && ctx.subcommand != Some("logs") {
		return input.to_string();
	}
	match ctx.subcommand {
		Some("logs") => filter_logs(input),
		Some("get") => {
			// Explicit JSON/YAML output — passthrough, never compact to table
			if is_explicit_kubectl_json_yaml(ctx.command) {
				return input.to_string();
			}
			if let Some(compacted) = try_compact_kubectl_json(input) {
				return compacted;
			}
			// `-o yaml` or single-object `-o json` from content (already
			// caught above by flag check, but handle content-detected too).
			if is_structured_kubectl_output(input) {
				return primitives::head_tail_lines(input, 80, 40);
			}
			// Non-table output formats produce listings, not tables
			if is_kubectl_non_table_format(ctx.command) {
				return primitives::head_tail_lines(input, 80, 40);
			}
			compact_table(input, 20)
		},
		Some("describe") => {
			primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
		},
		Some("apply" | "delete" | "rollout" | "scale" | "create" | "wait" | "label" | "annotate") => {
			head_tail_dedup(input)
		},
		_ => compact_build_or_progress(input),
	}
}

// ── kubectl JSON compaction ──────────────────────────────────────────────────

/// Returns true when the `kubectl get` output is structured JSON or YAML
/// (i.e. `-o json` single-object or `-o yaml`) rather than a tabular listing.
/// Used to avoid rewriting manifests as a fake row-count table.
fn is_structured_kubectl_output(input: &str) -> bool {
	let t = input.trim_start();
	// Single-object -o json (starts with '{' but is not a List handled above)
	// or -o yaml (starts with "apiVersion:" or "kind:").
	t.starts_with('{') || t.starts_with("apiVersion:") || t.starts_with("kind:")
}

/// Whether `kubectl get` was invoked with explicit `-o json` or `-o yaml`.
///
/// Handles all three kubectl `-o` forms:
///   `-o json`      (space-separated)
///   `-o=json`      (attached with `=`)
///   `-ojson`       (fully attached, no separator — common CLI shorthand)
fn is_explicit_kubectl_json_yaml(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(tok) = tokens.next() {
		if (tok == "-o" || tok == "--output")
			&& let Some(fmt) = tokens.next()
		{
			let base = fmt.split('=').next().unwrap_or(fmt);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
		if let Some(val) = tok
			.strip_prefix("-o=")
			.or_else(|| tok.strip_prefix("--output="))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
		// Fully-attached form: `-ojson`, `-oyaml`, `-ojsonpath=...`, etc.
		if let Some(val) = tok
			.strip_prefix("-o")
			.filter(|v| !v.is_empty() && !v.starts_with('='))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(base, "json" | "yaml") {
				return true;
			}
		}
	}
	false
}

/// Whether `kubectl get` was invoked with a non-table output format.
/// These formats (`-o name`, `-o jsonpath/...`, `-o go-template/...`,
/// `-o template/...`, `-o custom-columns/...`, `--no-headers`) produce
/// listings or single values, not tables — `compact_table` would treat
/// the first entry as a header and corrupt the requested format.
///
/// Handles all three kubectl `-o` forms:
///   `-o name`      (space-separated)
///   `-o=name`      (attached with `=`)
///   `-oname`       (fully attached, no separator — common CLI shorthand)
fn is_kubectl_non_table_format(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(tok) = tokens.next() {
		if (tok == "-o" || tok == "--output")
			&& let Some(fmt) = tokens.next()
		{
			let base = fmt.split('=').next().unwrap_or(fmt);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		if let Some(val) = tok
			.strip_prefix("-o=")
			.or_else(|| tok.strip_prefix("--output="))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		// Fully-attached form: `-oname`, `-ojsonpath=...`, `-ogo-template=...`, etc.
		if let Some(val) = tok
			.strip_prefix("-o")
			.filter(|v| !v.is_empty() && !v.starts_with('='))
		{
			let base = val.split('=').next().unwrap_or(val);
			if matches!(
				base,
				"name"
					| "jsonpath"
					| "go-template"
					| "go-template-file"
					| "template"
					| "templatefile"
					| "custom-columns"
					| "custom-columns-file"
			) {
				return true;
			}
		}
		if tok == "--no-headers" {
			return true;
		}
	}
	false
}

/// Try to parse kubectl `get -o json` output and produce a compact table.
/// Returns None if input is not recognized JSON or if schema is unexpected.
fn try_compact_kubectl_json(input: &str) -> Option<String> {
	let trimmed = input.trim();
	if !trimmed.starts_with('{') {
		return None;
	}
	let root: Value = serde_json::from_str(trimmed).ok()?;

	// kubectl list JSON: {"kind":"List","items":[...]}
	if root.get("kind")?.as_str()? != "List" {
		return None;
	}
	let items = root.get("items")?.as_array()?;
	if items.is_empty() {
		return None;
	}

	// Determine resource kind from first item
	let first = &items[0];
	let kind = first.get("kind")?.as_str()?;

	match kind {
		"Pod" => Some(compact_kubectl_pods(items)),
		"Service" => Some(compact_kubectl_services(items)),
		_ => None,
	}
}

fn compact_kubectl_pods(items: &[Value]) -> String {
	let mut out = String::from("NAME\tREADY\tSTATUS\tRESTARTS\tAGE\tIP\tNODE\n");
	let mut count = 0usize;
	for item in items {
		let meta = item.get("metadata").unwrap_or(&Value::Null);
		let spec = item.get("spec").unwrap_or(&Value::Null);
		let status = item.get("status").unwrap_or(&Value::Null);

		let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("?");
		let namespace = meta
			.get("namespace")
			.and_then(|v| v.as_str())
			.unwrap_or("default");
		let phase = status.get("phase").and_then(|v| v.as_str()).unwrap_or("?");
		let pod_ip = status
			.get("podIP")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");
		let node = spec
			.get("nodeName")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// Compute READY and RESTARTS from containerStatuses
		let (ready, total, restarts) = compute_pod_container_stats(status);

		let start_time = status
			.get("startTime")
			.and_then(|v| v.as_str())
			.unwrap_or("");
		// Simple age extraction (just show startTime if available)
		let age = start_time;

		let display = if namespace == "default" {
			name.to_string()
		} else {
			format!("{namespace}/{name}")
		};

		let _ =
			writeln!(out, "{display}\t{ready}/{total}\t{phase}\t{restarts}\t{age}\t{pod_ip}\t{node}");
		count += 1;
	}
	out.push('\n');
	let _ = writeln!(out, "{count} pod(s)");
	out
}

fn compute_pod_container_stats(status: &Value) -> (usize, usize, i32) {
	let Some(container_statuses) = status.get("containerStatuses").and_then(|v| v.as_array()) else {
		return (0, 0, 0);
	};
	let total = container_statuses.len();
	let mut ready = 0usize;
	let mut restarts = 0i32;
	for cs in container_statuses {
		if cs
			.get("ready")
			.and_then(serde_json::Value::as_bool)
			.unwrap_or(false)
		{
			ready += 1;
		}
		restarts += cs
			.get("restartCount")
			.and_then(serde_json::Value::as_i64)
			.unwrap_or(0) as i32;
	}
	(ready, total, restarts)
}

fn compact_kubectl_services(items: &[Value]) -> String {
	let mut out = String::from("NAME\tTYPE\tCLUSTER-IP\tEXTERNAL-IP\tPORT(S)\n");
	let mut count = 0usize;
	for item in items {
		let meta = item.get("metadata").unwrap_or(&Value::Null);
		let spec = item.get("spec").unwrap_or(&Value::Null);

		let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("?");
		let namespace = meta
			.get("namespace")
			.and_then(|v| v.as_str())
			.unwrap_or("default");
		let svc_type = spec
			.get("type")
			.and_then(|v| v.as_str())
			.unwrap_or("ClusterIP");
		let cluster_ip = spec
			.get("clusterIP")
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// External IP from loadBalancer status
		let external_ip = item
			.get("status")
			.and_then(|s| s.get("loadBalancer"))
			.and_then(|lb| lb.get("ingress"))
			.and_then(|ing| ing.as_array())
			.and_then(|ingress| ingress.first())
			.and_then(|i| i.get("ip").or_else(|| i.get("hostname")))
			.and_then(|v| v.as_str())
			.unwrap_or("<none>");

		// Ports
		let ports = format_k8s_ports(spec.get("ports").and_then(|v| v.as_array()));

		let display = if namespace == "default" {
			name.to_string()
		} else {
			format!("{namespace}/{name}")
		};

		let _ = writeln!(out, "{display}\t{svc_type}\t{cluster_ip}\t{external_ip}\t{ports}");
		count += 1;
	}
	out.push('\n');
	let _ = writeln!(out, "{count} service(s)");
	out
}

fn format_k8s_ports(ports: Option<&Vec<Value>>) -> String {
	let Some(ports) = ports else {
		return "<none>".to_string();
	};
	if ports.is_empty() {
		return "<none>".to_string();
	}
	let parts: Vec<String> = ports
		.iter()
		.map(|p| {
			let port = p
				.get("port")
				.and_then(serde_json::Value::as_i64)
				.map_or_else(|| "?".to_string(), |v| v.to_string());
			let proto = p.get("protocol").and_then(|v| v.as_str()).unwrap_or("TCP");
			let node_port = p.get("nodePort").and_then(serde_json::Value::as_i64);
			let target_port = p.get("targetPort");
			let target = target_port
				.and_then(serde_json::Value::as_i64)
				.map(|v| v.to_string())
				.or_else(|| {
					target_port
						.and_then(|v| v.as_str())
						.map(std::string::ToString::to_string)
				});
			match (target, node_port) {
				(Some(t), Some(np)) => format!("{port}/{t}:{np}->{port}/{proto}"),
				(Some(t), None) => format!("{port}/{t}:{port}/{proto}"),
				(None, Some(np)) => format!("{np}:{port}->{port}/{proto}"),
				(None, None) => format!("{port}/{proto}"),
			}
		})
		.collect();
	parts.join(",")
}

fn filter_helm(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return input.to_string();
	}
	let cleaned = strip_helm_noise(input);
	match ctx.subcommand {
		Some("list" | "ls" | "status") => compact_table(&cleaned, 20),
		Some("install" | "upgrade" | "lint") => compact_build_or_progress(&cleaned),
		Some("template") => input.to_string(),
		_ => head_tail_dedup(&cleaned),
	}
}

fn strip_helm_noise(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_glog_prefix(trimmed) {
			continue;
		}
		if trimmed.starts_with("WARNING: Kubernetes configuration file is") {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_glog_prefix(line: &str) -> bool {
	let bytes = line.as_bytes();
	if bytes.len() < 6
		|| bytes[0] != b'W'
		|| bytes[5] != b' '
		|| !bytes[1..5].iter().all(u8::is_ascii_digit)
	{
		return false;
	}
	// Validate month (01-12) and day (01-31) to avoid stripping legitimate
	// output that happens to start with W + 4 digits + space.
	let month = (bytes[1] - b'0') * 10 + (bytes[2] - b'0');
	let day = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
	if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
		return false;
	}
	// Require a time stamp (hh:mm...) after the space to distinguish real
	// glog lines from space-separated table output where a release name
	// happens to match W + MMDD + space.
	if bytes.len() < 11 {
		return false;
	}
	if !bytes[6].is_ascii_digit() || !bytes[7].is_ascii_digit() {
		return false;
	}
	if bytes[8] != b':' {
		return false;
	}
	if !bytes[9].is_ascii_digit() || !bytes[10].is_ascii_digit() {
		return false;
	}
	true
}

/// Returns `true` when `tok` is a known docker-compose option that consumes
/// the next token as its value (i.e. is space-separated, not `--flag=value`).
fn compose_option_consumes_next(tok: &str) -> bool {
	matches!(
		tok,
		"--ansi"
			| "--env-file"
			| "--file"
			| "-f" | "--parallel"
			| "--profile"
			| "--progress"
			| "--project-directory"
			| "--project-name"
			| "-p" | "--workdir"
			| "-w"
	)
}

fn is_log_command(ctx: &MinimizerCtx<'_>) -> bool {
	if ctx.subcommand == Some("logs") {
		return true;
	}
	// `docker compose logs <service>` — the action is `logs` but subcommand
	// resolves to `compose`.  Find the first non-option token after `compose`
	// (the action) and check only that.  Scanning further tokens would
	// misclassify service names or command args: for example,
	// `docker compose exec logs cat file` has action `exec` and service name
	// `logs`, and must NOT be routed through log dedup/truncation.
	if ctx.subcommand == Some("compose") {
		let mut tokens = ctx.command.split_whitespace();
		while let Some(tok) = tokens.next() {
			if tok == "compose" {
				loop {
					match tokens.next() {
						None => return false,
						Some(tok)
							if tok.starts_with('-')
								&& !tok.contains('=')
								&& compose_option_consumes_next(tok) =>
						{
							tokens.next(); // skip value
						},
						Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
						Some(tok) => return tok == "logs",
					}
				}
			}
		}
	}
	false
}

fn is_table_command(ctx: &MinimizerCtx<'_>) -> bool {
	// Match `docker ps`, `docker images` (subcommand is argv[1])
	// or `docker compose ps`, `docker compose images` (subcommand is "compose",
	// action is argv[2]). Machine-readable listing modes (`-q`/`--quiet`, or
	// `--format` without Docker's `table` directive) must stay opaque: callers
	// commonly pipe these IDs/templates into other commands, and `compact_table`
	// would treat the first ID as a header and drop middle rows.
	if !is_docker_listing_command(ctx) {
		return false;
	}
	docker_listing_requests_table(ctx.command)
}
fn is_docker_listing_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("ps" | "images"))
		|| ctx.subcommand == Some("compose") && is_compose_listing_action(ctx.command)
}

fn is_compose_listing_action(command: &str) -> bool {
	// Advance past the `compose` token, then find the first non-option token
	// (the action).  Only that token decides whether this is a listing command.
	// Scanning further tokens would misclassify service names: for example,
	// `docker compose up ps` has action `up` and service name `ps`, and must
	// NOT be routed through compact_table.
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return matches!(tok, "ps" | "images"),
		}
	}
}

fn is_docker_lifecycle_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("start" | "stop" | "restart" | "rm"))
		|| ctx.subcommand == Some("compose") && is_compose_lifecycle_action(ctx.command)
}

fn is_compose_lifecycle_action(command: &str) -> bool {
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return matches!(tok, "start" | "stop" | "restart" | "rm"),
		}
	}
}

/// Returns `true` when the command is an attached `docker compose up` or
/// legacy `docker-compose up` that streams container log output.
///
/// Two forms are handled:
///   • `docker-compose up` — detect.rs normalises the binary to "docker" and
///     sets `subcommand="up"` directly; the original command still contains
///     "compose" so we can tell it apart from plain `docker build`.
///   • `docker compose up` — `subcommand="compose"`, action resolved by
///     scanning past compose global options (same logic as the listing /
///     lifecycle helpers).
fn is_compose_up_command(ctx: &MinimizerCtx<'_>) -> bool {
	// Legacy docker-compose: subcommand is already the action.
	if ctx.subcommand == Some("up") && ctx.command.contains("compose") {
		return true;
	}
	// Compose v2: subcommand is "compose", scan for first non-option action.
	if ctx.subcommand == Some("compose") {
		return is_compose_up_action(ctx.command);
	}
	false
}

fn is_compose_up_action(command: &str) -> bool {
	let mut tokens = command
		.split_whitespace()
		.skip_while(|token| *token != "compose");
	if tokens.next() != Some("compose") {
		return false;
	}
	loop {
		match tokens.next() {
			None => return false,
			Some(tok)
				if tok.starts_with('-') && !tok.contains('=') && compose_option_consumes_next(tok) =>
			{
				tokens.next(); // skip value
			},
			Some(tok) if tok.starts_with('-') => {}, // skip boolean flag
			Some(tok) => return tok == "up",
		}
	}
}

fn docker_listing_requests_table(command: &str) -> bool {
	let mut tokens = command.split_whitespace();
	while let Some(token) = tokens.next() {
		if matches!(token, "-q" | "--quiet") {
			return false;
		}
		if token == "--format" {
			return tokens.next().is_some_and(docker_format_requests_table);
		}
		if let Some(format) = token.strip_prefix("--format=") {
			return docker_format_requests_table(format);
		}
	}
	true
}

fn docker_format_requests_table(format: &str) -> bool {
	let format = format.trim_matches(|c| matches!(c, '"' | '\''));
	format == "table" || format.starts_with("table ")
}

fn filter_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	crate::minimizer::filters::system::compact_log_lines(
		&without_empty_runs,
		120,
		80,
		crate::minimizer::filters::system::normalize_log_line,
	)
}

fn filter_docker_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	crate::minimizer::filters::system::compact_log_lines(&without_empty_runs, 120, 80, log_dedup_key)
}

fn log_dedup_key(line: &str) -> String {
	if let Some((service, message)) = line.split_once('|') {
		let service = service.trim();
		if is_compose_log_service(service) {
			let message = message.trim_start();
			let normalized = crate::minimizer::filters::system::normalize_log_line(message);
			return format!("{service}|{normalized}");
		}
	}
	crate::minimizer::filters::system::normalize_log_line(line)
}

fn is_compose_log_service(value: &str) -> bool {
	!value.is_empty()
		&& !matches!(value, "debug" | "error" | "fatal" | "info" | "trace" | "warn" | "warning")
		&& value.bytes().any(|byte| byte.is_ascii_lowercase())
		&& value.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
		})
}

fn compact_table(input: &str, visible_rows: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= visible_rows + 1 {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(header) = lines.first() {
		out.push_str(header.trim_end());
		out.push('\n');
	}
	out.push_str(&(lines.len() - 1).to_string());
	out.push_str(" rows\n");
	for line in lines.iter().skip(1).take(visible_rows) {
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out.push_str("[…");
	out.push_str(&(lines.len() - 1 - visible_rows).to_string());
	out.push_str(" rows elided…]\n");
	out
}

fn compact_build_or_progress(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_line(trimmed) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	head_tail_dedup(&out)
}

fn is_progress_line(line: &str) -> bool {
	line.starts_with("=> ")
		|| line.starts_with('#') && line.contains("DONE")
		|| line.starts_with('#') && line.contains("CACHED")
		|| line.starts_with('#') && line.contains("transferring ")
		|| line.starts_with('#') && line.contains("extracting ")
		|| line.contains("Pulling fs layer")
		|| line.contains("Pull complete")
		|| line.contains("Download complete")
		|| line.contains("Downloading")
		|| line.contains("Extracting")
		|| line.contains("Waiting")
		|| line.contains("Verifying Checksum")
		|| line.starts_with("Attaching to ")
		|| line.starts_with("Gracefully stopping")
		|| is_compose_container_status_line(line)
}

fn is_compose_container_status_line(line: &str) -> bool {
	let line = line.trim_start();
	line.starts_with("Container ")
		&& ["Creating", "Created", "Starting", "Started", "Waiting", "Healthy", "Running"]
			.iter()
			.any(|status| line.contains(status))
}

fn drop_repeated_blank_lines(input: &str) -> String {
	let mut out = String::new();
	let mut saw_blank = false;
	for line in input.lines() {
		if line.trim().is_empty() {
			if !saw_blank {
				out.push('\n');
			}
			saw_blank = true;
			continue;
		}
		saw_blank = false;
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn head_tail_dedup(input: &str) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn dedups_repeated_log_lines_before_truncation() {
		let input = "api | ready\napi | ready\napi | ready\napi | done\n";
		let out = filter_docker_logs(input);
		assert!(out.contains("api | ready (×3)"));
		assert!(out.contains("api | done"));
	}

	#[test]
	fn dedups_compose_service_prefixed_log_messages() {
		let input = "api-1  | ready\napi-2  | ready\napi | ready\nworker | busy\n";
		let out = filter_docker_logs(input);
		// Different services with the same message must NOT be collapsed together.
		assert!(out.contains("api-1  | ready"), "distinct service must be preserved: {out}");
		assert!(out.contains("api-2  | ready"), "distinct service must be preserved: {out}");
		assert!(out.contains("api | ready"), "distinct service must be preserved: {out}");
		assert!(out.contains("worker | busy"), "distinct service must be preserved: {out}");
	}

	#[test]
	fn docker_compose_logs_uses_log_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let compose_ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose logs api",
			config:     &cfg,
		};
		let input = "api-1  | ready\napi-2  | ready\napi | ready\n";
		let out = filter(&compose_ctx, input, 0).text;
		// Per-service dedup: same message from different services stays distinct.
		assert!(out.contains("api-1  | ready"), "distinct service line must be preserved: {out}");
		assert!(out.contains("api-2  | ready"), "distinct service line must be preserved: {out}");
		assert!(out.contains("api | ready"), "distinct service line must be preserved: {out}");
	}

	#[test]
	fn docker_compose_logs_skips_option_values() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose --profile ps logs api",
			config:     &cfg,
		};
		assert!(is_log_command(&ctx));
	}

	#[test]
	fn compose_exec_with_service_named_logs_is_not_log_command() {
		// `docker compose exec logs cat file` — action is `exec`, `logs` is a
		// service name.  Must NOT be routed through log dedup/truncation.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for cmd in &[
			"docker compose exec logs cat /etc/hosts",
			"docker compose run logs bash",
			"docker compose restart logs",
		] {
			let ctx = MinimizerCtx {
				program:    "docker",
				subcommand: Some("compose"),
				command:    cmd,
				config:     &cfg,
			};
			assert!(!is_log_command(&ctx), "`{cmd}` must not be classified as a log command");
		}
	}

	#[test]
	fn docker_logs_preserves_short_context_around_warning() {
		let input = "starting\nWARN retrying\nready\n";
		let out = filter_docker_logs(input);
		assert_eq!(out, input);
	}

	#[test]
	fn docker_compose_ps_uses_table_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let compose_ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose ps",
			config:     &cfg,
		};
		let mut input = String::from("NAME IMAGE COMMAND SERVICE CREATED STATUS PORTS\n");
		for idx in 0..20 {
			let _ = writeln!(input, "svc-{idx} img command api 1m running 8080/tcp");
		}
		let out = filter(&compose_ctx, &input, 0).text;
		assert!(out.contains("20 rows"));
		assert!(out.contains("svc-0"));
		assert!(out.contains("[…8 rows elided…]"));
	}

	#[test]
	fn docker_compose_ps_skips_option_values() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose --profile logs ps",
			config:     &cfg,
		};
		assert!(is_table_command(&ctx));
	}

	#[test]
	fn compose_up_with_service_named_ps_is_not_table_command() {
		// `docker compose up ps` — action is `up`, `ps` is a service name.
		// Must NOT be routed through compact_table.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for cmd in &["docker compose up ps", "docker compose up images", "docker compose restart ps"]
		{
			let ctx = MinimizerCtx {
				program:    "docker",
				subcommand: Some("compose"),
				command:    cmd,
				config:     &cfg,
			};
			assert!(!is_table_command(&ctx), "`{cmd}` must not be classified as a table command");
		}
	}

	#[test]
	fn strips_compose_up_progress_lines() {
		let input = "Attaching to api-1, worker-1\n Container api-1  Creating\n Container api-1  \
		             Created\napi-1  | ready\n";
		let out = compact_build_or_progress(input);
		assert!(!out.contains("Attaching to"));
		assert!(!out.contains("Container api-1  Creating"));
		assert!(out.contains("api-1  | ready"));
	}

	#[test]
	fn strips_compose_build_progress_lines() {
		let input = "#1 [internal] load build definition from Dockerfile\n#1 transferring \
		             dockerfile: 512B done\n#2 [1/2] FROM docker.io/library/node:22\n#2 CACHED\n#3 \
		             exporting to image\n#3 DONE 0.1s\nnaming to docker.io/library/app:latest\n";
		let out = compact_build_or_progress(input);
		assert!(!out.contains("transferring dockerfile"));
		assert!(!out.contains("#2 CACHED"));
		assert!(!out.contains("#3 DONE"));
		assert!(out.contains("naming to docker.io/library/app:latest"));
	}

	#[test]
	fn strips_compose_pull_progress_lines() {
		let input = "app Pulling fs layer\napp Downloading\napp Verifying Checksum\napp Download \
		             complete\napp Extracting\napp Pull complete\nStatus: Downloaded newer image \
		             for docker.io/library/app:latest\n";
		let out = compact_build_or_progress(input);
		assert!(!out.contains("Pulling fs layer"));
		assert!(!out.contains("Pull complete"));
		assert!(out.contains("Status: Downloaded newer image for docker.io/library/app:latest"));
	}

	#[test]
	fn truncates_large_logs_without_dropping_all_context() {
		let mut input = String::new();
		for i in 0..260 {
			input.push_str("api-1  | request ");
			input.push_str(&i.to_string());
			input.push_str(" complete\n");
		}
		input.push_str("api-1  | WARN cache miss\n");
		input.push_str("worker | failed to process job\n");

		let out = filter_docker_logs(&input);
		assert!(out.contains("api-1  | request 0 complete"));
		assert!(out.contains("api-1  | WARN cache miss"));
		assert!(out.contains("worker | failed to process job"));
		assert!(out.contains("elided"));
	}

	#[test]
	fn compacts_large_table_with_header_and_omission_count() {
		let mut input = String::from("ID IMAGE STATUS\n");
		for i in 0..25 {
			input.push_str(&i.to_string());
			input.push_str(" img running\n");
		}
		let out = compact_table(&input, 10);
		assert!(out.contains("25 rows"));
		assert!(out.contains("[…15 rows elided…]"));
	}

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command: program, config: cfg }
	}

	#[test]
	fn docker_ps_quiet_preserves_id_listing_verbatim() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("ps"),
			command:    "docker ps -q",
			config:     &cfg,
		};
		let mut input = String::new();
		for idx in 0..220 {
			let _ = writeln!(input, "{idx:012x}");
		}

		let out = filter(&ctx, &input, 0).text;

		assert_eq!(out, input, "docker ps -q output is machine-readable and must not be compacted");
	}

	#[test]
	fn docker_ps_format_without_table_preserves_template_output_verbatim() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("ps"),
			command:    "docker ps --format '{{.ID}}'",
			config:     &cfg,
		};
		let mut input = String::new();
		for idx in 0..220 {
			let _ = writeln!(input, "{idx:012x}");
		}

		let out = filter(&ctx, &input, 0).text;

		assert_eq!(
			out, input,
			"docker --format without the table directive is exact template output and must not be \
			 compacted",
		);
	}

	#[test]
	fn docker_images_format_table_still_compacts() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("images"),
			command:    "docker images --format 'table {{.ID}} {{.Repository}}'",
			config:     &cfg,
		};
		let mut input = String::from("ID REPOSITORY\n");
		for idx in 0..25 {
			let _ = writeln!(input, "{idx:012x} repo-{idx}");
		}

		let out = filter(&ctx, &input, 0).text;

		assert!(out.contains("25 rows"), "docker --format table output should still compact: {out}");
		assert!(
			out.contains("[…13 rows elided…]"),
			"docker --format table should keep table omission: {out}"
		);
	}

	#[test]
	fn docker_compose_ps_format_without_table_preserves_template_output_verbatim() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose ps --format '{{.ID}}'",
			config:     &cfg,
		};
		let mut input = String::new();
		for idx in 0..220 {
			let _ = writeln!(input, "{idx:012x}");
		}

		let out = filter(&ctx, &input, 0).text;

		assert_eq!(out, input, "docker compose ps formatted output must not be compacted");
	}

	#[test]
	fn failing_table_commands_preserve_full_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let docker_ctx = ctx("docker", Some("ps"), &cfg);
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		let mut input = String::from("NAME STATUS\n");
		for idx in 0..30 {
			input.push_str("resource-with-a-very-long-diagnostic-name-");
			input.push_str(&idx.to_string());
			input.push_str(" failed because the apiserver returned a detailed validation error\n");
		}
		assert_eq!(filter(&docker_ctx, &input, 1).text, input);
		assert_eq!(filter(&kubectl_ctx, &input, 1).text, input);
		assert_eq!(filter(&helm_ctx, &input, 1).text, input);
	}

	// ── kubectl JSON tests ───────────────────────────────────────────────

	#[test]
	fn compacts_kubectl_get_pods_json() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let input = r#"{
    "apiVersion": "v1",
    "items": [
        {
            "metadata": {
                "name": "nginx-pod",
                "namespace": "default"
            },
            "spec": {
                "nodeName": "node-1",
                "containers": [{"name": "nginx", "image": "nginx:latest"}]
            },
            "status": {
                "phase": "Running",
                "podIP": "10.0.0.1",
                "startTime": "2024-01-15T10:00:00Z",
                "containerStatuses": [
                    {"name": "nginx", "ready": true, "restartCount": 0}
                ]
            },
            "kind": "Pod"
        },
        {
            "metadata": {
                "name": "failing-pod",
                "namespace": "kube-system"
            },
            "spec": {
                "nodeName": "node-2",
                "containers": [
                    {"name": "app", "image": "app:v1"},
                    {"name": "sidecar", "image": "sidecar:v1"}
                ]
            },
            "status": {
                "phase": "Running",
                "podIP": "10.0.0.2",
                "startTime": "2024-01-15T09:00:00Z",
                "containerStatuses": [
                    {"name": "app", "ready": true, "restartCount": 3},
                    {"name": "sidecar", "ready": false, "restartCount": 1}
                ]
            },
            "kind": "Pod"
        }
    ],
    "kind": "List"
}"#;
		let out = filter(&kubectl_ctx, input, 0).text;
		assert!(out.contains("nginx-pod\t1/1\tRunning\t0"));
		assert!(out.contains("kube-system/failing-pod\t1/2\tRunning\t4"));
		assert!(out.contains("2 pod(s)"));
	}

	#[test]
	fn compacts_kubectl_get_services_json() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let input = r#"{
    "apiVersion": "v1",
    "items": [
        {
            "metadata": { "name": "my-svc", "namespace": "default" },
            "spec": {
                "type": "ClusterIP",
                "clusterIP": "10.0.0.10",
                "ports": [
                    {"port": 80, "targetPort": 8080, "protocol": "TCP"}
                ]
            },
            "kind": "Service"
        },
        {
            "metadata": { "name": "lb-svc", "namespace": "prod" },
            "spec": {
                "type": "LoadBalancer",
                "clusterIP": "10.0.0.20",
                "ports": [
                    {"port": 443, "targetPort": 8443, "protocol": "TCP", "nodePort": 30001}
                ]
            },
            "status": {
                "loadBalancer": {
                    "ingress": [{"ip": "203.0.113.1"}]
                }
            },
            "kind": "Service"
        }
    ],
    "kind": "List"
}"#;
		let out = filter(&kubectl_ctx, input, 0).text;
		assert!(out.contains("my-svc\tClusterIP\t10.0.0.10\t<none>\t80/8080:80/TCP"));
		assert!(
			out.contains("prod/lb-svc\tLoadBalancer\t10.0.0.20\t203.0.113.1\t443/8443:30001->443/TCP")
		);
		assert!(out.contains("2 service(s)"));
	}

	#[test]
	fn kubectl_json_parse_failure_falls_back_to_table() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let mut input = String::from("NAME STATUS\n");
		for i in 0..25 {
			let _ = writeln!(input, "pod-{i} running");
		}
		let out = filter(&kubectl_ctx, &input, 0).text;
		// Should use table compaction, not crash
		assert!(out.contains("25 rows"));
		assert!(out.contains("pod-0"));
	}

	#[test]
	fn kubectl_non_list_json_returns_unchanged() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		// Valid JSON but not a kubectl List — unrecognized
		let input = r#"{"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "single"}}"#;
		let out = filter(&kubectl_ctx, input, 0).text;
		// Falls back — table compaction would try to process this
		// The key is: doesn't crash, doesn't lose data
		assert_ne!(out, "");
	}

	#[test]
	fn failing_kubectl_get_json_preserves_error() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let input = "Error from server (Forbidden): pods is forbidden\n";
		let out = filter(&kubectl_ctx, input, 1).text;
		// Non-zero exit with non-logs → preserve verbatim
		assert_eq!(out, input);
	}

	#[test]
	fn helm_template_keeps_manifest_yaml_opaque() {
		// `helm template` renders chart manifests — arbitrary YAML, not build
		// progress. Lines like "phase: Waiting" are field values, not status
		// noise, so they must not be dropped by compact_build_or_progress.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("template"), &cfg);
		let input =
			"apiVersion: v1\nkind: ConfigMap\ndata:\n  phase: Waiting\n  action: Downloading\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert_eq!(out, input, "helm template output must be preserved verbatim");
	}

	// ── Attached -o format tests ────────────────────────────────────────────

	#[test]
	fn kubectl_get_ojson_attached_preserves_json() {
		// `-ojson` (no space, no `=`) must be treated as `-o json`.
		// A kubectl List JSON must NOT be rewritten into a table summary.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "kubectl",
			subcommand: Some("get"),
			command:    "kubectl get pods -ojson",
			config:     &cfg,
		};
		let input = r#"{"apiVersion":"v1","kind":"List","items":[{"kind":"Pod","metadata":{"name":"p","namespace":"default"},"spec":{"nodeName":"n","containers":[{"name":"c","image":"img"}]},"status":{"phase":"Running","podIP":"1.2.3.4","startTime":"2024-01-01T00:00:00Z","containerStatuses":[{"name":"c","ready":true,"restartCount":0}]}}]}"#;
		let out = filter(&ctx, input, 0).text;
		assert_eq!(out, input, "-ojson must passthrough verbatim, not be compacted to a table");
	}

	#[test]
	fn kubectl_get_oyaml_attached_preserves_yaml() {
		// `-oyaml` must be treated as `-o yaml` — passthrough, no table compaction.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "kubectl",
			subcommand: Some("get"),
			command:    "kubectl get pod my-pod -oyaml",
			config:     &cfg,
		};
		let input = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: my-pod\nspec:\n  containers: []\n";
		let out = filter(&ctx, input, 0).text;
		assert_eq!(out, input, "-oyaml must passthrough verbatim");
	}

	#[test]
	fn kubectl_get_oname_attached_skips_table_compaction() {
		// `-oname` must be treated as `-o name` — listings, not tables.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "kubectl",
			subcommand: Some("get"),
			command:    "kubectl get pods -oname",
			config:     &cfg,
		};
		// `-o name` output is one `resource/name` per line — compact_table
		// would corrupt it by treating the first line as a header.
		let input = "pod/alpha\npod/beta\npod/gamma\n";
		let out = filter(&ctx, input, 0).text;
		assert!(!out.contains("rows"), "-oname output must not be table-compacted, got: {out}");
	}

	#[test]
	fn kubectl_get_ojsonpath_attached_skips_table_compaction() {
		// `-ojsonpath=...` must be treated as non-table.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "kubectl",
			subcommand: Some("get"),
			command:    "kubectl get pods -ojsonpath={.items[*].metadata.name}",
			config:     &cfg,
		};
		let input = "alpha beta gamma\n";
		let out = filter(&ctx, input, 0).text;
		assert!(!out.contains("rows"), "-ojsonpath output must not be table-compacted, got: {out}");
	}

	#[test]
	fn kubectl_get_owide_attached_still_compacts_table() {
		// `-owide` IS a table format — it must still go through compact_table.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "kubectl",
			subcommand: Some("get"),
			command:    "kubectl get pods -owide",
			config:     &cfg,
		};
		let mut input = String::from("NAME READY STATUS RESTARTS AGE IP NODE\n");
		for i in 0..25 {
			let _ = writeln!(input, "pod-{i} 1/1 Running 0 1h 10.0.0.{i} node");
		}
		let out = filter(&ctx, input.as_str(), 0).text;
		assert!(out.contains("rows"), "-owide is a table format and must be compacted, got: {out}");
	}

	// ── Global normalized log dedup tests ───────────────────────────────

	#[test]
	fn dedups_non_consecutive_log_lines_globally() {
		let input = "ready\nstarting\nready\nstarting\nready\ndone\n";
		let out = filter_docker_logs(input);
		assert!(out.contains("ready (×3)"), "global dedup should count all occurrences: {out}");
		assert!(out.contains("starting (×2)"), "global dedup should count all occurrences: {out}");
		assert!(out.contains("done"), "global dedup should preserve unique lines: {out}");
	}

	#[test]
	fn dedups_compose_service_prefixed_lines_non_consecutive() {
		let input = "api-1  | ready\nworker | busy\napi-2  | ready\nworker | busy\n";
		let out = filter_docker_logs(input);
		assert!(
			out.contains("api-1  | ready"),
			"compose service-prefixed lines should dedup per service: {out}"
		);
		assert!(
			out.contains("api-2  | ready"),
			"compose service-prefixed lines should preserve distinct services: {out}"
		);
		assert!(
			out.contains("worker | busy (×2)"),
			"compose same-service lines should dedup globally: {out}"
		);
	}

	// ── kubectl uncovered subcommands tests ───────────────────────────────

	#[test]
	fn kubectl_apply_output_condensed() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let kubectl_ctx = ctx("kubectl", Some("apply"), &cfg);
		let mut input = String::new();
		for i in 0..250 {
			let _ = writeln!(input, "deployment.apps/app-{i} unchanged");
		}
		let out = filter(&kubectl_ctx, &input, 0).text;
		assert!(
			out.contains("ln elided…]"),
			"kubectl apply output should be head/tail condensed: {out}"
		);
	}

	// ── helm glog strip tests ───────────────────────────────────────────

	#[test]
	fn helm_list_strips_glog_warning_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		let input = "W0115 10:30:00 warning message from internal\nNAME: my-release\nLAST DEPLOYED: \
		             Mon Jan 15 10:30:00 2024\nNAMESPACE: default\nSTATUS: deployed\nREVISION: 3\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert!(!out.contains("W0115"), "glog W-prefixed lines should be stripped: {out}");
		assert!(out.contains("NAME: my-release"), "release info should be preserved: {out}");
		assert!(out.contains("STATUS: deployed"), "release info should be preserved: {out}");
	}

	#[test]
	fn helm_list_strips_kubernetes_config_warning() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		let input = "WARNING: Kubernetes configuration file is group-readable\nNAME: \
		             my-release\nSTATUS: deployed\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert!(
			!out.contains("WARNING: Kubernetes configuration file"),
			"Kubernetes config warning should be stripped: {out}"
		);
		assert!(out.contains("NAME: my-release"), "release info should be preserved: {out}");
	}

	// ── Blocking-issue regression tests ─────────────────────────────────

	#[test]
	fn docker_logs_preserves_blank_lines() {
		let input = "a\n\nb\n";
		let out = filter_docker_logs(input);
		assert_eq!(out, "a\n\nb\n", "blank lines must not be silently dropped: {out}");
	}

	#[test]
	fn docker_logs_preserves_non_consecutive_blank_lines() {
		let input = "a\n\nb\n\nc\n";
		let out = filter_docker_logs(input);
		assert_eq!(
			out, "a\n\nb\n\nc\n",
			"non-consecutive blank lines must not be globally deduplicated: {out}"
		);
	}

	#[test]
	fn docker_logs_dedups_empty_compose_messages_per_service() {
		let input = "api | \napi | \napi | \nworker | \nworker | \n";
		let out = filter_docker_logs(input);
		assert!(out.contains("api |  (×3)"), "same-service empty messages should dedup: {out}");
		assert!(out.contains("worker |  (×2)"), "same-service empty messages should dedup: {out}");
	}

	#[test]
	fn docker_start_preserves_container_names_with_progress_keywords() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for sub in &["start", "stop", "restart", "rm"] {
			let ctx = MinimizerCtx {
				program:    "docker",
				subcommand: Some(sub),
				command:    &format!("docker {sub} my-Downloading-app"),
				config:     &cfg,
			};
			let input = "my-Downloading-app\n";
			let out = filter(&ctx, input, 0).text;
			assert_eq!(
				out, input,
				"docker {sub} must not strip container names matching progress heuristics"
			);
		}
	}

	#[test]
	fn docker_compose_start_preserves_container_names_with_progress_keywords() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for action in &["start", "stop", "restart", "rm"] {
			let ctx = MinimizerCtx {
				program:    "docker",
				subcommand: Some("compose"),
				command:    &format!("docker compose {action} my-Downloading-app"),
				config:     &cfg,
			};
			let input = "my-Downloading-app\n";
			let out = filter(&ctx, input, 0).text;
			assert_eq!(
				out, input,
				"docker compose {action} must not strip container names matching progress heuristics"
			);
		}
	}

	#[test]
	fn helm_list_preserves_release_names_starting_with_w_digit() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		let input = "NAME\tNAMESPACE\nW2024-app\tdefault\nmy-app\tdefault\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert!(
			out.contains("W2024-app"),
			"release names starting with W+digits must not be stripped: {out}"
		);
		assert!(out.contains("my-app"), "other releases must be preserved: {out}");
	}

	#[test]
	fn glog_prefix_requires_trailing_space() {
		assert!(is_glog_prefix("W0115 10:30:00 warning"));
		assert!(!is_glog_prefix("W2024-app"));
		assert!(!is_glog_prefix("W123"));
		assert!(!is_glog_prefix("W12345"));
	}

	#[test]
	fn glog_prefix_rejects_invalid_month_day() {
		// W2024 has month=20 (invalid) — must not be treated as glog.
		assert!(!is_glog_prefix("W2024 default"));
		assert!(!is_glog_prefix("W0015 10:30:00 warning"));
		assert!(!is_glog_prefix("W1301 10:30:00 warning"));
		assert!(!is_glog_prefix("W1232 10:30:00 warning"));
	}

	#[test]
	fn glog_prefix_rejects_space_separated_without_time() {
		// W1231 looks like a valid glog date, but "default" is not a time stamp.
		assert!(!is_glog_prefix("W1231 default"));
		// Valid glog with time stamp must still pass.
		assert!(is_glog_prefix("W1231 10:30:00 warning"));
	}

	#[test]
	fn helm_list_preserves_release_names_starting_with_w_digit_space() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		// W2024 default looks like a glog prefix but month=20 is invalid.
		let input = "NAME\tNAMESPACE\nW2024 default\tdefault\nmy-app\tdefault\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert!(
			out.contains("W2024 default"),
			"release names like 'W2024 default' must not be stripped: {out}"
		);
		assert!(out.contains("my-app"), "other releases must be preserved: {out}");
	}

	#[test]
	fn helm_list_preserves_space_separated_valid_w_digit_release_names() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		// W1231 default has a valid month/day but lacks a time stamp, so it must
		// NOT be stripped as a glog line.
		let input = "NAME NAMESPACE\nW1231 default\nmy-app default\n";
		let out = filter(&helm_ctx, input, 0).text;
		assert!(
			out.contains("W1231 default"),
			"space-separated release name W1231 must not be stripped: {out}"
		);
		assert!(out.contains("my-app default"), "other releases must be preserved: {out}");
	}

	#[test]
	fn docker_compose_p_project_name_routes_logs() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose -p myproj logs api",
			config:     &cfg,
		};
		assert!(is_log_command(&ctx), "docker compose -p myproj logs must be a log command");
	}

	#[test]
	fn docker_compose_p_project_name_routes_ps() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose -p myproj ps",
			config:     &cfg,
		};
		assert!(
			is_table_command(&ctx),
			"docker compose -p myproj ps must be classified as a table command"
		);
	}

	#[test]
	fn docker_compose_p_project_name_routes_start() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "docker",
			subcommand: Some("compose"),
			command:    "docker compose -p myproj start api",
			config:     &cfg,
		};
		assert!(
			is_docker_lifecycle_command(&ctx),
			"docker compose -p myproj start must be classified as a lifecycle command"
		);
	}

	fn make_ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config: cfg }
	}

	// ── docker-compose up / docker compose up log preservation ──────────────

	#[test]
	fn test_compose_up_logs_preserved() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// Legacy docker-compose up: detect.rs sets subcommand="up", command retains
		// "docker-compose".
		let input = "web_1    | [2024-01-01 00:00:00] INFO Server started\ndb_1     | 2024-01-01 \
		             00:00:01 [Note] mysqld: ready for connections\n";
		let ctx = make_ctx("docker", Some("up"), "docker-compose up", &cfg);
		let out = filter(&ctx, input, 0);
		// Log output must not be stripped by the build-progress condenser.
		assert!(
			out.text.contains("Server started"),
			"compose up log lines must survive (legacy docker-compose): {}",
			out.text
		);
		assert!(
			out.text.contains("mysqld: ready for connections"),
			"compose up db log lines must survive (legacy docker-compose): {}",
			out.text
		);
	}

	#[test]
	fn test_compose_v2_up_logs_preserved() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// Compose v2: subcommand="compose", action resolved by scanning tokens.
		let input = "web_1    | [2024-01-01 00:00:00] INFO Server started\ndb_1     | 2024-01-01 \
		             00:00:01 [Note] mysqld: ready for connections\n";
		let ctx = make_ctx("docker", Some("compose"), "docker compose up", &cfg);
		let out = filter(&ctx, input, 0);
		assert!(
			out.text.contains("Server started"),
			"compose up log lines must survive (docker compose v2): {}",
			out.text
		);
	}

	#[test]
	fn test_compose_up_with_global_flags_logs_preserved() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// docker compose --progress plain up — global option before action.
		let input = "app_1    | Downloading something\napp_1    | Waiting for db\n";
		let ctx = make_ctx("docker", Some("compose"), "docker compose --progress plain up", &cfg);
		let out = filter(&ctx, input, 0);
		assert!(
			out.text.contains("Downloading something"),
			"'Downloading' log lines must not be stripped by progress condenser: {}",
			out.text
		);
		assert!(
			out.text.contains("Waiting for db"),
			"'Waiting' log lines must not be stripped by progress condenser: {}",
			out.text
		);
	}

	#[test]
	fn test_is_compose_up_command_both_forms() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// Legacy form
		assert!(is_compose_up_command(&make_ctx("docker", Some("up"), "docker-compose up", &cfg)));
		// v2 form
		assert!(is_compose_up_command(&make_ctx(
			"docker",
			Some("compose"),
			"docker compose up",
			&cfg
		)));
		// v2 with global flags
		assert!(is_compose_up_command(&make_ctx(
			"docker",
			Some("compose"),
			"docker compose --progress plain up",
			&cfg
		)));
		// Must not match other actions
		assert!(!is_compose_up_command(&make_ctx(
			"docker",
			Some("compose"),
			"docker compose logs",
			&cfg
		)));
		assert!(!is_compose_up_command(&make_ctx(
			"docker",
			Some("compose"),
			"docker compose ps",
			&cfg
		)));
		// Plain docker build must not be classified as compose up
		assert!(!is_compose_up_command(&make_ctx("docker", Some("build"), "docker build .", &cfg)));
	}
}
