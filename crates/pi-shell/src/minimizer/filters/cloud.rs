//! Cloud and data command output filters.

use std::fmt::Write as _;

use serde_json::{Map, Value};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const MAX_PSQL_ROWS: usize = 30;
const MAX_LINE_CHARS: usize = 500;
const MAX_AWS_ROWS: usize = 40;

const SENSITIVE_AWS_KEYS: &[&str] = &[
	"Policy",
	"PolicyDocument",
	"AssumeRolePolicyDocument",
	"Environment",
	"SecretString",
	"SecretBinary",
	"Token",
	"SessionToken",
	"Credentials",
	"Password",
	"PrivateKey",
	"KeyMaterial",
	"PlaintextKeyMaterial",
	"CiphertextBlob",
	"ResponseMetadata",
];

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "aws" | "curl" | "wget" | "psql")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"aws" => filter_aws(ctx, &cleaned, exit_code),
		"curl" | "wget" => filter_http_transfer(ctx, &cleaned, exit_code),
		"psql" => {
			if is_psql_machine_readable(ctx.command) {
				cleaned
			} else {
				filter_psql(&cleaned, exit_code)
			}
		},
		_ => head_tail_dedup(&cleaned, 80, 40),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// Returns `true` when the full command is `aws s3 ls [...]` (not `cp`, `sync`,
/// `rm`, etc.). Skips flags between `s3` and the action token so
/// `aws --no-cli-pager s3 ls` is still recognised while `aws s3 cp` is
/// excluded.
fn is_s3_ls(command: &str) -> bool {
	let mut past_s3 = false;
	for token in command.split_whitespace() {
		if !past_s3 {
			if token == "s3" {
				past_s3 = true;
			}
		} else if token.starts_with('-') {
			// skip flags between "s3" and the action word
		} else {
			return token == "ls";
		}
	}
	false
}

/// Returns `true` when an AWS CLI invocation streams object content via a
/// `-` positional (stdout download `aws s3 cp s3://bucket/key -`, or stdin
/// upload `aws s3 cp - s3://bucket/key`). In that mode the captured text is
/// the object body, not CLI progress, so `strip_transfer_progress` must not
/// run. Any bare `-` token triggers passthrough — even when trailing options
/// follow the positional (`aws s3 cp s3://bucket/key - --request-payer
/// requester`); a false positive only skips minimization, which is safe.
fn is_aws_stdout_pipe(command: &str) -> bool {
	command.split_whitespace().any(|token| token == "-")
}

fn filter_aws(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if is_aws_stdout_pipe(ctx.command) {
		return input.to_string();
	}

	let without_progress = strip_transfer_progress(input);
	// Only the `ls` listing form should be reshaped into a bucket/date table;
	// `aws s3 cp`/`sync`/`rm` emit progress/result lines (`upload: ... to
	// s3://...`) that must not be misparsed as listing rows.
	if exit_code == 0
		&& ctx.subcommand == Some("s3")
		&& is_s3_ls(ctx.command)
		&& let Some(compacted) = compact_aws_s3_ls_text(&without_progress)
	{
		return compacted;
	}
	if let Some(compacted) = try_compact_aws_json(ctx, &without_progress) {
		return compacted;
	}
	if looks_like_table(&without_progress) {
		compact_delimited_table(&without_progress, 40)
	} else {
		without_progress
	}
}

/// Try to parse AWS CLI JSON output and produce a compact representation.
/// Returns None if input is not recognized JSON or if schema is unexpected.
fn try_compact_aws_json(ctx: &MinimizerCtx<'_>, input: &str) -> Option<String> {
	let trimmed = input.trim();
	if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
		return None;
	}
	let root: Value = serde_json::from_str(trimmed).ok()?;

	if let Some(compacted) = compact_aws_service_json(ctx, &root) {
		return Some(compacted);
	}

	// EC2 describe-instances: {"Reservations":[{"Instances":[...]}]}
	if let Some(instances) = extract_aws_ec2_instances(&root) {
		return Some(compact_aws_ec2_instances(&instances));
	}

	// CloudWatch logs / filtered log events: {"events":[...]}
	if let Some(events) = extract_aws_cloudwatch_events(&root) {
		return Some(compact_aws_cloudwatch_events(&events));
	}

	// DynamoDB get-item/query/scan: {"Item":{...}} or {"Items":[{...}]}
	if let Some(items) = extract_aws_dynamodb_items(&root) {
		return Some(compact_aws_dynamodb_items(&items));
	}

	compact_aws_generic(&root)
}

