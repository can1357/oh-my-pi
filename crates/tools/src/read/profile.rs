//! Render compact summaries for V8 and macOS sampling profiles.

use std::{
	cmp::Reverse,
	collections::{HashMap, HashSet},
	fmt::Write as _,
	mem,
	path::Path,
};

use serde_json::Value;

/// Largest profiler file eligible for summary rendering.
///
/// Larger files must be handled by the caller's ordinary text path.
pub const MAX_PROFILE_SUMMARY_BYTES: u64 = 32 * 1024 * 1024;

const PRUNE_FRACTION: f64 = 0.02;
const TOP_FUNCTIONS: usize = 20;
const MAX_LABEL_CHARS: usize = 160;

fn path_ends_with(path: &Path, suffix: &str) -> bool {
	let Some(path) = path.to_str() else {
		return false;
	};
	path
		.get(path.len().saturating_sub(suffix.len())..)
		.is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
}

/// Returns whether `path` has the V8 CPU-profile suffix.
pub fn is_cpu_profile_path(path: &Path) -> bool {
	path_ends_with(path, ".cpuprofile")
}

/// Returns whether `path` has a conventional macOS `sample` report suffix.
pub fn is_sample_profile_path(path: &Path) -> bool {
	path_ends_with(path, ".sample") || path_ends_with(path, ".sample.txt")
}

/// Summarizes a recognized, size-eligible profiler file.
///
/// `None` means the path is unsupported, the input exceeds 32 MiB, or parsing
/// did not yield a usable profile; callers should then use the plain-text path.
pub fn render_profile(path: &Path, text: &str) -> Option<String> {
	if text.len() as u64 > MAX_PROFILE_SUMMARY_BYTES {
		return None;
	}
	if is_cpu_profile_path(path) {
		render_cpu_profile(text)
	} else if is_sample_profile_path(path) {
		render_sample_profile(text)
	} else {
		None
	}
}

#[derive(Clone)]
struct ProfileNode {
	key:       String,
	label:     String,
	value:     f64,
	recursion: usize,
	children:  Vec<Self>,
}

fn merge_into(a: &mut ProfileNode, b: ProfileNode) {
	a.value += b.value;
	a.recursion = a.recursion.max(b.recursion);
	for child in b.children {
		if let Some(existing) = a.children.iter_mut().find(|item| item.key == child.key) {
			merge_into(existing, child);
		} else {
			a.children.push(child);
		}
	}
}

fn flatten_recursion(node: &mut ProfileNode) {
	while node.children.iter().any(|child| child.key == node.key) {
		node.recursion += 1;
		let children = mem::take(&mut node.children);
		let mut next: Vec<ProfileNode> = Vec::new();
		for child in children {
			let promoted = if child.key == node.key {
				child.children
			} else {
				vec![child]
			};
			for item in promoted {
				if let Some(existing) = next.iter_mut().find(|entry| entry.key == item.key) {
					merge_into(existing, item);
				} else {
					next.push(item);
				}
			}
		}
		node.children = next;
	}
}

fn format_pct(value: f64, total: f64) -> String {
	if total <= 0.0 {
		"0%".to_owned()
	} else {
		format!("{:.1}%", 100.0 * value / total)
	}
}

fn decorated_label(node: &ProfileNode) -> String {
	let mut label = truncate_chars(&node.label, MAX_LABEL_CHARS);
	if node.recursion > 0 {
		write!(label, " [recursive ×{}]", node.recursion + 1).expect("writing to String");
	}
	label
}

fn truncate_chars(value: &str, max: usize) -> String {
	if value.chars().count() <= max {
		return value.to_owned();
	}
	let mut out: String = value.chars().take(max - 1).collect();
	out.push('…');
	out
}

