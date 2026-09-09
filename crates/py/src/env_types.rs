//! Typed Python values returned by the Environment DATA plane.

use pyo3::{
	IntoPyObject, IntoPyObjectExt,
	basic::CompareOp,
	exceptions::PyValueError,
	prelude::*,
	types::{PyAny, PyBytes},
};

use crate::bindings::PyEnvPath;

macro_rules! py_record {
	($rust:ident, $name:literal, $( $field:ident ),+ $(,)? $(; $($method:tt)*)?) => {
		#[pyclass(name = $name, frozen, module = "_omp")]
		#[derive(Debug)]
		pub struct $rust { $(pub(crate) $field: Py<PyAny>,)+ }
		#[pymethods]
		impl $rust {
			#[new]
			const fn new($( $field: Py<PyAny> ),+) -> Self { Self { $( $field, )+ } }
			$(#[getter] fn $field(&self, py: Python<'_>) -> Py<PyAny> { self.$field.clone_ref(py) })+
			fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
				let values = [$(format!("{}={}", stringify!($field), self.$field.bind(py).repr()?.to_str()?)),+];
				Ok(format!("{}({})", $name, values.join(", ")))
			}
			fn __richcmp__(&self, other: &Bound<'_, PyAny>, op: CompareOp, py: Python<'_>) -> PyResult<bool> {
				let Ok(other) = other.cast::<Self>() else { return Ok(matches!(op, CompareOp::Ne)); };
				let other = other.borrow();
				let equal = true $(&& self.$field.bind(py).eq(other.$field.bind(py))?)+;
				match op { CompareOp::Eq => Ok(equal), CompareOp::Ne => Ok(!equal), _ => Err(PyValueError::new_err("record values only support equality")) }
			}
			$($($method)*)?
		}
	};
}

#[pyclass(frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
	#[pyo3(get)]
	pub(crate) sequence:     u64,
	pub(crate) content_hash: Vec<u8>,
}
#[pymethods]
impl Revision {
	#[new]
	pub(crate) const fn new(sequence: u64, content_hash: Vec<u8>) -> Self {
		Self { sequence, content_hash }
	}

	#[getter]
	fn content_hash<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
		PyBytes::new(py, &self.content_hash)
	}

	#[getter]
	fn hex(&self) -> String {
		self
			.content_hash
			.iter()
			.map(|byte| format!("{byte:02x}"))
			.collect()
	}

	fn __repr__(&self) -> String {
		format!("Revision(sequence={}, content_hash=b'{}')", self.sequence, self.hex())
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self == other,
			CompareOp::Ne => self != other,
			_ => false,
		}
	}
}

#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
pub struct PathMeta {
	pub(crate) path:        Py<PyEnvPath>,
	pub(crate) kind:        Py<PyAny>,
	pub(crate) byte_length: u64,
	pub(crate) read_only:   Option<bool>,
	pub(crate) executable:  Option<bool>,
	pub(crate) modified:    Option<f64>,
	pub(crate) accessed:    Option<f64>,
	pub(crate) created:     Option<f64>,
}
#[pymethods]
impl PathMeta {
	#[new]
	#[pyo3(signature = (path, kind, byte_length, read_only=None, executable=None, modified=None, accessed=None, created=None))]
	const fn new(
		path: Py<PyEnvPath>,
		kind: Py<PyAny>,
		byte_length: u64,
		read_only: Option<bool>,
		executable: Option<bool>,
		modified: Option<f64>,
		accessed: Option<f64>,
		created: Option<f64>,
	) -> Self {
		Self { path, kind, byte_length, read_only, executable, modified, accessed, created }
	}

	#[getter]
	fn path(&self, py: Python<'_>) -> Py<PyEnvPath> {
		self.path.clone_ref(py)
	}

	#[getter]
	fn kind(&self, py: Python<'_>) -> Py<PyAny> {
		self.kind.clone_ref(py)
	}

	#[getter]
	const fn byte_length(&self) -> u64 {
		self.byte_length
	}

	#[getter]
	const fn read_only(&self) -> Option<bool> {
		self.read_only
	}

	#[getter]
	const fn executable(&self) -> Option<bool> {
		self.executable
	}

	#[getter]
	const fn modified(&self) -> Option<f64> {
		self.modified
	}

	#[getter]
	const fn accessed(&self) -> Option<f64> {
		self.accessed
	}

	#[getter]
	const fn created(&self) -> Option<f64> {
		self.created
	}

	fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
		Ok(format!(
			"PathMeta(path={}, kind={}, byte_length={})",
			self.path.bind(py).repr()?.to_str()?,
			self.kind.bind(py).repr()?.to_str()?,
			self.byte_length
		))
	}
}

