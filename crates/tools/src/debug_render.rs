//! Bounded model projections for debugger snapshots.

use std::fmt::Write as _;

use omp_core::{Str, encoding::base64};
use omp_tool::{Diag, DiagKind, Unit};
use serde_json::Value;
use xutf::{Encoding as _, Utf8};

use crate::{debug::Action, render::truncate::truncate_head_bytes};

const MAX_ROWS: usize = 100;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;

/// One bounded projection and its harness diagnostics.
pub struct Rendered {
	/// Model-facing result text.
	pub text:  Str,
	/// Structured notices produced while bounding the projection.
	pub diags: Vec<Diag>,
}

impl Rendered {
	const fn text(text: Str) -> Self {
		Self { text, diags: Vec::new() }
	}
}

/// Formats one structured debug result and returns its bounding diagnostics.
pub fn render(action: Action, data: &Value) -> Rendered {
	match action {
		Action::Sessions => sessions(data),
		Action::Launch => session_summary(data, "Debug session launched."),
		Action::Attach => session_summary(data, "Debug session attached."),
		Action::StackTrace => stack(data),
		Action::Threads => rows(data, "threads", "ID\tNAME", &["id", "name"]),
		Action::Scopes => rows(data, "scopes", "NAME\tREFERENCE\tEXPENSIVE", &[
			"name",
			"variablesReference",
			"expensive",
		]),
		Action::Variables => rows(data, "variables", "NAME\tTYPE\tVALUE\tREFERENCE", &[
			"name",
			"type",
			"value",
			"variablesReference",
		]),
		Action::SetBreakpoint | Action::RemoveBreakpoint => breakpoint_rows(data),
		Action::SetInstructionBreakpoint | Action::RemoveInstructionBreakpoint => {
			rows(data, "breakpoints", "VERIFIED\tADDRESS\tMESSAGE", &[
				"verified",
				"instructionReference",
				"message",
			])
		},
		Action::SetDataBreakpoint | Action::RemoveDataBreakpoint => {
			rows(data, "breakpoints", "VERIFIED\tID\tMESSAGE", &["verified", "id", "message"])
		},
		Action::DataBreakpointInfo => data_breakpoint_info(data),
		Action::Evaluate => evaluation(data),
		Action::WriteMemory => memory_write(data),
		Action::Modules => rows(data, "modules", "ID\tNAME\tPATH", &["id", "name", "path"]),
		Action::LoadedSources => rows(data, "sources", "NAME\tPATH", &["name", "path"]),
		Action::CustomRequest => custom(data),
		Action::ReadMemory => memory(data),
		Action::Disassemble => disassembly(data),
		Action::Output => output(data),
		Action::Terminate if data.get("terminated") == Some(&Value::Bool(false)) => {
			Rendered::text(Str::new_static("No debug session to terminate."))
		},
		Action::Terminate => session_summary(data, "Debug session terminated."),
		Action::Continue | Action::Pause | Action::StepOver | Action::StepIn | Action::StepOut => {
			stop(data)
		},
	}
}

fn session_summary(data: &Value, outcome: &str) -> Rendered {
	let session = data.get("session").unwrap_or(&Value::Null);
	let stop = session.get("stop").unwrap_or(&Value::Null);
	let frame = session
		.get("frame")
		.or_else(|| stop.get("frame"))
		.unwrap_or(&Value::Null);
	let source = frame.get("source").unwrap_or(&Value::Null);
	let mut text = String::new();
	let _ = writeln!(text, "Session: {}", string(session, "id"));
	let _ = writeln!(text, "Adapter: {}", string(session, "adapter"));
	let _ = writeln!(
		text,
		"State: {}",
		session
			.get("status")
			.or_else(|| session.get("state"))
			.and_then(Value::as_str)
			.unwrap_or_default()
	);
	if let Some(pid) = session.get("pid").and_then(Value::as_u64) {
		let _ = writeln!(text, "Process: {pid}");
	}
	if !string(source, "path").is_empty() {
		let _ = writeln!(
			text,
			"Location: {}:{}:{}",
			string(source, "path"),
			frame
				.get("line")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			frame
				.get("column")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
		);
	}
	text.push_str(outcome);
	finish(text)
}