fn render_profile_node(
	node: &mut ProfileNode,
	indent: usize,
	total: f64,
	min_value: f64,
	value_width: usize,
	format_value: fn(f64) -> String,
	out: &mut Vec<String>,
) {
	flatten_recursion(node);
	let mut labels = vec![decorated_label(node)];
	let root_value = node.value;
	let mut current = node;
	loop {
		if current.recursion > 0 {
			break;
		}
		let kept: Vec<usize> = current
			.children
			.iter()
			.enumerate()
			.filter_map(|(ix, child)| (child.value >= min_value).then_some(ix))
			.collect();
		if kept.len() != 1 || current.value - current.children[kept[0]].value >= min_value {
			break;
		}
		current = &mut current.children[kept[0]];
		flatten_recursion(current);
		labels.push(decorated_label(current));
	}

	let path = match labels.as_slice() {
		[first, middle @ .., last] if labels.len() > 4 => {
			format!("{first} › ⋯{} frames⋯ › {last}", middle.len())
		},
		_ => labels.join(" › "),
	};
	out.push(format!(
		"{:>width$} {:>6}  {}{}",
		format_value(root_value),
		format_pct(root_value, total),
		"  ".repeat(indent),
		path,
		width = value_width,
	));

	let mut kept: Vec<usize> = current
		.children
		.iter()
		.enumerate()
		.filter_map(|(ix, child)| (child.value >= min_value).then_some(ix))
		.collect();
	kept.sort_by(|a, b| {
		current.children[*b]
			.value
			.total_cmp(&current.children[*a].value)
	});
	for ix in kept {
		render_profile_node(
			&mut current.children[ix],
			indent + 1,
			total,
			min_value,
			value_width,
			format_value,
			out,
		);
	}
}

#[derive(Clone)]
struct CpuFrame {
	function_name: String,
	url:           String,
	line_number:   Option<f64>,
}

struct CpuNode {
	id:        i64,
	frame:     CpuFrame,
	hit_count: f64,
	children:  Vec<i64>,
}

struct CpuProfile {
	nodes:       Vec<CpuNode>,
	start_time:  f64,
	end_time:    f64,
	samples:     Option<Vec<i64>>,
	time_deltas: Option<Vec<f64>>,
}

fn integral_id(value: &Value) -> Option<i64> {
	let n = value.as_f64()?;
	(n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64)
		.then_some(n as i64)
}

fn number_array(value: Option<&Value>) -> Option<Vec<f64>> {
	let values = value?.as_array()?;
	values.iter().map(Value::as_f64).collect()
}

fn id_array(value: Option<&Value>) -> Option<Vec<i64>> {
	let values = value?.as_array()?;
	values.iter().map(integral_id).collect()
}

fn parse_cpu_profile(text: &str) -> Option<CpuProfile> {
	let data: Value = serde_json::from_str(text).ok()?;
	let profile = [
		Some(&data),
		data.get("profile"),
		data.get("result").and_then(|result| result.get("profile")),
		data.get("params").and_then(|params| params.get("profile")),
		data.get("result"),
	]
	.into_iter()
	.flatten()
	.find(|value| value.get("nodes").is_some())?;
	let object = profile.as_object()?;
	let raw_nodes = object.get("nodes")?.as_array()?;
	if raw_nodes.is_empty() {
		return None;
	}
	let start_time = object.get("startTime")?.as_f64()?;
	let end_time = object.get("endTime")?.as_f64()?;
	if !start_time.is_finite() || !end_time.is_finite() {
		return None;
	}
	let mut nodes = Vec::with_capacity(raw_nodes.len());
	for raw in raw_nodes {
		let raw = raw.as_object()?;
		let frame = raw.get("callFrame")?.as_object()?;
		let function_name = frame.get("functionName")?.as_str()?.to_owned();
		let url = frame
			.get("url")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let line_number = frame.get("lineNumber").and_then(Value::as_f64);
		let hit_count = raw.get("hitCount").and_then(Value::as_f64).unwrap_or(0.0);
		let children = match raw.get("children") {
			Some(value) => id_array(Some(value))?,
			None => Vec::new(),
		};
		nodes.push(CpuNode {
			id: integral_id(raw.get("id")?)?,
			frame: CpuFrame { function_name, url, line_number },
			hit_count,
			children,
		});
	}
	let samples = match object.get("samples") {
		Some(value) if value.is_array() => Some(id_array(Some(value))?),
		_ => None,
	};
	let time_deltas = match object.get("timeDeltas") {
		Some(value) if value.is_array() => Some(number_array(Some(value))?),
		_ => None,
	};
	Some(CpuProfile { nodes, start_time, end_time, samples, time_deltas })
}

