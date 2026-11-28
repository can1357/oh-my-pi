use std::io::{self, BufRead, Read, Write};

use serde::{Deserialize, Serialize};

pub const MAX_INBOUND_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum V8Inbound {
	Run {
		#[serde(rename = "runId")]
		run_id:                String,
		code:                  String,
		filename:              String,
		#[serde(rename = "suppressFinalExpr", default)]
		suppress_final_expr:   bool,
		#[serde(rename = "emitCompletionValue", default)]
		emit_completion_value: bool,
	},
	ToolReply {
		id:    String,
		ok:    bool,
		#[serde(default)]
		value: Option<serde_json::Value>,
		#[serde(default)]
		error: Option<V8ErrorPayload>,
	},
	Cancel {
		#[serde(rename = "runId")]
		run_id: String,
	},
	Close,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum BridgeOp {
	Tool {
		name: String,
		args: Box<serde_json::value::RawValue>,
	},
	Read {
		path:    String,
		#[serde(skip_serializing_if = "Option::is_none")]
		options: Option<serde_json::Value>,
	},
	Write {
		path:     String,
		data:     String,
		encoding: String,
	},
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum V8Outbound {
	Ready,
	Text {
		#[serde(rename = "runId")]
		run_id: String,
		chunk:  String,
	},
	Display {
		#[serde(rename = "runId")]
		run_id: String,
		output: Box<serde_json::value::RawValue>,
	},
	BridgeCall {
		id:     String,
		#[serde(rename = "runId")]
		run_id: String,
		#[serde(flatten)]
		op:     BridgeOp,
	},
	Result {
		#[serde(rename = "runId")]
		run_id: String,
		ok:     bool,
		#[serde(skip_serializing_if = "Option::is_none")]
		error:  Option<V8ErrorPayload>,
	},
	Closed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct V8ErrorPayload {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name:    Option<String>,
	pub message: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub stack:   Option<String>,
}

impl V8ErrorPayload {
	pub fn new(message: impl Into<String>) -> Self {
		Self { message: message.into(), ..Default::default() }
	}

	pub fn named(name: impl Into<String>, message: impl Into<String>) -> Self {
		Self { name: Some(name.into()), message: message.into(), stack: None }
	}

	pub fn abort(message: impl Into<String>) -> Self {
		Self::named("AbortError", message)
	}
}

pub fn read_inbound_frame<R: BufRead>(
	reader: &mut R,
	buf: &mut Vec<u8>,
) -> Result<Option<V8Inbound>, String> {
	loop {
		buf.clear();
		let mut limited = Read::take(&mut *reader, (MAX_INBOUND_LINE_BYTES + 1) as u64);
		let read = limited
			.read_until(b'\n', buf)
			.map_err(|err| format!("stdin read error: {err}"))?;
		if read == 0 {
			return Ok(None);
		}
		if buf.len() > MAX_INBOUND_LINE_BYTES {
			return Err("inbound frame exceeded 16 MiB limit".to_string());
		}
		let trimmed = buf.trim_ascii();
		if trimmed.is_empty() {
			continue;
		}
		return serde_json::from_slice::<V8Inbound>(trimmed)
			.map(Some)
			.map_err(|err| format!("malformed inbound JSON frame: {err}"));
	}
}

pub fn write_outbound_frame<W: Write>(writer: &mut W, msg: &V8Outbound) -> io::Result<()> {
	serde_json::to_writer(&mut *writer, msg).map_err(io::Error::other)?;
	writer.write_all(b"\n")?;
	writer.flush()
}