fn sessions(data: &Value) -> Rendered {
	let rows = data.as_array().map(Vec::as_slice).unwrap_or_default();
	if rows.is_empty() {
		return Rendered::text(Str::new_static("No debug sessions."));
	}
	let mut text =
		String::from("SESSION\tADAPTER\tSTATE\tREVISION\tPROCESS\tADAPTER_PROCESS\tCWD\tPROGRAM\n");
	for row in rows.iter().take(MAX_ROWS) {
		let _ = writeln!(
			text,
			"{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
			string(row, "id"),
			string(row, "adapter"),
			row.get("status")
				.or_else(|| row.get("state"))
				.and_then(Value::as_str)
				.unwrap_or_default(),
			row.get("revision")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			row.get("processId")
				.or_else(|| row.get("pid"))
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			row.get("adapterProcessId")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			string(row, "cwd"),
			string(row, "program"),
		);
	}
	finish_with_diag(text, row_limit_diag(rows.len()))
}

fn stop(data: &Value) -> Rendered {
	let mut text = String::new();
	let state = string(data, "state");
	let thread_id = data
		.get("thread_id")
		.or_else(|| data.get("threadId"))
		.and_then(Value::as_i64)
		.unwrap_or_default();
	if data.get("timed_out").and_then(Value::as_bool) == Some(true) {
		let _ = writeln!(text, "Program is still running (thread {thread_id}).");
		text.push_str("Use pause to interrupt and inspect state.\n");
	} else if matches!(state, "terminated" | "exited") {
		text.push_str("Program terminated.\n");
	} else {
		let _ = writeln!(text, "{state}: {} (thread {thread_id})", string(data, "reason"));
	}
	if let Some(frame) = data.get("frame") {
		let source = frame
			.get("source")
			.and_then(|source| source.get("path"))
			.and_then(Value::as_str)
			.unwrap_or("<unknown>");
		let _ = writeln!(
			text,
			"#{} {} at {}:{}:{}",
			frame.get("id").and_then(Value::as_i64).unwrap_or_default(),
			string(frame, "name"),
			source,
			frame
				.get("line")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			frame
				.get("column")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
		);
	}
	finish(text)
}

fn stack(data: &Value) -> Rendered {
	let rows = data
		.get("stackFrames")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let mut text = String::from("FRAME\tNAME\tSOURCE\tLINE:COLUMN\n");
	for frame in rows.iter().take(MAX_ROWS) {
		let source = frame
			.get("source")
			.and_then(|source| source.get("path"))
			.and_then(Value::as_str)
			.unwrap_or("<unknown>");
		let _ = writeln!(
			text,
			"{}\t{}\t{}\t{}:{}",
			frame.get("id").and_then(Value::as_i64).unwrap_or_default(),
			string(frame, "name"),
			source,
			frame
				.get("line")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			frame
				.get("column")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
		);
	}
	finish_with_diag(text, row_limit_diag(rows.len()))
}

fn rows(data: &Value, key: &str, header: &str, fields: &[&str]) -> Rendered {
	let rows = data
		.get(key)
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let mut text = String::new();
	text.push_str(header);
	text.push('\n');
	for row in rows.iter().take(MAX_ROWS) {
		for (index, field) in fields.iter().enumerate() {
			if index > 0 {
				text.push('\t');
			}
			let value = row.get(*field).unwrap_or(&Value::Null);
			let value = value
				.as_str()
				.map_or_else(|| value.to_string(), str::to_owned);
			text.push_str(&value.replace(['\r', '\n', '\t'], " "));
		}
		text.push('\n');
	}
	finish_with_diag(text, row_limit_diag(rows.len()))
}

fn breakpoint_rows(data: &Value) -> Rendered {
	let key = if data.get("breakpoints").is_some() {
		"breakpoints"
	} else {
		"functionBreakpoints"
	};
	rows(data, key, "VERIFIED\tLINE\tMESSAGE", &["verified", "line", "message"])
}

fn custom(data: &Value) -> Rendered {
	let command = string(data, "command");
	let body = data.get("body").unwrap_or(&Value::Null);
	finish(format!(
		"{command} response:\n{}",
		serde_json::to_string_pretty(body).unwrap_or_default()
	))
}

fn data_breakpoint_info(data: &Value) -> Rendered {
	let mut text = String::new();
	let _ = writeln!(text, "Data id: {}", string(data, "dataId"));
	let _ = writeln!(text, "Description: {}", string(data, "description"));
	if let Some(types) = data.get("accessTypes").and_then(Value::as_array) {
		let values = types
			.iter()
			.filter_map(Value::as_str)
			.collect::<Vec<_>>()
			.join(", ");
		let _ = writeln!(text, "Access types: {values}");
	}
	finish(text)
}