fn short_url(url: &str) -> String {
	let value = url.strip_prefix("file://").unwrap_or(url);
	if let Some(ix) = value.rfind("node_modules/")
		&& ix > 0
	{
		return value[ix..].to_owned();
	}
	let parts: Vec<&str> = value.split('/').collect();
	if parts.len() > 4 {
		format!("…/{}", parts[parts.len() - 3..].join("/"))
	} else {
		value.to_owned()
	}
}

fn frame_label(frame: &CpuFrame) -> String {
	let name = if frame.function_name.is_empty() {
		"(anonymous)"
	} else {
		&frame.function_name
	};
	if frame.url.is_empty() {
		return name.to_owned();
	}
	let line = frame
		.line_number
		.filter(|line| *line >= 0.0)
		.map(|line| format!(":{}", line + 1.0))
		.unwrap_or_default();
	format!("{} ({}{})", name, short_url(&frame.url), line)
}

fn cpu_self_micros(profile: &CpuProfile) -> HashMap<i64, f64> {
	let mut result = HashMap::new();
	if let (Some(samples), Some(deltas)) = (&profile.samples, &profile.time_deltas)
		&& !samples.is_empty()
	{
		for (&id, &delta) in samples.iter().zip(deltas) {
			if delta.is_finite() && delta > 0.0 {
				*result.entry(id).or_insert(0.0) += delta;
			}
		}
		return result;
	}
	let total_hits: f64 = profile.nodes.iter().map(|node| node.hit_count).sum();
	if total_hits == 0.0 {
		return result;
	}
	let interval = (profile.end_time - profile.start_time) / total_hits;
	for node in &profile.nodes {
		if node.hit_count != 0.0 {
			result.insert(node.id, node.hit_count * interval);
		}
	}
	result
}

fn format_ms(value: f64) -> String {
	format!("{:.1}", value / 1000.0)
}