fn compact_aws_service_json(ctx: &MinimizerCtx<'_>, root: &Value) -> Option<String> {
	match ctx.subcommand {
		Some("sts") => extract_aws_sts_caller(root).map(compact_aws_sts_caller),
		Some("s3" | "s3api") => extract_aws_s3_buckets(root).map(|rows| {
			compact_named_rows(
				&["bucket", "date"],
				&rows
					.iter()
					.map(|bucket| {
						vec![
							string_field_map(bucket, &["Name", "Bucket", "bucket", "name"]),
							string_field_map(bucket, &["CreationDate", "CreationDateTime", "date"]),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		Some("lambda") => extract_array(root, &["Functions"]).map(|rows| {
			compact_named_rows(
				&["function", "runtime", "memory", "modified"],
				&rows
					.iter()
					.map(|item| {
						vec![
							string_field_map(item, &["FunctionName", "Name"]),
							string_field_map(item, &["Runtime"]),
							string_field_map(item, &["MemorySize"]),
							string_field_map(item, &["LastModified"]),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		Some("iam") => extract_aws_iam_entities(root).map(|rows| {
			compact_named_rows(
				&["name", "arn", "created"],
				&rows
					.iter()
					.map(|item| {
						vec![
							string_field_map(item, &["UserName", "RoleName", "GroupName", "Name"]),
							string_field_map(item, &["Arn"]),
							string_field_map(item, &["CreateDate"]),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		Some("logs") => extract_aws_logs_events(root).map(compact_aws_logs_events),
		Some("ecs") => extract_aws_arn_list(root, &["clusterArns", "taskArns", "serviceArns"])
			.map(|rows| compact_single_col("arn", &rows)),
		Some("rds") => extract_array(root, &["DBInstances"]).map(|rows| {
			compact_named_rows(
				&["identifier", "engine", "status", "endpoint"],
				&rows
					.iter()
					.map(|item| {
						vec![
							string_field_map(item, &["DBInstanceIdentifier"]),
							string_field_map(item, &["Engine"]),
							string_field_map(item, &["DBInstanceStatus"]),
							item
								.get("Endpoint")
								.and_then(Value::as_object)
								.map_or_else(|| "-".to_string(), |ep| string_field_map(ep, &["Address"])),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		Some("cloudformation") => extract_array(root, &["Stacks"]).map(|rows| {
			compact_named_rows(
				&["stack", "status", "updated"],
				&rows
					.iter()
					.map(|item| {
						vec![
							string_field_map(item, &["StackName"]),
							string_field_map(item, &["StackStatus"]),
							string_field_map(item, &["LastUpdatedTime", "CreationTime"]),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		Some("eks") => compact_aws_eks(root),
		Some("sqs") => compact_aws_sqs(root),
		Some("secretsmanager") => extract_array(root, &["SecretList"]).map(|rows| {
			compact_named_rows(
				&["name", "arn", "changed"],
				&rows
					.iter()
					.map(|item| {
						vec![
							string_field_map(item, &["Name"]),
							string_field_map(item, &["ARN", "Arn"]),
							string_field_map(item, &["LastChangedDate", "LastAccessedDate"]),
						]
					})
					.collect::<Vec<_>>(),
			)
		}),
		_ => None,
	}
}

fn extract_aws_sts_caller(root: &Value) -> Option<&Map<String, Value>> {
	let map = root.as_object()?;
	if map.contains_key("Account") && map.contains_key("Arn") {
		Some(map)
	} else {
		None
	}
}

fn compact_aws_sts_caller(map: &Map<String, Value>) -> String {
	format!(
		"account={} arn={} user-id={}\n",
		string_field_map(map, &["Account"]),
		string_field_map(map, &["Arn"]),
		string_field_map(map, &["UserId"])
	)
}

fn extract_aws_s3_buckets(root: &Value) -> Option<Vec<&Map<String, Value>>> {
	extract_array(root, &["Buckets", "buckets"])
}

/// True for an `aws s3 ls` date column (`YYYY-MM-DD`).
fn is_s3_date(token: &str) -> bool {
	let mut parts = token.split('-');
	matches!(
		(parts.next(), parts.next(), parts.next(), parts.next()),
		(Some(y), Some(m), Some(d), None)
			if y.len() == 4
				&& m.len() == 2
				&& d.len() == 2
				&& [y, m, d].iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
	)
}

/// True for an `aws s3 ls` time column (`HH:MM:SS`).
fn is_s3_time(token: &str) -> bool {
	let mut parts = token.split(':');
	matches!(
		(parts.next(), parts.next(), parts.next(), parts.next()),
		(Some(h), Some(m), Some(s), None)
			if [h, m, s].iter().all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
	)
}

fn compact_aws_s3_ls_text(input: &str) -> Option<String> {
	let mut rows = Vec::new();
	let mut passthrough_lines = Vec::new();
	for line in input.lines() {
		let mut parts = line.split_whitespace();
		let Some(first) = parts.next() else {
			continue;
		};
		if first == "PRE" {
			// A common-prefix name may contain spaces (`PRE my folder/`), so
			// join the remaining tokens instead of keeping only the first one.
			let prefix: Vec<&str> = parts.collect();
			if prefix.is_empty() {
				passthrough_lines.push(line);
			} else {
				rows.push(vec![
					prefix.join(" ").trim_end_matches('/').to_string(),
					"prefix".to_string(),
				]);
			}
			continue;
		}
		let Some(time) = parts.next() else {
			passthrough_lines.push(line);
			continue;
		};
		// Require a real date/time prefix so `--summarize` footers
		// (`Total Objects: 1`, `Total Size: ...`) and any diagnostic/error
		// text are not reinterpreted as object rows.
		if !is_s3_date(first) || !is_s3_time(time) {
			passthrough_lines.push(line);
			continue;
		}
		let Some(third) = parts.next() else {
			passthrough_lines.push(line);
			continue;
		};
		if third == "0" && parts.clone().next().is_none() {
			continue;
		}
		// Collect all remaining tokens as the key so that S3 keys
		// containing spaces (e.g. "reports/June 2026.csv") are
		// preserved in full rather than truncated to the last token.
		let rest: Vec<&str> = parts.collect();
		let name = if rest.is_empty() {
			third.to_string()
		} else {
			rest.join(" ")
		};
		rows.push(vec![name, format!("{first} {time}")]);
	}
	if rows.is_empty() {
		None
	} else {
		let mut out = compact_named_rows(&["bucket", "date"], &rows);
		if !passthrough_lines.is_empty() {
			if !out.ends_with('\n') {
				out.push('\n');
			}
			for line in passthrough_lines {
				out.push_str(line);
				out.push('\n');
			}
		}
		Some(out)
	}
}

fn extract_aws_iam_entities(root: &Value) -> Option<Vec<&Map<String, Value>>> {
	extract_array(root, &["Users", "Roles", "Groups", "Policies"])
}

fn extract_aws_logs_events(root: &Value) -> Option<Vec<&Map<String, Value>>> {
	extract_array(root, &["events", "Events", "logEvents"])
}

fn compact_aws_logs_events(rows: Vec<&Map<String, Value>>) -> String {
	compact_named_rows(
		&["timestamp", "level", "message"],
		&rows
			.iter()
			.map(|event| {
				let msg = string_field_map(event, &["message", "Message"]);
				vec![
					string_field_map(event, &["timestamp", "eventTimestamp"]),
					infer_level(&msg).to_string(),
					primitives::truncate_line(&msg, MAX_LINE_CHARS),
				]
			})
			.collect::<Vec<_>>(),
	)
}

fn extract_aws_arn_list(root: &Value, keys: &[&str]) -> Option<Vec<String>> {
	for key in keys {
		if let Some(values) = root.get(key).and_then(Value::as_array) {
			let rows = values
				.iter()
				.filter_map(Value::as_str)
				.map(ToOwned::to_owned)
				.collect::<Vec<_>>();
			if !rows.is_empty() {
				return Some(rows);
			}
		}
	}
	None
}

fn compact_aws_eks(root: &Value) -> Option<String> {
	if let Some(values) = root.get("clusters").and_then(Value::as_array) {
		let rows = values
			.iter()
			.filter_map(Value::as_str)
			.map(|name| vec![name.to_string(), "-".to_string(), "-".to_string(), "-".to_string()])
			.collect::<Vec<_>>();
		return Some(compact_named_rows(&["cluster", "status", "version", "endpoint"], &rows));
	}
	let cluster = root.get("cluster")?.as_object()?;
	Some(compact_named_rows(&["cluster", "status", "version", "endpoint"], &[vec![
		string_field_map(cluster, &["name"]),
		string_field_map(cluster, &["status"]),
		string_field_map(cluster, &["version"]),
		string_field_map(cluster, &["endpoint"]),
	]]))
}

fn compact_aws_sqs(root: &Value) -> Option<String> {
	if let Some(values) = root.get("QueueUrls").and_then(Value::as_array) {
		let rows = values
			.iter()
			.filter_map(Value::as_str)
			.map(|url| vec![url.to_string(), "-".to_string(), "-".to_string()])
			.collect::<Vec<_>>();
		return Some(compact_named_rows(&["url", "visibility", "messages"], &rows));
	}
	let attrs = root.get("Attributes").and_then(Value::as_object)?;
	Some(compact_named_rows(&["url", "visibility", "messages"], &[vec![
		string_field(root, &["QueueUrl"]),
		string_field_map(attrs, &["VisibilityTimeout"]),
		string_field_map(attrs, &["ApproximateNumberOfMessages"]),
	]]))
}

fn extract_array<'a>(root: &'a Value, keys: &[&str]) -> Option<Vec<&'a Map<String, Value>>> {
	for key in keys {
		if let Some(values) = root.get(key).and_then(Value::as_array) {
			let rows = values
				.iter()
				.filter_map(Value::as_object)
				.collect::<Vec<_>>();
			if !rows.is_empty() {
				return Some(rows);
			}
		}
	}
	None
}

fn compact_aws_generic(root: &Value) -> Option<String> {
	let pruned = prune_aws_sensitive(root);
	if let Some((name, rows)) = first_object_array(&pruned) {
		let columns = generic_columns(&rows);
		if columns.is_empty() {
			return None;
		}
		let values = rows
			.iter()
			.take(MAX_AWS_ROWS)
			.map(|row| {
				columns
					.iter()
					.map(|column| string_field_map(row, &[column.as_str()]))
					.collect::<Vec<_>>()
			})
			.collect::<Vec<_>>();
		let mut out =
			compact_named_rows(&columns.iter().map(String::as_str).collect::<Vec<_>>(), &values);
		if rows.len() > MAX_AWS_ROWS {
			let _ = writeln!(out, "[…{} {name} elided…]", rows.len() - MAX_AWS_ROWS);
		}
		return Some(out);
	}
	None
}

fn prune_aws_sensitive(value: &Value) -> Value {
	match value {
		Value::Object(map) => Value::Object(
			map.iter()
				.filter_map(|(key, value)| {
					if SENSITIVE_AWS_KEYS.iter().any(|sensitive| sensitive == key) {
						None
					} else {
						Some((key.clone(), prune_aws_sensitive(value)))
					}
				})
				.collect(),
		),
		Value::Array(values) => Value::Array(values.iter().map(prune_aws_sensitive).collect()),
		_ => value.clone(),
	}
}

fn first_object_array(root: &Value) -> Option<(&str, Vec<Map<String, Value>>)> {
	let map = root.as_object()?;
	for (key, value) in map {
		let Some(values) = value.as_array() else {
			continue;
		};
		let rows = values
			.iter()
			.filter_map(Value::as_object)
			.cloned()
			.collect::<Vec<_>>();
		if !rows.is_empty() {
			return Some((key.as_str(), rows));
		}
	}
	None
}

fn generic_columns(rows: &[Map<String, Value>]) -> Vec<String> {
	let mut columns = Vec::new();
	for row in rows {
		for key in row.keys() {
			let lower = key.to_ascii_lowercase();
			if (matches!(
				lower.as_str(),
				"id"
					| "name" | "arn"
					| "status" | "state"
					| "created"
					| "modified"
					| "type" | "engine"
					| "version"
			) || lower.ends_with("id")
				|| lower.ends_with("name")
				|| lower.ends_with("arn")
				|| lower.ends_with("status")
				|| lower.ends_with("state")
				|| lower.contains("created")
				|| lower.contains("modified"))
				&& !columns.contains(key)
			{
				columns.push(key.clone());
			}
			if columns.len() >= 6 {
				return columns;
			}
		}
	}
	columns
}

fn compact_named_rows(headers: &[&str], rows: &[Vec<String>]) -> String {
	let mut out = String::new();
	out.push_str(&headers.join("\t"));
	out.push('\n');
	for row in rows.iter().take(MAX_AWS_ROWS) {
		out.push_str(&row.join("\t"));
		out.push('\n');
	}
	if rows.len() > MAX_AWS_ROWS {
		let _ = writeln!(out, "[…{} rows elided…]", rows.len() - MAX_AWS_ROWS);
	}
	out
}

fn compact_single_col(header: &str, rows: &[String]) -> String {
	let values = rows.iter().map(|row| vec![row.clone()]).collect::<Vec<_>>();
	compact_named_rows(&[header], &values)
}

fn string_field(value: &Value, keys: &[&str]) -> String {
	value
		.as_object()
		.map_or_else(|| "-".to_string(), |map| string_field_map(map, keys))
}

fn string_field_map(map: &Map<String, Value>, keys: &[&str]) -> String {
	for key in keys {
		if let Some(value) = map.get(*key) {
			return value_to_cell(value);
		}
	}
	"-".to_string()
}

fn value_to_cell(value: &Value) -> String {
	match value {
		Value::String(value) => value.clone(),
		Value::Number(value) => value.to_string(),
		Value::Bool(value) => value.to_string(),
		Value::Null => "-".to_string(),
		Value::Array(values) => format!("{} item(s)", values.len()),
		Value::Object(_) => "{...}".to_string(),
	}
}

fn infer_level(message: &str) -> &str {
	let upper = message.to_ascii_uppercase();
	for level in ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] {
		if upper.contains(level) {
			return level;
		}
	}
	"-"
}

// ── AWS EC2 ──────────────────────────────────────────────────────────────────

fn extract_aws_ec2_instances(root: &Value) -> Option<Vec<&Value>> {
	let reservations = root.get("Reservations")?.as_array()?;
	let mut instances = Vec::new();
	for res in reservations {
		let insts = res.get("Instances")?.as_array()?;
		for inst in insts {
			instances.push(inst);
		}
	}
	if instances.is_empty() {
		None
	} else {
		Some(instances)
	}
}

fn compact_aws_ec2_instances(instances: &[&Value]) -> String {
	let mut out = String::new();
	for inst in instances {
		let id = inst
			.get("InstanceId")
			.and_then(|v| v.as_str())
			.unwrap_or("?");
		let typ = inst
			.get("InstanceType")
			.and_then(|v| v.as_str())
			.unwrap_or("?");
		let state = inst
			.get("State")
			.and_then(|v| v.get("Name"))
			.and_then(|v| v.as_str())
			.unwrap_or("?");
		let ip = inst
			.get("PrivateIpAddress")
			.and_then(|v| v.as_str())
			.unwrap_or("-");
		let name = inst
			.get("Tags")
			.and_then(|v| v.as_array())
			.and_then(|tags| {
				tags.iter().find_map(|tag| {
					let key = tag.get("Key")?.as_str()?;
					if key == "Name" {
						tag.get("Value")?.as_str()
					} else {
						None
					}
				})
			})
			.unwrap_or("-");
		let _ = writeln!(out, "{id}\t{typ}\t{state}\t{ip}\t{name}");
	}
	if instances.len() > 1 {
		out.push('\n');
	}
	let _ = writeln!(out, "{} instance(s)", instances.len());
	out
}

// ── AWS CloudWatch ───────────────────────────────────────────────────────────

fn extract_aws_cloudwatch_events(root: &Value) -> Option<Vec<&Value>> {
	let events = root.get("events")?.as_array()?;
	if events.is_empty() {
		None
	} else {
		Some(events.iter().collect())
	}
}

fn epoch_ms_to_iso(ms: i64) -> String {
	let secs = ms / 1000;
	let sub_ms = (ms % 1000) as u32;
	let days_since_epoch = secs / 86400;
	let secs_of_day = secs % 86400;
	let hour = secs_of_day / 3600;
	let minute = (secs_of_day % 3600) / 60;
	let second = secs_of_day % 60;
	let total_days = days_since_epoch as i32;
	let (year, month, day) = civil_from_days(total_days + 719468);
	format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{sub_ms:03}Z")
}

const fn civil_from_days(z: i32) -> (i32, u32, u32) {
	let z = z as i64;
	let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
	let doe = (z - era * 146097) as u32;
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	let y = yoe as i64 + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	(y as i32, m, d)
}

fn compact_aws_cloudwatch_events(events: &[&Value]) -> String {
	let mut out = String::new();
	let mut count = 0usize;
	for event in events {
		let ts = event
			.get("timestamp")
			.and_then(serde_json::Value::as_i64)
			.map_or_else(|| "?".to_string(), epoch_ms_to_iso);
		let msg = event.get("message").and_then(|v| v.as_str()).unwrap_or("?");
		// Truncate long messages
		let msg = primitives::truncate_line(msg, MAX_LINE_CHARS);
		out.push_str(&ts);
		out.push('\t');
		out.push_str(&msg);
		out.push('\n');
		count += 1;
	}
	if count > 1 {
		out.push('\n');
	}
	let _ = writeln!(out, "{count} event(s)");
	out
}

// ── AWS DynamoDB
// ──────────────────────────────────────────────────────────────

fn extract_aws_dynamodb_items(root: &Value) -> Option<Vec<&serde_json::Map<String, Value>>> {
	if let Some(item) = root.get("Item").and_then(Value::as_object) {
		return Some(vec![item]);
	}
	let items = root.get("Items")?.as_array()?;
	let mut out = Vec::new();
	for item in items {
		if let Some(map) = item.as_object() {
			out.push(map);
		}
	}
	if out.is_empty() { None } else { Some(out) }
}

fn compact_aws_dynamodb_items(items: &[&serde_json::Map<String, Value>]) -> String {
	let mut out = String::new();
	for item in items.iter().take(40) {
		let mut first = true;
		for (key, value) in *item {
			if !first {
				out.push('\t');
			}
			first = false;
			out.push_str(key);
			out.push('=');
			push_dynamodb_value(&mut out, value);
		}
		out.push('\n');
	}
	if items.len() > 40 {
		let _ = writeln!(out, "[…{} items elided…]", items.len() - 40);
	}
	let _ = writeln!(out, "{} item(s)", items.len());
	out
}

fn push_dynamodb_value(out: &mut String, value: &Value) {
	let Some(map) = value.as_object() else {
		push_json_scalar(out, value);
		return;
	};
	if map.len() == 1 {
		if let Some(value) = map.get("S").and_then(Value::as_str) {
			out.push_str(value);
			return;
		}
		if let Some(value) = map.get("N").and_then(Value::as_str) {
			out.push_str(value);
			return;
		}
		if let Some(value) = map.get("BOOL").and_then(Value::as_bool) {
			out.push_str(if value { "true" } else { "false" });
			return;
		}
		if map.get("NULL").and_then(Value::as_bool) == Some(true) {
			out.push_str("null");
			return;
		}
		if let Some(values) = map.get("SS").and_then(Value::as_array) {
			push_json_array(out, values);
			return;
		}
		if let Some(values) = map.get("NS").and_then(Value::as_array) {
			push_json_array(out, values);
			return;
		}
		if let Some(values) = map.get("L").and_then(Value::as_array) {
			out.push('[');
			for (idx, value) in values.iter().enumerate() {
				if idx > 0 {
					out.push(',');
				}
				push_dynamodb_value(out, value);
			}
			out.push(']');
			return;
		}
		if let Some(values) = map.get("M").and_then(Value::as_object) {
			push_dynamodb_map(out, values);
			return;
		}
	}
	push_dynamodb_map(out, map);
}

fn push_dynamodb_map(out: &mut String, values: &serde_json::Map<String, Value>) {
	out.push('{');
	for (idx, (key, value)) in values.iter().enumerate() {
		if idx > 0 {
			out.push(',');
		}
		out.push_str(key);
		out.push(':');
		push_dynamodb_value(out, value);
	}
	out.push('}');
}

fn push_json_array(out: &mut String, values: &[Value]) {
	out.push('[');
	for (idx, value) in values.iter().enumerate() {
		if idx > 0 {
			out.push(',');
		}
		push_json_scalar(out, value);
	}
	out.push(']');
}

fn push_json_scalar(out: &mut String, value: &Value) {
	if let Some(value) = value.as_str() {
		out.push_str(value);
	} else {
		out.push_str(&value.to_string());
	}
}

fn filter_http_transfer(ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> String {
	if http_transfer_suppresses_progress(ctx) {
		input.to_string()
	} else {
		strip_transfer_progress(input)
	}
}

fn http_transfer_suppresses_progress(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.command
		.split_whitespace()
		.any(|token| match ctx.program {
			"curl" => {
				token == "--silent"
					|| token == "--no-progress-meter"
					|| token.starts_with('-') && !token.starts_with("--") && token.contains('s')
			},
			"wget" => {
				token == "--quiet"
					|| token.starts_with('-') && !token.starts_with("--") && token.contains('q')
			},
			_ => false,
		})
}

/// Returns `true` when the psql invocation requests machine-readable
/// (unaligned, tuples-only, or CSV) output that must not be truncated.
fn is_psql_machine_readable(command: &str) -> bool {
	command
		.split_whitespace()
		.any(|t| matches!(t, "-A" | "--no-align" | "-t" | "--tuples-only" | "--csv"))
}

fn filter_psql(input: &str, exit_code: i32) -> String {
	if input.trim().is_empty() {
		return String::new();
	}

	let compacted = if looks_like_psql_table(input) {
		compact_psql_table(input)
	} else if looks_like_psql_expanded(input) {
		compact_psql_expanded(input)
	} else {
		compact_jsonish_or_text(input, 120, 80, 40)
	};

	if exit_code == 0 {
		preserve_important_lines(input, &compacted)
	} else {
		preserve_important_lines(input, &head_tail_dedup(&compacted, 80, 40))
	}
}

fn strip_transfer_progress(input: &str) -> String {
	let mut out = String::new();
	for segment in input.split_inclusive('\n') {
		let line = if let Some(line) = segment.strip_suffix('\n') {
			line
		} else {
			segment
		};
		let line = if let Some(line) = line.strip_suffix('\r') {
			line
		} else {
			line
		};
		if is_transfer_progress_line(line) {
			continue;
		}
		out.push_str(segment);
	}
	out
}

fn is_transfer_progress_line(line: &str) -> bool {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return false;
	}
	if trimmed.starts_with("% Total") || trimmed.contains(" Dload ") && trimmed.contains(" Upload ")
	{
		return true;
	}
	if trimmed.starts_with("--") && trimmed.contains("://") {
		return true;
	}
	if trimmed.starts_with("Resolving ")
		|| trimmed.starts_with("Connecting to ")
		|| trimmed.starts_with("HTTP request sent")
		|| trimmed.starts_with("Length: ")
		|| trimmed.starts_with("Saving to:")
		|| trimmed.starts_with("Downloaded:")
	{
		return true;
	}
	if trimmed.contains("--:--:--") || trimmed.contains("100%[") {
		return true;
	}
	if trimmed.contains('%') && trimmed.contains('[') && trimmed.contains(']') {
		return true;
	}
	if trimmed.contains('%') && (trimmed.contains("K/s") || trimmed.contains("M/s")) {
		return true;
	}
	looks_like_wget_transfer_progress(trimmed)
}

fn looks_like_wget_transfer_progress(line: &str) -> bool {
	let mut parts = line.split_whitespace();
	let Some(offset) = parts.next() else {
		return false;
	};
	let has_offset = offset
		.strip_suffix('K')
		.or_else(|| offset.strip_suffix('M'))
		.is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()));
	if !has_offset {
		return false;
	}
	let mut saw_meter = false;
	let mut saw_percent = false;
	for part in parts {
		if part.chars().all(|ch| ch == '.') {
			saw_meter = true;
		}
		if part.ends_with('%') {
			let number = part.trim_end_matches('%');
			saw_percent = !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit());
		}
	}
	saw_meter && saw_percent
}

fn compact_jsonish_or_text(input: &str, max_lines: usize, head: usize, tail: usize) -> String {
	let line_compacted = compact_long_lines(input);
	if line_compacted.lines().count() <= max_lines {
		line_compacted
	} else {
		primitives::head_tail_lines(&line_compacted, head, tail)
	}
}

fn compact_long_lines(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let compacted = compact_line(line, MAX_LINE_CHARS);
		out.push_str(&compacted);
		out.push('\n');
	}
	out
}

fn compact_line(line: &str, max_chars: usize) -> String {
	let chars: Vec<char> = line.chars().collect();
	if chars.len() <= max_chars {
		return line.to_string();
	}
	let edge = max_chars / 2;
	let start: String = chars.iter().take(edge).collect();
	let end: String = chars.iter().skip(chars.len() - edge).collect();
	format!("{start}[…{}ch elided…]{end}", chars.len() - edge * 2)
}

fn looks_like_table(input: &str) -> bool {
	input.lines().any(|line| {
		let trimmed = line.trim();
		trimmed.starts_with('+') && trimmed.ends_with('+') && trimmed.contains('-')
	}) || input
		.lines()
		.any(|line| line.contains("---+---") || line.contains("-+-"))
}

fn looks_like_psql_table(input: &str) -> bool {
	input
		.lines()
		.any(|line| line.contains("---+---") || line.contains("-+-"))
		|| input.lines().any(|line| {
			let trimmed = line.trim();
			trimmed.starts_with('+') && trimmed.ends_with('+') && trimmed.contains('-')
		})
}

fn looks_like_psql_expanded(input: &str) -> bool {
	input
		.lines()
		.any(|line| is_psql_expanded_header(line.trim()))
}

fn is_psql_expanded_header(line: &str) -> bool {
	if !line.starts_with("-[ RECORD ") {
		return false;
	}
	let Some((_, suffix)) = line.split_once(" ]") else {
		return false;
	};
	!suffix.is_empty() && suffix.chars().all(|ch| ch == '-')
}

fn compact_delimited_table(input: &str, max_rows: usize) -> String {
	let mut out = Vec::new();
	let mut data_rows = 0usize;
	let mut saw_header = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_border_line(trimmed) {
			continue;
		}
		let normalized = if trimmed.contains('|') {
			normalize_pipe_row(trimmed)
		} else {
			trimmed.to_string()
		};
		if !saw_header {
			saw_header = true;
			out.push(normalized);
			continue;
		}
		data_rows += 1;
		if data_rows <= max_rows || is_important_line(trimmed) {
			out.push(normalized);
		}
	}
	if data_rows > max_rows {
		out.push(format!("[…{} rows elided…]", data_rows - max_rows));
	}
	join_lines(out)
}

fn compact_psql_table(input: &str) -> String {
	let mut out = Vec::new();
	let mut row_count_lines = Vec::new();
	let mut data_rows = 0usize;
	let mut saw_header = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_border_line(trimmed) {
			continue;
		}
		if is_psql_row_count(trimmed) {
			row_count_lines.push(trimmed.to_string());
			continue;
		}
		if is_important_line(trimmed) {
			out.push(trimmed.to_string());
			continue;
		}
		if trimmed.contains('|') {
			let normalized = normalize_pipe_row(trimmed);
			if !saw_header {
				saw_header = true;
				out.push(normalized);
				continue;
			}
			data_rows += 1;
			if data_rows <= MAX_PSQL_ROWS {
				out.push(normalized);
			}
		} else {
			out.push(trimmed.to_string());
		}
	}

	if data_rows > MAX_PSQL_ROWS {
		out.push(format!("[…{} rows elided…]", data_rows - MAX_PSQL_ROWS));
	}
	out.extend(row_count_lines);
	join_lines(out)
}

fn compact_psql_expanded(input: &str) -> String {
	let mut out = Vec::new();
	let mut current = Vec::new();
	let mut row_count_lines = Vec::new();
	let mut records = 0usize;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_psql_row_count(trimmed) {
			row_count_lines.push(trimmed.to_string());
			continue;
		}
		if is_psql_expanded_header(trimmed) {
			flush_record(&mut out, &mut current, records);
			records += 1;
			current.push(trimmed.to_string());
			continue;
		}
		if is_important_line(trimmed) && current.is_empty() {
			out.push(trimmed.to_string());
			continue;
		}
		if let Some((key, value)) = trimmed.split_once('|') {
			current.push(format!("{}={}", key.trim(), value.trim()));
		} else if current.is_empty() {
			out.push(trimmed.to_string());
		}
	}
	flush_record(&mut out, &mut current, records);
	if records > MAX_PSQL_ROWS {
		out.push(format!("[…{} records elided…]", records - MAX_PSQL_ROWS));
	}
	out.extend(row_count_lines);
	join_lines(out)
}

fn flush_record(out: &mut Vec<String>, current: &mut Vec<String>, records: usize) {
	if current.is_empty() {
		return;
	}
	if records <= MAX_PSQL_ROWS {
		out.push(current.join(" "));
	}
	current.clear();
}

fn normalize_pipe_row(line: &str) -> String {
	line
		.trim_matches('|')
		.split('|')
		.map(str::trim)
		.collect::<Vec<&str>>()
		.join("\t")
}

fn is_border_line(line: &str) -> bool {
	let trimmed = line.trim();
	!trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| matches!(ch, '+' | '-' | '=' | '|' | ' '))
		&& (trimmed.contains('-') || trimmed.contains('='))
}

fn is_psql_row_count(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with('(')
		&& trimmed.ends_with(')')
		&& trimmed.contains(" row")
		&& trimmed.chars().any(|ch| ch.is_ascii_digit())
}

fn preserve_important_lines(original: &str, compacted: &str) -> String {
	let mut out = Vec::new();
	for line in original.lines() {
		let trimmed = line.trim();
		if is_important_line(trimmed)
			&& !contains_line(&out, trimmed)
			&& !compacted.lines().any(|existing| existing.trim() == trimmed)
		{
			out.push(trimmed.to_string());
		}
	}
	if out.is_empty() {
		return compacted.to_string();
	}
	out.push(compacted.trim_end().to_string());
	join_lines(out)
}

fn is_important_line(line: &str) -> bool {
	let upper = line.trim_start().to_ascii_uppercase();
	upper.starts_with("ERROR")
		|| upper.starts_with("FATAL")
		|| upper.starts_with("PANIC")
		|| upper.starts_with("DETAIL")
		|| upper.starts_with("HINT")
		|| upper.starts_with("LINE ")
		|| upper.starts_with("SQLSTATE")
		|| upper.starts_with("AN ERROR OCCURRED")
		|| upper.contains("EXCEPTION")
}

fn contains_line(lines: &[String], needle: &str) -> bool {
	lines.iter().any(|line| line == needle)
}

fn head_tail_dedup(input: &str, head: usize, tail: usize) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), head, tail)
}

fn join_lines(lines: Vec<String>) -> String {
	if lines.is_empty() {
		String::new()
	} else {
		let mut out = lines.join("\n");
		out.push('\n');
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, cfg: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command: program, config: cfg }
	}

	fn ctx_command<'a>(
		program: &'a str,
		command: &'a str,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command, config: cfg }
	}

	fn aws_ctx<'a>(
		subcommand: &'a str,
		command: &'a str,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "aws", subcommand: Some(subcommand), command, config: cfg }
	}

	#[test]
	fn strips_curl_progress_and_preserves_long_multiline_body() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("curl", &cfg);
		let long_line = format!("{{\"payload\":\"{}\"}}", "x".repeat(620));
		let mut body = String::new();
		for idx in 0..130 {
			body.push_str("{\"idx\":");
			body.push_str(&idx.to_string());
			body.push_str(",\"ok\":true}\n");
		}
		body.push_str(&long_line);
		body.push('\n');
		let input = format!(
			"  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n100  \
			 1234  100  1234    0     0  9999      0 --:--:-- --:--:-- --:--:-- 9999\n{body}"
		);
		let out = filter(&ctx, &input, 0);
		assert!(!out.text.contains("% Total"));
		assert!(!out.text.contains("--:--:--"));
		assert_eq!(out.text, body);
	}

	#[test]
	fn strips_wget_progress_and_preserves_body_percent_line() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("wget", &cfg);
		let input = "--2026-04-24--  https://example.test/data.json\nResolving example.test... \
		             127.0.0.1\n     0K .......... .......... 50% 1.2M 0s\n    20K .......... \
		             .......... 100% 2.0M=0.1s\n100% real body\n[{\"id\":1}]\n";
		let expected = "100% real body\n[{\"id\":1}]\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, expected);
	}

	#[test]
	fn curl_silent_preserves_body_lines_that_look_like_progress() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx_command("curl", "curl -s https://example.test/body", &cfg);
		let input = "% Total legitimate response header\n100%[body]\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn wget_quiet_preserves_body_lines_that_look_like_progress() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx_command("wget", "wget -qO- https://example.test/body", &cfg);
		let input = "--body marker with https://example.test\n100%[body]\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn preserves_psql_table_row_count_and_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("psql", &cfg);
		let input = " id | name\n----+------\n 1  | alice\n 2  | bob\nERROR: duplicate key value \
		             violates unique constraint\n(2 rows)\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("id\tname"));
		assert!(out.text.contains("1\talice"));
		assert!(
			out.text
				.contains("ERROR: duplicate key value violates unique constraint")
		);
		assert!(out.text.contains("(2 rows)"));
	}

	#[test]
	fn compacts_psql_expanded_dashed_records_and_preserves_footer() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("psql", &cfg);
		let input = "-[ RECORD 1 ]-----\nid | 1\nname | alice\n-[ RECORD 2 ]-----\nid | 2\nname | \
		             bob\n(2 rows)\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("-[ RECORD 1 ]----- id=1 name=alice"));
		assert!(out.text.contains("-[ RECORD 2 ]----- id=2 name=bob"));
		assert!(out.text.contains("(2 rows)"));
	}

	#[test]
	fn preserves_long_aws_json_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let mut input = String::new();
		for idx in 0..160 {
			input.push_str("{\"InstanceId\":\"i-");
			let id = idx.to_string();
			for _ in id.len()..4 {
				input.push('0');
			}
			input.push_str(&id);
			input.push_str("\"}\n");
		}
		let out = filter(&ctx, &input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn aws_s3_cp_to_stdout_preserves_body() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 cp s3://bucket/file.json -", &cfg);
		let input = "{\"key\": \"value\", \"% Total\": 100}\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed, "stdout pipe body must not be rewritten: {:?}", out.text);
	}

	#[test]
	fn aws_s3_cp_to_stdout_with_trailing_options_preserves_body() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 cp s3://bucket/file.json - --request-payer requester", &cfg);
		let input = "{\"key\": \"value\", \"% Total\": 100}\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed, "stdout pipe body must not be rewritten: {:?}", out.text);
	}

	#[test]
	fn compacts_ec2_describe_instances_json() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let input = r#"{
    "Reservations": [
        {
            "Groups": [],
            "Instances": [
                {
                    "InstanceId": "i-1234567890abcdef0",
                    "InstanceType": "t2.micro",
                    "State": { "Code": 16, "Name": "running" },
                    "PrivateIpAddress": "10.0.0.1",
                    "Tags": [
                        { "Key": "Name", "Value": "web-server" },
                        { "Key": "env", "Value": "prod" }
                    ]
                },
                {
                    "InstanceId": "i-abcdef1234567890",
                    "InstanceType": "t3.large",
                    "State": { "Code": 80, "Name": "stopped" },
                    "PrivateIpAddress": "10.0.0.2",
                    "Tags": []
                }
            ],
            "OwnerId": "123456789012",
            "ReservationId": "r-1234567890abcdef0"
        }
    ]
}"#;
		let out = filter(&ctx, input, 0);
		assert!(
			out.text
				.contains("i-1234567890abcdef0\tt2.micro\trunning\t10.0.0.1\tweb-server")
		);
		assert!(
			out.text
				.contains("i-abcdef1234567890\tt3.large\tstopped\t10.0.0.2\t-")
		);
		assert!(out.text.contains("2 instance(s)"));
	}

	#[test]
	fn compacts_cloudwatch_log_events_json() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let input = r#"{
    "events": [
        {
            "timestamp": 1705310100000,
            "message": "START RequestId: abc123 Version: $LATEST",
            "ingestionTime": 1705310101000
        },
        {
            "timestamp": 1705310101000,
            "message": "END RequestId: abc123",
            "ingestionTime": 1705310102000
        }
    ],
    "nextForwardToken": "f/123",
    "nextBackwardToken": "b/123"
}"#;
		let out = filter(&ctx, input, 0);
		assert!(
			out.text
				.contains("START RequestId: abc123 Version: $LATEST")
		);
		assert!(out.text.contains("END RequestId: abc123"));
		assert!(out.text.contains("2 event(s)"));
	}

	#[test]
	fn compacts_dynamodb_typed_json() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let input = r#"{
    "Items": [
        {
            "pk": { "S": "user#1" },
            "age": { "N": "42" },
            "active": { "BOOL": true },
            "tags": { "SS": ["a", "b"] },
            "meta": { "M": { "city": { "S": "Paris" } } }
        }
    ],
    "Count": 1
}"#;
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("pk=user#1"));
		assert!(out.text.contains("age=42"));
		assert!(out.text.contains("active=true"));
		assert!(out.text.contains("tags=[a,b]"));
		const META_ATTR: &str = "meta={city:Paris}";
		assert!(out.text.contains(META_ATTR));
		assert!(out.text.contains("1 item(s)"));
	}

	#[test]
	fn aws_json_parse_failure_falls_back_to_progress_strip() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		// Invalid JSON should fall back to existing behavior
		let input = "{invalid json here}\nsome output\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn aws_unknown_json_uses_generic_safe_table() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let input =
			r#"{"Things": [{"Name": "alpha", "Status": "ready", "Password": "LEAK_SENTINEL"}]}"#;
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("Name\tStatus"));
		assert!(out.text.contains("alpha\tready"));
		assert!(!out.text.contains("LEAK_SENTINEL"));
	}

	#[test]
	fn compacts_new_aws_service_shapes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let cases = [
			(
				"sts",
				"aws sts get-caller-identity",
				r#"{"UserId":"AIDA","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/alice","ResponseMetadata":{"RequestId":"LEAK_SENTINEL"}}"#,
				"account=123456789012 arn=arn:aws:iam::123456789012:user/alice user-id=AIDA",
			),
			(
				"s3api",
				"aws s3api list-buckets",
				r#"{"Buckets":[{"Name":"builds","CreationDate":"2026-05-27T00:00:00Z"}]}"#,
				"builds\t2026-05-27T00:00:00Z",
			),
			(
				"lambda",
				"aws lambda list-functions",
				r#"{"Functions":[{"FunctionName":"api","Runtime":"nodejs20.x","MemorySize":256,"LastModified":"today","Environment":{"Variables":{"SECRET":"LEAK_SENTINEL"}}}]}"#,
				"api\tnodejs20.x\t256\ttoday",
			),
			(
				"iam",
				"aws iam list-roles",
				r#"{"Roles":[{"RoleName":"deploy","Arn":"arn:role/deploy","CreateDate":"today","AssumeRolePolicyDocument":"LEAK_SENTINEL"}]}"#,
				"deploy\tarn:role/deploy\ttoday",
			),
			(
				"logs",
				"aws logs get-log-events",
				r#"{"events":[{"timestamp":1,"message":"ERROR failed"}]}"#,
				"1\tERROR\tERROR failed",
			),
			(
				"ecs",
				"aws ecs list-clusters",
				r#"{"clusterArns":["arn:aws:ecs:cluster/default"]}"#,
				"arn:aws:ecs:cluster/default",
			),
			(
				"rds",
				"aws rds describe-db-instances",
				r#"{"DBInstances":[{"DBInstanceIdentifier":"db1","Engine":"postgres","DBInstanceStatus":"available","Endpoint":{"Address":"db.local"}}]}"#,
				"db1\tpostgres\tavailable\tdb.local",
			),
			(
				"cloudformation",
				"aws cloudformation describe-stacks",
				r#"{"Stacks":[{"StackName":"app","StackStatus":"CREATE_COMPLETE","LastUpdatedTime":"today"}]}"#,
				"app\tCREATE_COMPLETE\ttoday",
			),
			(
				"eks",
				"aws eks describe-cluster",
				r#"{"cluster":{"name":"prod","status":"ACTIVE","version":"1.30","endpoint":"https://eks"}}"#,
				"prod\tACTIVE\t1.30\thttps://eks",
			),
			(
				"sqs",
				"aws sqs list-queues",
				r#"{"QueueUrls":["https://sqs.local/q"]}"#,
				"https://sqs.local/q",
			),
			(
				"secretsmanager",
				"aws secretsmanager list-secrets",
				r#"{"SecretList":[{"Name":"db","ARN":"arn:secret:db","LastChangedDate":"today","SecretString":"LEAK_SENTINEL"}]}"#,
				"db\tarn:secret:db\ttoday",
			),
		];
		for (service, command, input, expected) in cases {
			let ctx = aws_ctx(service, command, &cfg);
			let out = filter(&ctx, input, 0);
			assert!(out.text.contains(expected), "{service}: {}", out.text);
			assert!(!out.text.contains("LEAK_SENTINEL"), "{service}");
			assert_output_pure(&out.text);
		}
	}

	#[test]
	fn compacts_s3_text_ls() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 ls", &cfg);
		let out = filter(&ctx, "2026-05-27 01:02:03 builds\n2026-05-27 01:03:04 logs\n", 0);
		assert!(out.text.contains("builds\t2026-05-27 01:02:03"));
		assert_output_pure(&out.text);
	}

	#[test]
	fn s3_ls_summarize_footer_is_not_parsed_as_row() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 ls --summarize s3://b/", &cfg);
		// `--summarize` appends `Total Objects:`/`Total Size:` footers that lack a
		// real date/time prefix; they must not be reshaped into bogus object rows or
		// silently dropped.
		let input = "2026-05-27 01:02:03 100 builds\n\nTotal Objects: 1\nTotal Size: 100\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("builds\t2026-05-27 01:02:03"), "{:?}", out.text);
		assert!(out.text.contains("Total Objects: 1"), "{:?}", out.text);
		assert!(out.text.contains("Total Size: 100"), "{:?}", out.text);
	}

	#[test]
	fn s3_ls_common_prefix_with_spaces_is_preserved() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 ls s3://b/", &cfg);
		// `PRE` common-prefix names can contain spaces; the full name must survive
		// rather than being truncated to the first token.
		let out = filter(&ctx, "                           PRE my folder/\n", 0);
		assert!(out.text.contains("my folder"), "{:?}", out.text);
	}

	#[test]
	fn s3_cp_output_is_not_parsed_as_listing() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = aws_ctx("s3", "aws s3 cp ./file.txt s3://bucket/file.txt", &cfg);
		// `aws s3 cp` emits a transfer result line, not a listing; it must pass
		// through untouched rather than be reshaped into a bucket/date table.
		let input = "upload: ./file.txt to s3://bucket/file.txt\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn malformed_new_aws_service_json_passthroughs() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for service in [
			"sts",
			"s3",
			"lambda",
			"iam",
			"logs",
			"ecs",
			"rds",
			"cloudformation",
			"eks",
			"sqs",
			"secretsmanager",
		] {
			let ctx = aws_ctx(service, "aws service op", &cfg);
			let input = "{not-json";
			let out = filter(&ctx, input, 0);
			assert_eq!(out.text, input, "{service}");
		}
	}

	#[test]
	fn sensitive_aws_keys_never_leak_from_generic() {
		let mut fields = String::new();
		for key in SENSITIVE_AWS_KEYS {
			let _ = write!(fields, r#""{key}":"LEAK_SENTINEL","#);
		}
		let input = format!(r#"{{"Unknowns":[{{"Name":"safe",{fields}"Status":"ok"}}]}}"#);
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("safe"));
		assert!(!out.text.contains("LEAK_SENTINEL"));
	}

	fn assert_output_pure(out: &str) {
		assert!(!out.contains('\x1b'));
		assert!(!out.contains("&&"));
		assert!(!out.contains(';'));
		assert!(!out.contains('`'));
	}
}
