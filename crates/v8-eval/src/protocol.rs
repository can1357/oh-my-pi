use std::io::{self, BufRead, Read, Write};

use serde::{Deserialize, Serialize};

pub const MAX_INBOUND_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum V8Inbound {
	Init,
	Run {
		#[serde(rename = "runId")]
		run_id:                String,
		code:                  String,
		filename:              String,
		#[serde(rename = "finalExprSuppressed", default)]
		final_expr_suppressed: bool,
		#[serde(rename = "asyncWrapped", default)]
		async_wrapped:         bool,
		#[serde(rename = "finalExprReturned", default)]
		final_expr_returned:   Option<bool>,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
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
		output: serde_json::Value,
	},
	ToolCall {
		id:     String,
		#[serde(rename = "runId")]
		run_id: String,
		name:   String,
		args:   serde_json::Value,
	},
	UrlRead {
		id:      String,
		#[serde(rename = "runId")]
		run_id:  String,
		path:    String,
		#[serde(skip_serializing_if = "Option::is_none")]
		options: Option<ReadOptions>,
	},
	UrlWrite {
		id:       String,
		#[serde(rename = "runId")]
		run_id:   String,
		path:     String,
		data:     String,
		encoding: WriteEncoding,
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

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ReadOptions {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub offset: Option<i64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub limit:  Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteEncoding {
	Utf8,
	Base64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct V8ErrorPayload {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name:          Option<String>,
	pub message:       String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub stack:         Option<String>,
	#[serde(rename = "isAbort", skip_serializing_if = "Option::is_none")]
	pub is_abort:      Option<bool>,
	#[serde(rename = "isToolError", skip_serializing_if = "Option::is_none")]
	pub is_tool_error: Option<bool>,
}

impl V8ErrorPayload {
	pub fn new(message: impl Into<String>) -> Self {
		Self {
			name:          None,
			message:       message.into(),
			stack:         None,
			is_abort:      None,
			is_tool_error: None,
		}
	}
}

pub enum ReadFrameError {
	Eof,
	TooLarge,
	Io(io::Error),
	Json(serde_json::Error),
}

pub fn read_inbound_frame<R: BufRead>(reader: &mut R) -> Result<V8Inbound, ReadFrameError> {
	loop {
		let mut buf = Vec::new();
		let mut limited = Read::take(&mut *reader, (MAX_INBOUND_LINE_BYTES + 1) as u64);
		let read = limited
			.read_until(b'\n', &mut buf)
			.map_err(ReadFrameError::Io)?;
		if read == 0 {
			return Err(ReadFrameError::Eof);
		}
		if buf.len() > MAX_INBOUND_LINE_BYTES {
			return Err(ReadFrameError::TooLarge);
		}
		let line = String::from_utf8_lossy(&buf);
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		return serde_json::from_str::<V8Inbound>(trimmed).map_err(ReadFrameError::Json);
	}
}

pub fn write_outbound_frame<W: Write>(writer: &mut W, msg: &V8Outbound) -> io::Result<()> {
	serde_json::to_writer(&mut *writer, msg).map_err(io::Error::other)?;
	writer.write_all(b"\n")?;
	writer.flush()
}