/// Renders a V8 `.cpuprofile` bottleneck summary, or `None` for malformed or
/// empty-on-CPU input.
pub fn render_cpu_profile(text: &str) -> Option<String> {
	let profile = parse_cpu_profile(text)?;
	let by_id: HashMap<i64, usize> = profile
		.nodes
		.iter()
		.enumerate()
		.map(|(ix, node)| (node.id, ix))
		.collect();
	let referenced: HashSet<i64> = profile
		.nodes
		.iter()
		.flat_map(|node| node.children.iter().copied())
		.collect();
	let self_micros = cpu_self_micros(&profile);
	let mut visited = HashSet::new();

	fn build(
		ix: usize,
		profile: &CpuProfile,
		by_id: &HashMap<i64, usize>,
		self_micros: &HashMap<i64, f64>,
		visited: &mut HashSet<i64>,
	) -> ProfileNode {
		let node = &profile.nodes[ix];
		visited.insert(node.id);
		let mut children: Vec<ProfileNode> = Vec::new();
		for child_id in &node.children {
			let Some(&child_ix) = by_id.get(child_id) else {
				continue;
			};
			if visited.contains(child_id) {
				continue;
			}
			let child = build(child_ix, profile, by_id, self_micros, visited);
			if let Some(existing) = children.iter_mut().find(|entry| entry.key == child.key) {
				merge_into(existing, child);
			} else {
				children.push(child);
			}
		}
		let mut value = if node.frame.function_name == "(idle)" {
			0.0
		} else {
			self_micros.get(&node.id).copied().unwrap_or(0.0)
		};
		value += children.iter().map(|child| child.value).sum::<f64>();
		let label = frame_label(&node.frame);
		ProfileNode { key: label.clone(), label, value, recursion: 0, children }
	}

	let mut roots = Vec::new();
	for (ix, node) in profile.nodes.iter().enumerate() {
		if referenced.contains(&node.id) || visited.contains(&node.id) {
			continue;
		}
		let built = build(ix, &profile, &by_id, &self_micros, &mut visited);
		if node.frame.function_name == "(root)" {
			roots.extend(built.children);
		} else {
			roots.push(built);
		}
	}
	let total_cpu: f64 = roots.iter().map(|root| root.value).sum();
	if total_cpu <= 0.0 || !total_cpu.is_finite() {
		return None;
	}
	let duration = (profile.end_time - profile.start_time).max(0.0);
	let sample_count = profile.samples.as_ref().map_or(0, Vec::len);
	let avg_interval = if sample_count > 0 {
		duration / sample_count as f64
	} else {
		0.0
	};
	let mut out = Vec::new();
	let mut header = format!("V8 CPU profile: {:.2} s wall clock", duration / 1e6);
	if sample_count > 0 {
		write!(header, ", {sample_count} samples (avg interval {:.0} µs)", avg_interval.round())
			.expect("writing to String");
	}
	out.push(header);
	out.push(format!(
		"On-CPU total: {:.2} s ({} of wall clock). Values below are on-CPU milliseconds (idle time \
		 excluded).",
		total_cpu / 1e6,
		format_pct(total_cpu, duration),
	));
	out.push(String::new());
	out.push("## Hot paths".to_owned());
	let min_value = (3.0 * avg_interval).max(total_cpu * PRUNE_FRACTION);
	let value_width = 8usize.max(format_ms(total_cpu).len());
	roots.sort_by(|a, b| b.value.total_cmp(&a.value));
	let mut kept = 0;
	for root in &mut roots {
		if root.value >= min_value {
			kept += 1;
			render_profile_node(root, 0, total_cpu, min_value, value_width, format_ms, &mut out);
		}
	}
	if kept == 0 {
		out.push(format!("  (no call path above {} ms on-CPU)", format_ms(min_value)));
	}

	let mut totals: Vec<(String, f64)> = Vec::new();
	for node in &profile.nodes {
		let micros = self_micros.get(&node.id).copied().unwrap_or(0.0);
		if micros <= 0.0
			|| node.frame.function_name == "(idle)"
			|| node.frame.function_name == "(root)"
		{
			continue;
		}
		let label = frame_label(&node.frame);
		if let Some((_, total)) = totals.iter_mut().find(|(existing, _)| *existing == label) {
			*total += micros;
		} else {
			totals.push((label, micros));
		}
	}
	totals.sort_by(|a, b| b.1.total_cmp(&a.1));
	if !totals.is_empty() {
		out.push(String::new());
		out.push("## Top functions by self time (idle time excluded)".to_owned());
		for (label, micros) in totals.into_iter().take(TOP_FUNCTIONS) {
			out.push(format!(
				"{:>width$} {:>6}  {}",
				format_ms(micros),
				format_pct(micros, total_cpu),
				label,
				width = value_width,
			));
		}
	}
	out.push(String::new());
	out.push(
		"[Summarized view of a V8 .cpuprofile. Use ':raw' to read the original JSON.]".to_owned(),
	);
	Some(out.join("\n"))
}

#[derive(Clone)]
struct SampleFrame {
	count:    u64,
	symbol:   String,
	module:   Option<String>,
	children: Vec<Self>,
}

struct SampleThread {
	id:    String,
	name:  Option<String>,
	total: u64,
	roots: Vec<SampleFrame>,
}

struct SampleHeader {
	process:        String,
	pid:            u64,
	interval_ms:    u64,
	path:           Option<String>,
	code_type:      Option<String>,
	os_version:     Option<String>,
	footprint:      Option<String>,
	footprint_peak: Option<String>,
}

struct SampleProfile {
	header:  SampleHeader,
	threads: Vec<SampleThread>,
}

fn parse_analysis(line: &str) -> Option<(String, u64, u64)> {
	let rest = line.strip_prefix("Analysis of sampling ")?;
	let (process, tail) = rest.split_once(" (pid ")?;
	let (pid, tail) = tail.split_once(") every ")?;
	let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
	let interval: u64 = tail[..digits].parse().ok()?;
	if !tail[digits..].starts_with(" millisecond") {
		return None;
	}
	Some((process.to_owned(), pid.parse().ok()?, interval))
}