fn evaluation(data: &Value) -> Rendered {
	let result = data
		.get("result")
		.and_then(Value::as_str)
		.unwrap_or_default();
	let kind = data.get("type").and_then(Value::as_str).unwrap_or_default();
	let reference = data
		.get("variablesReference")
		.and_then(Value::as_i64)
		.unwrap_or_default();
	finish(format!("{result}\nType: {kind}\nReference: {reference}\n"))
}

fn memory_write(data: &Value) -> Rendered {
	let bytes = data.get("bytesWritten").and_then(Value::as_u64);
	let offset = data.get("offset").and_then(Value::as_i64);
	let mut text = String::from("Memory write completed.");
	if let Some(bytes) = bytes {
		let _ = write!(text, "\nBytes written: {bytes}");
	}
	if let Some(offset) = offset {
		let _ = write!(text, "\nOffset: {offset}");
	}
	finish(text)
}

fn memory(data: &Value) -> Rendered {
	let address = data.get("address").and_then(Value::as_str).unwrap_or("0");
	let encoded = data.get("data").and_then(Value::as_str).unwrap_or_default();
	let Ok(bytes) = base64::decode(encoded).into_vec() else {
		return Rendered::text(Str::from("memory response contained invalid base64"));
	};
	let mut text = String::new();
	for (line, chunk) in bytes.chunks(16).take(MAX_ROWS).enumerate() {
		let _ = write!(text, "{}+{:04x}  ", address, line * 16);
		for byte in chunk {
			let _ = write!(text, "{byte:02x} ");
		}
		for _ in chunk.len()..16 {
			text.push_str("   ");
		}
		text.push(' ');
		for byte in chunk {
			text.push(if byte.is_ascii_graphic() || *byte == b' ' {
				char::from(*byte)
			} else {
				'.'
			});
		}
		text.push('\n');
	}
	let diag = (bytes.len() > MAX_ROWS * 16).then(|| {
		Diag::info(DiagKind::OutputBounded, "Debug memory was bounded")
			.omitted((bytes.len() - MAX_ROWS * 16) as u64, Unit::Bytes)
	});
	finish_with_diag(text, diag)
}

fn disassembly(data: &Value) -> Rendered {
	let rows = data
		.get("instructions")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let mut text = String::from("ADDRESS\tBYTES\tINSTRUCTION\tSOURCE\n");
	for row in rows.iter().take(MAX_ROWS) {
		let source = row
			.get("location")
			.and_then(|location| location.get("path"))
			.and_then(Value::as_str)
			.unwrap_or_default();
		let _ = writeln!(
			text,
			"{}\t{}\t{}\t{}:{}",
			string(row, "address"),
			string(row, "instructionBytes"),
			string(row, "instruction"),
			source,
			row.get("line").and_then(Value::as_u64).unwrap_or_default(),
		);
	}
	finish_with_diag(text, row_limit_diag(rows.len()))
}

fn output(data: &Value) -> Rendered {
	let value = data
		.get("output")
		.and_then(Value::as_str)
		.unwrap_or_else(|| data.as_str().unwrap_or_default());
	if value.len() <= MAX_OUTPUT_BYTES {
		return Rendered::text(Str::new(value));
	}
	let start = value.len() - MAX_OUTPUT_BYTES;
	let start = {
		let mut remaining = value.as_bytes();
		let mut boundary = 0;
		while boundary < start {
			Utf8::decode(&mut remaining);
			boundary = value.len() - remaining.len();
		}
		boundary
	};
	Rendered {
		text:  Str::from(&value[start..]),
		diags: vec![
			Diag::info(DiagKind::OutputBounded, "Older debug output was bounded")
				.omitted(start as u64, Unit::Bytes),
		],
	}
}

fn finish(text: String) -> Rendered {
	finish_with_diag(text, None)
}

fn finish_with_diag(mut text: String, diag: Option<Diag>) -> Rendered {
	let mut diags = Vec::new();
	diags.extend(diag);
	if text.len() > MAX_OUTPUT_BYTES {
		let original_len = text.len();
		text = truncate_head_bytes(&text, MAX_OUTPUT_BYTES).text.to_owned();
		diags.push(
			Diag::info(DiagKind::OutputBounded, "Semantic debug projection was bounded")
				.omitted((original_len - text.len()) as u64, Unit::Bytes),
		);
	}
	Rendered { text: Str::from(text), diags }
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
	value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn row_limit_diag(count: usize) -> Option<Diag> {
	(count > MAX_ROWS).then(|| {
		Diag::info(DiagKind::OutputBounded, "Debug rows were bounded")
			.omitted((count - MAX_ROWS) as u64, Unit::Rows)
	})
}