py_record!(DirEntry, "DirEntry", name, meta);
py_record!(SymlinkTarget, "SymlinkTarget", target, relative);
py_record!(CopyResult, "CopyResult", meta, bytes_copied);
py_record!(WorktreeInfo, "WorktreeInfo", id, root, base, generation);
py_record!(Entry, "Entry", path, kind, size, mtime_ms, depth);
py_record!(Match, "Match", path, line, byte_offset, line_bytes);
py_record!(BlobStat, "BlobStat", present, size);
py_record!(
	Summary,
	"Summary",
	language,
	parsed,
	elided,
	total_lines,
	segments,
	text,
	display_text,
	elided_ranges,
	elided_lines
);
py_record!(SummaryUnavailable, "SummaryUnavailable", reason, total_lines, language, parsed);
py_record!(
	DocEvent,
	"DocEvent",
	sequence,
	kind,
	revision,
	previous_revision,
	txn_id,
	invalidated_txn_ids,
	previous_path
);
py_record!(
	SyncPolicy,
	"SyncPolicy",
	change,
	open_close,
	will_save,
	will_save_wait_until,
	save,
	save_include_text,
	position_encoding
);
py_record!(LspBinding, "LspBinding", server_id, name, sync, capabilities);
py_record!(LspEvent, "LspEvent", server_id, method, params, path, revision);
py_record!(LspBindingEvent, "LspBindingEvent", kind, binding, path);
py_record!(
	Completed,
	"Completed",
	outcome,
	exit_code,
	signal,
	wall,
	output,
	artifact,
	aborted;
	#[pyo3(signature = (_channel=None))]
	fn text(&self, py: Python<'_>, _channel: Option<&Bound<'_, PyAny>>) -> PyResult<String> {
		Ok(String::from_utf8_lossy(self.output.bind(py).cast::<PyBytes>()?.as_bytes()).into_owned())
	}
);
py_record!(Output, "Output", channel, data, sequence);
py_record!(Exit, "Exit", status);
py_record!(ProcessInfo, "ProcessInfo", name, generation, state, status);
py_record!(ProcessOutput, "ProcessOutput", generation, channel, data, sequence);
#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
pub struct HttpResponse {
	pub(crate) status:    Py<PyAny>,
	pub(crate) headers:   Py<PyAny>,
	pub(crate) body:      Py<PyAny>,
	pub(crate) final_url: Py<PyAny>,
}
#[pymethods]
impl HttpResponse {
	#[new]
	fn new(
		py: Python<'_>,
		status: Py<PyAny>,
		headers: Py<PyAny>,
		body: Py<PyAny>,
		final_url: Py<PyAny>,
	) -> PyResult<Self> {
		body.bind(py).cast::<PyBytes>()?;
		final_url.bind(py).extract::<String>()?;
		let proxy = py
			.import("types")?
			.getattr("MappingProxyType")?
			.call1((headers,))?
			.unbind();
		Ok(Self { status, headers: proxy, body, final_url })
	}

	#[getter]
	fn status(&self, py: Python<'_>) -> Py<PyAny> {
		self.status.clone_ref(py)
	}

	#[getter]
	fn headers(&self, py: Python<'_>) -> Py<PyAny> {
		self.headers.clone_ref(py)
	}

	#[getter]
	fn body(&self, py: Python<'_>) -> Py<PyAny> {
		self.body.clone_ref(py)
	}

	#[getter]
	fn final_url(&self, py: Python<'_>) -> Py<PyAny> {
		self.final_url.clone_ref(py)
	}

	fn json(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
		Ok(py
			.import("json")?
			.call_method1("loads", (self.body.bind(py),))?
			.unbind())
	}

	fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
		Ok(format!(
			"HttpResponse(status={}, final_url={})",
			self.status.bind(py).repr()?.to_str()?,
			self.final_url.bind(py).repr()?.to_str()?
		))
	}
}
py_record!(StartedProcess, "StartedProcess", name, generation, endpoint);
py_record!(OpenedDoc, "OpenedDoc", lease, revision);
py_record!(OpenedSession, "OpenedSession", id, cwd);
py_record!(StartedRun, "StartedRun", id);
py_record!(TxnReceipt, "TxnReceipt", txn_id, revision, rebased, formatted);
py_record!(TxnOutcome, "TxnOutcome", txn_id, committed, operation_count);
py_record!(
	EnvInfo,
	"EnvInfo",
	workspace_id,
	root,
	server_epoch,
	server_version,
	server_build,
	schema_rev,
	capabilities,
	remote
);
py_record!(LspError, "LspError", code, message, data);
py_record!(LspReply, "LspReply", revision, result, error);

#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
pub struct SummarySegment {
	kept:       bool,
	start_line: u64,
	end_line:   u64,
	text:       Option<String>,
}
#[pymethods]
impl SummarySegment {
	#[new]
	fn new(kept: bool, start_line: u64, end_line: u64, text: Option<String>) -> PyResult<Self> {
		if start_line == 0 || end_line < start_line {
			return Err(PyValueError::new_err(
				"summary segment coordinates must be ordered and one-based",
			));
		}
		if kept != text.is_some() {
			return Err(PyValueError::new_err(
				"kept summary segments must carry text and elided segments must not",
			));
		}
		Ok(Self { kept, start_line, end_line, text })
	}

	#[getter]
	const fn kept(&self) -> bool {
		self.kept
	}

	#[getter]
	const fn start_line(&self) -> u64 {
		self.start_line
	}

	#[getter]
	const fn end_line(&self) -> u64 {
		self.end_line
	}

	#[getter]
	fn text(&self) -> Option<&str> {
		self.text.as_deref()
	}

	fn __repr__(&self) -> String {
		format!(
			"SummarySegment(kept={}, start_line={}, end_line={}, text={:?})",
			self.kept, self.start_line, self.end_line, self.text
		)
	}
}

// The DATA stream hot-path records intentionally contain only Python handles.
const _: () = assert!(std::mem::size_of::<Output>() <= 48, "Output must stay compact");
const _: () = assert!(std::mem::size_of::<Entry>() <= 48, "Entry must stay compact");

pub fn any<'py, T>(py: Python<'py>, value: T) -> PyResult<Py<PyAny>>
where
	T: IntoPyObject<'py>,
	T::Error: Into<PyErr>,
{
	value.into_py_any(py)
}