fn parse_frame_text(text: &str) -> (String, Option<String>) {
	let mut value = text;
	if let Some(ix) = value.rfind("  [")
		&& value.ends_with(']')
	{
		value = &value[..ix];
	}
	if let Some(ix) = value.rfind(" + ") {
		let suffix = &value[ix + 3..];
		if !suffix.is_empty()
			&& suffix
				.chars()
				.all(|ch| ch.is_ascii_digit() || ch == ',' || ch == '.')
			&& suffix.as_bytes()[0].is_ascii_digit()
		{
			value = &value[..ix];
		}
	}
	if let Some(ix) = value.rfind("  (in ")
		&& value.ends_with(')')
	{
		return (value[..ix].trim().to_owned(), Some(value[ix + 6..value.len() - 1].to_owned()));
	}
	(value.trim().to_owned(), None)
}

fn parse_sample_profile(text: &str) -> Option<SampleProfile> {
	let lines: Vec<&str> = text.split('\n').collect();
	let (process, pid, interval_ms) = parse_analysis(lines.first().copied().unwrap_or_default())?;
	let call_graph = lines.iter().position(|line| *line == "Call graph:")?;
	let mut header = SampleHeader {
		process,
		pid,
		interval_ms,
		path: None,
		code_type: None,
		os_version: None,
		footprint: None,
		footprint_peak: None,
	};
	for line in &lines[1..call_graph] {
		let Some((key, value)) = line.split_once(':') else {
			continue;
		};
		let value = value.trim().to_owned();
		match key {
			"Path" => header.path = Some(value),
			"Code Type" => header.code_type = Some(value),
			"OS Version" => header.os_version = Some(value),
			"Physical footprint" => header.footprint = Some(value),
			"Physical footprint (peak)" => header.footprint_peak = Some(value),
			_ => {},
		}
	}

	let mut threads: Vec<SampleThread> = Vec::new();
	let mut stack: Vec<(usize, Vec<usize>)> = Vec::new();
	for line in &lines[call_graph + 1..] {
		if line.starts_with("Total number in stack")
			|| line.starts_with("Sort by top of stack")
			|| line.starts_with("Binary Images:")
		{
			break;
		}
		let Some(body) = line.strip_prefix("    ") else {
			continue;
		};
		let bytes = body.as_bytes();
		let mut p = 0;
		while p < bytes.len() && !bytes[p].is_ascii_digit() {
			p += 2;
		}
		if p >= bytes.len() {
			continue;
		}
		let depth = p / 2;
		let tail = &body[p..];
		let Some(space) = tail.find(char::is_whitespace) else {
			continue;
		};
		let Ok(count) = tail[..space].parse::<u64>() else {
			continue;
		};
		let frame_text = tail[space..].trim_start();
		if depth == 0 {
			let Some(rest) = frame_text.strip_prefix("Thread_") else {
				continue;
			};
			let split = rest
				.find(|ch: char| ch.is_whitespace() || ch == ':')
				.unwrap_or(rest.len());
			let id = rest[..split].to_owned();
			if id.is_empty() {
				continue;
			}
			let name = rest[split..]
				.trim_start_matches(':')
				.split_whitespace()
				.collect::<Vec<_>>()
				.join(" ");
			threads.push(SampleThread {
				id,
				name: (!name.is_empty()).then_some(name),
				total: count,
				roots: Vec::new(),
			});
			stack.clear();
			continue;
		}
		if threads.is_empty() {
			continue;
		}
		while stack
			.last()
			.is_some_and(|(prior_depth, _)| *prior_depth >= depth)
		{
			stack.pop();
		}
		let (symbol, module) = parse_frame_text(frame_text);
		let frame = SampleFrame { count, symbol, module, children: Vec::new() };
		let thread_ix = threads.len() - 1;
		let mut path = if let Some((_, parent_path)) = stack.last() {
			parent_path.clone()
		} else {
			Vec::new()
		};
		let siblings = sample_children_mut(&mut threads[thread_ix].roots, &path);
		siblings.push(frame);
		path.push(siblings.len() - 1);
		stack.push((depth, path));
	}
	(!threads.is_empty()).then_some(SampleProfile { header, threads })
}

fn sample_children_mut<'a>(
	roots: &'a mut Vec<SampleFrame>,
	path: &[usize],
) -> &'a mut Vec<SampleFrame> {
	let mut children = roots;
	for &ix in path {
		children = &mut children[ix].children;
	}
	children
}

const WAIT_SYMBOLS: &[&str] = &[
	"__accept",
	"__psynch_cvwait",
	"__psynch_mutexwait",
	"__psynch_rw_rdlock",
	"__psynch_rw_wrlock",
	"__recvfrom",
	"__select",
	"__semwait_signal",
	"__sigwait",
	"__ulock_wait",
	"__ulock_wait2",
	"__wait4",
	"__workq_kernreturn",
	"kevent",
	"kevent64",
	"kevent_qos",
	"mach_msg2_trap",
	"mach_msg_trap",
	"poll",
	"semaphore_timedwait_trap",
	"semaphore_wait_trap",
	"start_wqthread",
	"swtch_pri",
	"thread_suspend",
	"usleep",
];

fn is_wait(symbol: &str) -> bool {
	WAIT_SYMBOLS.contains(&symbol)
}

fn self_of(frame: &SampleFrame) -> u64 {
	frame
		.count
		.saturating_sub(frame.children.iter().map(|child| child.count).sum())
}

fn demangle_symbol(raw: &str) -> String {
	rustc_demangle::try_demangle(raw)
		.or_else(|_| {
			raw.strip_prefix('_')
				.ok_or(())
				.and_then(|symbol| rustc_demangle::try_demangle(symbol).map_err(|_| ()))
		})
		.map_or_else(|()| raw.to_owned(), |symbol| format!("{symbol:#}"))
}

fn build_sample_node(
	frame: &SampleFrame,
	cache: &mut HashMap<String, String>,
	main_module: &str,
) -> ProfileNode {
	let symbol = cache
		.entry(frame.symbol.clone())
		.or_insert_with(|| demangle_symbol(&frame.symbol))
		.clone();
	let mut children: Vec<ProfileNode> = Vec::new();
	for raw_child in &frame.children {
		let child = build_sample_node(raw_child, cache, main_module);
		if let Some(existing) = children.iter_mut().find(|entry| entry.key == child.key) {
			merge_into(existing, child);
		} else {
			children.push(child);
		}
	}
	let mut cpu = if is_wait(&frame.symbol) {
		0.0
	} else {
		self_of(frame) as f64
	};
	cpu += children.iter().map(|child| child.value).sum::<f64>();
	let label = match &frame.module {
		Some(module) if module != main_module => format!("{symbol} ({module})"),
		_ => symbol.clone(),
	};
	ProfileNode { key: symbol, label, value: cpu, recursion: 0, children }
}

fn dominant_wait(thread: &SampleThread) -> Option<String> {
	fn visit(frame: &SampleFrame, best: &mut Option<(String, u64)>) {
		if frame.children.is_empty()
			&& is_wait(&frame.symbol)
			&& best.as_ref().is_none_or(|(_, count)| frame.count > *count)
		{
			*best = Some((frame.symbol.clone(), frame.count));
		}
		for child in &frame.children {
			visit(child, best);
		}
	}
	let mut best = None;
	for root in &thread.roots {
		visit(root, &mut best);
	}
	best.map(|(symbol, _)| symbol)
}

fn sample_value(value: f64) -> String {
	format!("{value:.0}")
}

/// Renders a macOS `/usr/bin/sample` call-tree summary, or `None` when the
/// input is not a structurally recognizable report.
pub fn render_sample_profile(text: &str) -> Option<String> {
	let profile = parse_sample_profile(text)?;
	let mut cache = HashMap::new();
	let mut annotated: Vec<(&SampleThread, Vec<ProfileNode>, f64)> = profile
		.threads
		.iter()
		.map(|thread| {
			let roots: Vec<_> = thread
				.roots
				.iter()
				.map(|root| build_sample_node(root, &mut cache, &profile.header.process))
				.collect();
			let cpu = roots.iter().map(|root| root.value).sum();
			(thread, roots, cpu)
		})
		.collect();
	let process_cpu: f64 = annotated.iter().map(|entry| entry.2).sum();
	let max_samples = profile
		.threads
		.iter()
		.map(|thread| thread.total)
		.max()
		.unwrap_or(0);
	let mut out = vec![format!(
		"macOS sample profile: {} (pid {}), sampled every {} ms",
		profile.header.process, profile.header.pid, profile.header.interval_ms,
	)];
	let mut meta = Vec::new();
	if let Some(path) = &profile.header.path {
		meta.push(path.clone());
	}
	if let Some(code_type) = &profile.header.code_type {
		meta.push(code_type.clone());
	}
	if let Some(os) = &profile.header.os_version {
		meta.push(format!("macOS {}", os.strip_prefix("macOS ").unwrap_or(os)));
	}
	if !meta.is_empty() {
		out.push(meta.join(" | "));
	}
	let mut stats = format!(
		"Duration: ~{:.1} s ({} samples/thread)",
		max_samples as f64 * profile.header.interval_ms as f64 / 1000.0,
		max_samples,
	);
	if let Some(footprint) = &profile.header.footprint {
		write!(stats, " | Footprint: {footprint}").expect("writing to String");
		if let Some(peak) = &profile.header.footprint_peak {
			write!(stats, " (peak {peak})").expect("writing to String");
		}
	}
	out.push(stats);
	out.push(String::new());
	out.push(format!(
		"Process total: {:.0} on-CPU samples across {} threads. Counts and percentages below are \
		 on-CPU samples (blocked time excluded).",
		process_cpu,
		profile.threads.len(),
	));

	let mut active = Vec::new();
	let mut idle = Vec::new();
	for (ix, (thread, _, cpu)) in annotated.iter().enumerate() {
		let threshold = 10.0f64.max(thread.total as f64 * 0.002);
		if *cpu >= threshold {
			active.push(ix);
		} else {
			idle.push(ix);
		}
	}
	active.sort_by(|a, b| annotated[*b].2.total_cmp(&annotated[*a].2));
	for ix in active {
		let (thread, roots, cpu) = &mut annotated[ix];
		out.push(String::new());
		let title = thread.name.as_ref().map_or_else(
			|| format!("Thread_{}", thread.id),
			|name| format!("{name} (Thread_{})", thread.id),
		);
		out.push(format!(
			"## {title} — {} samples, {:.0} on-CPU ({})",
			thread.total,
			*cpu,
			format_pct(*cpu, thread.total as f64)
		));
		let min_value = 3.0f64.max((*cpu * PRUNE_FRACTION).round());
		roots.sort_by(|a, b| b.value.total_cmp(&a.value));
		let mut kept = 0;
		for root in roots {
			if root.value >= min_value {
				kept += 1;
				render_profile_node(root, 0, *cpu, min_value, 6, sample_value, &mut out);
			}
		}
		if kept == 0 {
			out.push(format!("  (no call path above {min_value:.0} on-CPU samples)"));
		}
	}
	if !idle.is_empty() {
		out.push(String::new());
		out.push(format!("## Idle / negligible threads ({})", idle.len()));
		for ix in idle {
			let (thread, _, cpu) = &annotated[ix];
			let title = thread.name.as_ref().map_or_else(
				|| format!("Thread_{}", thread.id),
				|name| format!("{name} (Thread_{})", thread.id),
			);
			let state = dominant_wait(thread).map_or_else(
				|| format!("{:.0}/{} samples on-CPU", cpu, thread.total),
				|wait| format!("blocked in {wait} ({cpu:.0} on-CPU)"),
			);
			out.push(format!("- {title}: {state}"));
		}
	}

	let mut totals: Vec<(String, u64, Option<String>)> = Vec::new();
	fn aggregate(
		frame: &SampleFrame,
		cache: &mut HashMap<String, String>,
		totals: &mut Vec<(String, u64, Option<String>)>,
	) {
		if !is_wait(&frame.symbol) {
			let cpu = self_of(frame);
			if cpu > 0 {
				let symbol = cache
					.entry(frame.symbol.clone())
					.or_insert_with(|| demangle_symbol(&frame.symbol))
					.clone();
				if let Some((_, value, _)) =
					totals.iter_mut().find(|(existing, ..)| *existing == symbol)
				{
					*value += cpu;
				} else {
					totals.push((symbol, cpu, frame.module.clone()));
				}
			}
		}
		for child in &frame.children {
			aggregate(child, cache, totals);
		}
	}
	for thread in &profile.threads {
		for root in &thread.roots {
			aggregate(root, &mut cache, &mut totals);
		}
	}
	totals.sort_by_key(|(_, samples, _)| Reverse(*samples));
	if !totals.is_empty() {
		out.push(String::new());
		out.push("## Top functions by self samples (process-wide, blocked time excluded)".to_owned());
		for (symbol, cpu, module) in totals.into_iter().take(TOP_FUNCTIONS) {
			let suffix = module
				.filter(|value| value != &profile.header.process)
				.map_or_else(String::new, |value| format!(" ({value})"));
			out.push(format!("{cpu:>6} {:>6}  {symbol}{suffix}", format_pct(cpu as f64, process_cpu)));
		}
	}
	out.push(String::new());
	out.push(
		"[Summarized view of a macOS `sample` call-tree report. Use ':raw' to read the original \
		 file.]"
			.to_owned(),
	);
	Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
	use std::iter;

	use super::*;

	const CPU_PROFILE: &str = r#"{"nodes":[{"id":1,"callFrame":{"functionName":"(root)"},"children":[2]},{"id":2,"callFrame":{"functionName":"work","url":"file:///tmp/work.js","lineNumber":0},"hitCount":1,"children":[]}],"startTime":0,"endTime":1,"samples":[2],"timeDeltas":[1]}"#;

	#[test]
	fn renders_representative_macos_sample_tree() {
		let input = [
			"Analysis of sampling demo (pid 42) every 1 millisecond",
			"Path:            /tmp/demo",
			"Call graph:",
			"    100 Thread_1: main",
			"    + 100 run  (in demo) + 8  [0x100]",
			"    +   80 work  (in demo) + 4  [0x200]",
			"    +   20 semaphore_wait_trap  (in libsystem_kernel.dylib) + 8  [0x300]",
			"    50 Thread_2: idler",
			"    + 50 thread_start  (in libsystem_pthread.dylib) + 8  [0x400]",
			"    +   50 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x500]",
			"Total number in stack (recursive counted multiple, when >=5):",
		]
		.join("\n");

		let expected = [
			"macOS sample profile: demo (pid 42), sampled every 1 ms",
			"/tmp/demo",
			"Duration: ~0.1 s (100 samples/thread)",
			"",
			"Process total: 80 on-CPU samples across 2 threads. Counts and percentages below are \
			 on-CPU samples (blocked time excluded).",
			"",
			"## main (Thread_1) — 100 samples, 80 on-CPU (80.0%)",
			"    80 100.0%  run › work",
			"",
			"## Idle / negligible threads (1)",
			"- idler (Thread_2): blocked in mach_msg2_trap (0 on-CPU)",
			"",
			"## Top functions by self samples (process-wide, blocked time excluded)",
			"    80 100.0%  work",
			"",
			"[Summarized view of a macOS `sample` call-tree report. Use ':raw' to read the original \
			 file.]",
		]
		.join("\n");
		assert_eq!(render_sample_profile(&input), Some(expected));
	}

	#[test]
	fn malformed_profile_requests_fall_through() {
		assert_eq!(render_cpu_profile("{not json"), None);
		assert_eq!(
			render_sample_profile("Analysis of sampling demo (pid 42) every 1 millisecond"),
			None,
		);
		assert_eq!(render_profile(Path::new("notes.txt"), CPU_PROFILE), None);
	}

	#[test]
	fn unwraps_cdp_payloads_and_demangles_rust_symbols() {
		let cdp = format!(r#"{{"id":7,"result":{{"profile":{CPU_PROFILE}}}}}"#);
		assert!(render_cpu_profile(&cdp).is_some());
		assert_eq!(demangle_symbol("_ZN4test4main17h0123456789abcdefE"), "test::main",);
	}

	#[test]
	fn summary_cap_is_inclusive_and_oversized_input_falls_through() {
		let mut at_cap = CPU_PROFILE.to_owned();
		at_cap.extend(iter::repeat_n(' ', MAX_PROFILE_SUMMARY_BYTES as usize - at_cap.len()));
		assert!(render_profile(Path::new("profile.cpuprofile"), &at_cap).is_some());

		at_cap.push(' ');
		assert_eq!(at_cap.len() as u64, MAX_PROFILE_SUMMARY_BYTES + 1);
		assert_eq!(render_profile(Path::new("profile.cpuprofile"), &at_cap), None);
	}
}
