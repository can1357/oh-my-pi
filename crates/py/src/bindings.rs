//! Native, free-threaded Python value and Environment bindings.

use std::{
	cmp::Ordering,
	collections::{BTreeMap, hash_map::DefaultHasher},
	fmt::Display,
	future::Future,
	hash::{Hash, Hasher},
	str::{self, FromStr},
	sync::{Arc, LazyLock, OnceLock, atomic},
};

use omp_core::{
	ActivateReason, AgentUrl, ArtifactUrl, ClientPath, Duration, DurationUnit, EnvPath, HistoryUrl,
	InvocationPhase, LifecyclePhase, Principal, RestartReason, Secret, Str, WorkspaceUri,
	encoding::hex,
};
use omp_env::{
	BlobDownload, BlobDownloadEvent, BlobUpload, ClientError, DataScope, DocumentLease, ExecEvent,
	ExecRun, ExtensionEnvClient, LspEvents, LspStreamEvent, ProcessAttachment,
	ProcessAttachmentEvent, SearchEvent, SearchStream, TransactionOutcome, WalkEvent, WalkStream,
	blob_frame as blob_pb,
	document_frame::{
		self as document_pb, document_mutation, document_summary_segment, document_target,
		lsp_response, move_mutation::DestinationPrecondition, read_selection,
		summarize_document_response, text_mutation,
	},
	frame::{
		self as env_pb, OutputChannel, data_request, data_response, document_op, document_result,
		ready_probe, send_input, stdin_frame,
	},
};
use omp_scribe::{
	Engine as ScribeEngine, Error as ScribeError, Props as ScribeProps, Value as ScribeValue, canon,
};
use omp_tool::{Authority, CostClass, Durability, OperationSpec};
use parking_lot::{Mutex, RwLock};
use pyo3::{
	Bound, Py, PyAny, PyErr, PyResult, Python,
	basic::CompareOp,
	create_exception,
	exceptions::{PyException, PyRuntimeError, PyTypeError, PyValueError},
	pyclass, pyfunction, pymethods, pymodule,
	sync::OnceLockExt,
	types::{
		PyAnyMethods, PyBool, PyBytes, PyBytesMethods, PyDict, PyDictMethods, PyFloat, PyInt, PyList,
		PyListMethods, PyString, PyTuple, PyTupleMethods, PyTypeMethods,
	},
};
use tokio::runtime;

use crate::{env_types, interrupt};

create_exception!(_omp, OmpError, PyException, "Base class for omp runtime failures.");
create_exception!(_omp, HostDisconnected, OmpError, "The host CONTROL channel disconnected.");
create_exception!(_omp, EnvUnavailable, OmpError, "No Environment exists at this placement.");
create_exception!(
	_omp,
	PlacementError,
	OmpError,
	"A placement declaration or execution claim cannot be honored."
);
create_exception!(
	_omp,
	StaleGeneration,
	OmpError,
	"A request carries a retired host or session generation."
);
create_exception!(_omp, TemplateError, OmpError, "A scribe template failed to compile or render.");
/// Immutable declarative inputs for one atomic interactive-session transition.
#[pyclass(name = "SessionSetup", frozen, module = "_omp")]
pub struct PySessionSetup {
	title:          Option<Str>,
	parent:         Option<Str>,
	initial_prompt: Option<Py<PyAny>>,
}

#[pymethods]
impl PySessionSetup {
	#[new]
	#[pyo3(signature = (title = None, parent = None, initial_prompt = None))]
	fn new(title: Option<&str>, parent: Option<&str>, initial_prompt: Option<Py<PyAny>>) -> Self {
		Self { title: title.map(Str::from), parent: parent.map(Str::from), initial_prompt }
	}

	/// Optional user-assigned title.
	#[getter]
	fn title(&self) -> Option<&str> {
		self.title.as_deref()
	}

	/// Optional accessible lineage parent.
	#[getter]
	fn parent(&self) -> Option<&str> {
		self.parent.as_deref()
	}

	/// Optional visible user prompt which is persisted without submission.
	#[getter]
	fn initial_prompt(&self, py: Python<'_>) -> Option<Py<PyAny>> {
		self
			.initial_prompt
			.as_ref()
			.map(|value| value.clone_ref(py))
	}
}

#[derive(Debug, Default)]
struct ResourceState {
	quotas:  BTreeMap<Str, QuotaStatusValue>,
	dropped: BTreeMap<Str, u64>,
}

#[derive(Clone, Copy, Debug)]
struct QuotaStatusValue {
	limit:  u64,
	used:   u64,
	window: Option<Duration>,
}

#[derive(Clone, Debug)]
struct SchemeEntry {
	member:      Str,
	readable:    bool,
	mintable:    bool,
	selectors:   bool,
	description: Str,
}

#[derive(Debug, Default)]
struct SchemeSnapshot {
	device_hash: [u8; 32],
	entries:     Box<[SchemeEntry]>,
}

#[derive(Debug, Default)]
struct PythonRuntime {
	root_uri:  RwLock<Option<Str>>,
	resources: RwLock<ResourceState>,
	schemes:   RwLock<SchemeSnapshot>,
}

static RUNTIME: LazyLock<PythonRuntime> = LazyLock::new(PythonRuntime::default);
static ASYNC_RUNTIME: LazyLock<runtime::Runtime> = LazyLock::new(|| {
	runtime::Builder::new_multi_thread()
		.enable_all()
		.thread_name("omp-py-data")
		.build()
		.expect("omp Python DATA runtime must initialize")
});

/// Blocks on DATA I/O without entering a Tokio runtime from one of its workers.
fn block_on_data<F>(future: F) -> F::Output
where
	F: Future + Send,
	F::Output: Send,
{
	if runtime::Handle::try_current().is_err() {
		return ASYNC_RUNTIME.block_on(future);
	}
	std::thread::scope(|scope| match scope.spawn(move || ASYNC_RUNTIME.block_on(future)).join() {
		Ok(output) => output,
		Err(payload) => std::panic::resume_unwind(payload),
	})
}

/// Document transactions require exactly 16 id bytes; ulids are unique and fit.
fn fresh_transaction_id() -> Vec<u8> {
	omp_core::Ulid::generate().to_bytes().to_vec()
}

/// Replaces the live URL resolver snapshot used by `omp.urls.schemes()`.
pub fn set_scheme_snapshot<I, M, D>(device_hash: [u8; 32], entries: I)
where
	I: IntoIterator<Item = (M, bool, bool, bool, D)>,
	M: Into<Str>,
	D: Into<Str>,
{
	let entries = entries
		.into_iter()
		.map(|(member, readable, mintable, selectors, description)| SchemeEntry {
			member: member.into(),
			readable,
			mintable,
			selectors,
			description: description.into(),
		})
		.collect::<Vec<_>>()
		.into_boxed_slice();
	*RUNTIME.schemes.write() = SchemeSnapshot { device_hash, entries };
}

/// Updates the cached Environment root used for pure typed-path URI resolution.
///
/// The host calls this only after a successful DATA handshake. It performs no
/// Python work and does not open a socket.
pub fn set_environment_root(root_uri: impl Into<Str>) {
	*RUNTIME.root_uri.write() = Some(root_uri.into());
}

/// Replaces the locally cached quota receipt pushed by the host.
pub fn set_resource_receipt<I, D>(quotas: I, dropped: D)
where
	I: IntoIterator<Item = (Str, u64, u64, Option<Duration>)>,
	D: IntoIterator<Item = (Str, u64)>,
{
	let mut state = RUNTIME.resources.write();
	state.quotas.clear();
	state.dropped.clear();
	state.quotas.extend(
		quotas
			.into_iter()
			.map(|(name, limit, used, window)| (name, QuotaStatusValue { limit, used, window })),
	);
	state.dropped.extend(dropped);
}

fn value_error(error: impl Display) -> PyErr {
	PyValueError::new_err(error.to_string())
}

/// Immutable Python duration retaining its explicit source unit.
#[pyclass(name = "Duration", frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug)]
pub struct PyDuration(pub(crate) Duration);

#[pymethods]
impl PyDuration {
	#[new]
	#[pyo3(signature = (value = None, *, seconds = None))]
	fn new(value: Option<&Bound<'_, PyAny>>, seconds: Option<f64>) -> PyResult<Self> {
		match (value, seconds) {
			(Some(value), None) => {
				let text = value.extract::<&str>().map_err(|_| {
					PyTypeError::new_err("Duration positional value must be a unit-suffixed string")
				})?;
				Duration::from_str(text).map(Self).map_err(value_error)
			},
			(None, Some(seconds)) if seconds.is_finite() && seconds >= 0.0 => {
				let nanos = seconds * 1_000_000_000.0;
				if nanos > u64::MAX as f64 {
					return Err(PyValueError::new_err("duration is too large"));
				}
				let rounded = nanos.round();
				if (nanos - rounded).abs() > f64::EPSILON * nanos.abs().max(1.0) {
					return Err(PyValueError::new_err(
						"seconds cannot be represented as whole nanoseconds",
					));
				}
				Ok(Self(Duration::new(rounded as u64, DurationUnit::Nanoseconds)))
			},
			(None, Some(_)) => Err(PyValueError::new_err("seconds must be finite and non-negative")),
			(Some(_), Some(_)) => {
				Err(PyTypeError::new_err("pass either a string or seconds=, not both"))
			},
			(None, None) => Err(PyTypeError::new_err("Duration requires a string or seconds=")),
		}
	}

	#[getter]
	fn seconds(&self) -> PyResult<f64> {
		Ok(self.0.to_std().map_err(value_error)?.as_secs_f64())
	}

	#[getter]
	const fn value(&self) -> u64 {
		self.0.value()
	}

	#[getter]
	fn unit(&self) -> String {
		self.0.unit().to_string()
	}

	fn __str__(&self) -> String {
		self.0.to_string()
	}

	fn __repr__(&self) -> String {
		format!("Duration({:?})", self.0.to_string())
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.0.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.0 == other.0,
			CompareOp::Ne => self.0 != other.0,
			CompareOp::Lt => self.0 < other.0,
			CompareOp::Le => self.0 <= other.0,
			CompareOp::Gt => self.0 > other.0,
			CompareOp::Ge => self.0 >= other.0,
		}
	}

	fn __sub__(&self, other: &Self) -> PyResult<Self> {
		let left = self.0.to_std().map_err(value_error)?;
		let right = other.0.to_std().map_err(value_error)?;
		let difference = left.checked_sub(right).ok_or_else(|| {
			PyValueError::new_err("Duration subtraction cannot produce a negative duration")
		})?;
		Duration::from_std(difference, DurationUnit::Nanoseconds)
			.map(Self)
			.map_err(value_error)
	}
}

/// Creates the immutable Python view of a configured core duration.
pub fn bind_duration(py: Python<'_>, duration: Duration) -> PyResult<Py<PyAny>> {
	Ok(Py::new(py, PyDuration(duration))?.into_any())
}

/// Opaque Python secret whose representation never reveals its bytes.
///
/// Raw bytes are available only from the temporary value yielded by
/// [`Self::use_`]; callers must use that context manager rather than logging
/// this object.
#[pyclass(name = "Secret", frozen, module = "_omp")]
#[derive(Debug)]
struct PySecret(Arc<Secret>);

#[pymethods]
impl PySecret {
	#[new]
	fn new(bytes: &Bound<'_, PyBytes>) -> Self {
		Self(Arc::new(Secret::from(bytes.as_bytes().to_vec())))
	}

	/// Returns a context manager which temporarily yields the secret bytes.
	#[pyo3(name = "use")]
	fn use_(&self) -> PySecretUse {
		PySecretUse(Arc::clone(&self.0))
	}

	const fn __str__(&self) -> &'static str {
		"<redacted>"
	}

	const fn __repr__(&self) -> &'static str {
		"Secret(<redacted>)"
	}

	const fn __format__(&self, _format_spec: &str) -> &'static str {
		"<redacted>"
	}
}

/// Short-lived Python context manager for a [`PySecret`] exposure.
#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
struct PySecretUse(Arc<Secret>);

#[pymethods]
impl PySecretUse {
	fn __enter__<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
		self.0.expose(|bytes| PyBytes::new(py, bytes))
	}

	const fn __exit__(
		&self,
		_exc_type: Option<&Bound<'_, PyAny>>,
		_exc_value: Option<&Bound<'_, PyAny>>,
		_traceback: Option<&Bound<'_, PyAny>>,
	) -> bool {
		false
	}
}

/// Canonical ordered Python invocation phase.
#[pyclass(name = "InvocationPhase", frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug)]
struct PyInvocationPhase(InvocationPhase);

#[pymethods]
impl PyInvocationPhase {
	#[classattr]
	const ADMISSION: Self = Self(InvocationPhase::Admission);
	#[classattr]
	const ADMITTED: Self = Self(InvocationPhase::Admitted);
	#[classattr]
	const ARGS_FINALIZED: Self = Self(InvocationPhase::ArgsFinalized);
	#[classattr]
	const ASSISTANT_ITEM_COMMITTED: Self = Self(InvocationPhase::AssistantItemCommitted);
	#[classattr]
	const EFFECTS_AUTHORIZED: Self = Self(InvocationPhase::EffectsAuthorized);
	#[classattr]
	const OPEN: Self = Self(InvocationPhase::Open);
	#[classattr]
	const SETTLED: Self = Self(InvocationPhase::Settled);

	#[getter]
	fn value(&self) -> &'static str {
		self.0.into()
	}

	#[getter]
	const fn ordinal(&self) -> u8 {
		self.0.ordinal()
	}

	fn __str__(&self) -> &'static str {
		self.0.into()
	}

	fn __repr__(&self) -> String {
		format!("InvocationPhase.{}", <&str>::from(self.0))
	}

	const fn __hash__(&self) -> isize {
		self.0 as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		compare(self.0.cmp(&other.0), op)
	}
}

/// Canonical ordered Python extension lifecycle phase.
#[pyclass(name = "LifecyclePhase", frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug)]
struct PyLifecyclePhase(LifecyclePhase);

#[pymethods]
impl PyLifecyclePhase {
	#[classattr]
	const ACTIVE: Self = Self(LifecyclePhase::Active);
	#[classattr]
	const DECLARED: Self = Self(LifecyclePhase::Declared);
	#[classattr]
	const DEGRADED: Self = Self(LifecyclePhase::Degraded);
	#[classattr]
	const FROZEN: Self = Self(LifecyclePhase::Frozen);
	#[classattr]
	const VERIFIED: Self = Self(LifecyclePhase::Verified);

	#[getter]
	fn value(&self) -> &'static str {
		self.0.into()
	}

	#[getter]
	const fn ordinal(&self) -> u8 {
		self.0.ordinal()
	}

	fn __str__(&self) -> &'static str {
		self.0.into()
	}

	fn __repr__(&self) -> String {
		format!("LifecyclePhase.{}", <&str>::from(self.0))
	}

	const fn __hash__(&self) -> isize {
		self.0 as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		compare(self.0.cmp(&other.0), op)
	}
}

fn compare(ordering: Ordering, op: CompareOp) -> bool {
	match op {
		CompareOp::Eq => ordering == Ordering::Equal,
		CompareOp::Ne => ordering != Ordering::Equal,
		CompareOp::Lt => ordering == Ordering::Less,
		CompareOp::Le => ordering != Ordering::Greater,
		CompareOp::Gt => ordering == Ordering::Greater,
		CompareOp::Ge => ordering != Ordering::Less,
	}
}

#[derive(Clone, Copy, Debug, strum::Display)]
#[strum(serialize_all = "lowercase")]
enum StateScope {
	Session,
	Project,
	User,
	Organization,
}

macro_rules! string_enum {
	($rust:ident, $python:literal, $inner:ty, [$($member:ident => $variant:path),+ $(,)?]) => {
		#[doc = concat!("Canonical Python ", $python, " vocabulary.")]
		#[pyclass(name = $python, frozen, module = "_omp", from_py_object)]
		#[derive(Clone, Debug)]
		struct $rust($inner);

		#[pymethods]
		impl $rust {
			$(#[classattr]
			const $member: Self = Self($variant);)+

			#[getter]
			fn value(&self) -> String { self.0.to_string() }

			fn __str__(&self) -> String { self.0.to_string() }

			fn __repr__(&self) -> String {
				format!(concat!($python, ".{}"), self.0.to_string().to_ascii_uppercase())
			}

			const fn __hash__(&self) -> isize { self.0 as isize }

			fn __richcmp__(&self, other: &Self, op: pyo3::basic::CompareOp) -> bool {
				compare((self.0 as u8).cmp(&(other.0 as u8)), op)
			}
		}
	};
}
string_enum!(PyActivateReason, "ActivateReason", ActivateReason, [
	FIRST_REACH => ActivateReason::FirstReach,
	RESTART => ActivateReason::Restart,
	HOT_RELOAD => ActivateReason::HotReload,
]);
string_enum!(PyRestartReason, "RestartReason", RestartReason, [
	CRASH => RestartReason::Crash,
	HOT_RELOAD => RestartReason::HotReload,
	CANCEL_ESCALATION => RestartReason::CancelEscalation,
	PROTOCOL_ERROR => RestartReason::ProtocolError,
	OOM => RestartReason::Oom,
	HEALTH_TIMEOUT => RestartReason::HealthTimeout,
]);
string_enum!(PyStateScope, "StateScope", StateScope, [
	SESSION => StateScope::Session,
	PROJECT => StateScope::Project,
	USER => StateScope::User,
	ORGANIZATION => StateScope::Organization,
]);

string_enum!(PyDurability, "Durability", Durability, [
	EPHEMERAL => Durability::Ephemeral,
	DURABLE => Durability::Durable,
]);
string_enum!(PyCostClass, "CostClass", CostClass, [
	NONE => CostClass::None,
	METERED => CostClass::Metered,
	PAID => CostClass::Paid,
]);
string_enum!(PyAuthority, "Authority", Authority, [
	CORE => Authority::Core,
	ENVIRONMENT => Authority::Environment,
]);

/// Generated phase, durability, cost, and authority metadata.
#[pyclass(name = "OperationSpec", frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug)]
struct PyOperationSpec(OperationSpec);

#[pymethods]
impl PyOperationSpec {
	#[getter]
	const fn minimum_phase(&self) -> PyInvocationPhase {
		PyInvocationPhase(self.0.minimum_phase)
	}

	#[getter]
	const fn durability(&self) -> PyDurability {
		PyDurability(self.0.durability)
	}

	#[getter]
	const fn cost(&self) -> PyCostClass {
		PyCostClass(self.0.cost)
	}

	#[getter]
	const fn authority(&self) -> PyAuthority {
		PyAuthority(self.0.authority)
	}

	fn __repr__(&self) -> String {
		format!(
			"OperationSpec(minimum_phase={}, durability={}, cost={}, authority={})",
			<&str>::from(self.0.minimum_phase),
			<&str>::from(self.0.durability),
			<&str>::from(self.0.cost),
			<&str>::from(self.0.authority),
		)
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.0.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.0 == other.0,
			CompareOp::Ne => self.0 != other.0,
			_ => false,
		}
	}
}

#[pyfunction]
fn operation_spec(symbol: &Bound<'_, PyAny>) -> PyResult<Option<PyOperationSpec>> {
	let name = if let Ok(name) = symbol.extract::<String>() {
		name
	} else if let Ok(name) = symbol.getattr("__omp_symbol__") {
		name.extract::<String>()?
	} else {
		return Err(PyTypeError::new_err(
			"operation_spec expects a qualified symbol name or an omp public symbol",
		));
	};
	Ok(omp_tool::operation_spec(&name)
		.copied()
		.map(PyOperationSpec))
}

macro_rules! typed_location {
	($rust:ident, $python:literal, $inner:ty) => {
		#[doc = concat!("Typed Python ", $python, " location value.")]
		#[pyclass(name = $python, frozen, module = "_omp", from_py_object)]
		#[derive(Clone, Debug)]
		struct $rust($inner);

		#[pymethods]
		impl $rust {
			#[new]
			fn new(value: &str) -> PyResult<Self> {
				<$inner>::new(Str::new(value))
					.map(Self)
					.map_err(value_error)
			}

			#[getter]
			fn uri(&self) -> &str {
				self.0.as_str()
			}

			fn __str__(&self) -> &str {
				self.0.as_str()
			}

			fn __repr__(&self) -> String {
				format!(concat!($python, "({:?})"), self.0.as_str())
			}

			fn __hash__(&self) -> isize {
				let mut hasher = std::collections::hash_map::DefaultHasher::new();
				self.0.hash(&mut hasher);
				hasher.finish() as isize
			}

			fn __richcmp__(&self, other: &Self, op: pyo3::basic::CompareOp) -> bool {
				match op {
					pyo3::basic::CompareOp::Eq => self.0 == other.0,
					pyo3::basic::CompareOp::Ne => self.0 != other.0,
					_ => false,
				}
			}
		}
	};
}

macro_rules! typed_url_location {
	($rust:ident, $python:literal, $inner:ty) => {
		#[doc = concat!("Typed Python ", $python, " URL value.")]
		#[pyclass(name = $python, frozen, module = "_omp", from_py_object)]
		#[derive(Clone, Debug)]
		struct $rust($inner);

		#[pymethods]
		impl $rust {
			#[new]
			fn new(value: &str) -> PyResult<Self> {
				<$inner>::new(Str::new(value))
					.map(Self)
					.map_err(value_error)
			}

			#[getter]
			fn uri(&self) -> &str {
				self.0.as_str()
			}

			#[getter]
			fn resource(&self) -> &str {
				self.0.resource()
			}

			#[getter]
			fn selector(&self) -> Option<&str> {
				self.0.selector()
			}

			fn with_selector(&self, py: Python<'_>, selector: &str) -> PyResult<Self> {
				py.import("omp.urls")?
					.getattr("parse_selector")?
					.call1((selector,))?;
				let base_len =
					self.0.as_str().len() - self.0.selector().map_or(0, |value| value.len() + 1);
				let mut value = String::with_capacity(base_len + selector.len() + 1);
				value.push_str(&self.0.as_str()[..base_len]);
				value.push(':');
				value.push_str(selector);
				<$inner>::new(Str::new(value))
					.map(Self)
					.map_err(value_error)
			}

			fn read(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
				Ok(py
					.import("omp")?
					.getattr("_read_url")?
					.call1((self.clone(),))?
					.unbind())
			}

			fn __str__(&self) -> &str {
				self.0.as_str()
			}

			fn __repr__(&self) -> String {
				format!(concat!($python, "({:?})"), self.0.as_str())
			}

			fn __hash__(&self) -> isize {
				let mut hasher = std::collections::hash_map::DefaultHasher::new();
				self.0.hash(&mut hasher);
				hasher.finish() as isize
			}

			fn __richcmp__(&self, other: &Self, op: pyo3::basic::CompareOp) -> bool {
				match op {
					pyo3::basic::CompareOp::Eq => self.0 == other.0,
					pyo3::basic::CompareOp::Ne => self.0 != other.0,
					_ => false,
				}
			}
		}
	};
}

#[pyfunction]
fn _phase_legality_matrix(py: Python<'_>) -> PyResult<Py<PyAny>> {
	let matrix = PyDict::new(py);
	for row in omp_tool::phase_legality_matrix() {
		matrix.set_item(row.public_name, row.legal)?;
	}
	let proxy = py.import("types")?.getattr("MappingProxyType")?;
	Ok(proxy.call1((matrix,))?.unbind())
}

#[pyfunction]
fn _runtime_metadata(py: Python<'_>) -> PyResult<Py<PyAny>> {
	let metadata = PyDict::new(py);
	for symbol in omp_tool::runtime_symbols() {
		let row = PyDict::new(py);
		row.set_item("owner", symbol.owner)?;
		row.set_item("signature", symbol.signature)?;
		row.set_item("callback_abi", <&str>::from(symbol.callback_abi))?;
		row.set_item("operation", Py::new(py, PyOperationSpec(symbol.operation))?)?;
		row.set_item(
			"timeout",
			symbol
				.timeout
				.map(|timeout| Py::new(py, PyDuration(timeout)))
				.transpose()?,
		)?;
		row.set_item("examples", symbol.examples)?;
		metadata.set_item(symbol.public_name, row)?;
	}
	let proxy = py.import("types")?.getattr("MappingProxyType")?;
	Ok(proxy.call1((metadata,))?.unbind())
}

typed_url_location!(PyArtifactUrl, "ArtifactUrl", ArtifactUrl);
typed_url_location!(PyHistoryUrl, "HistoryUrl", HistoryUrl);
typed_url_location!(PyAgentUrl, "AgentUrl", AgentUrl);
typed_location!(PyWorkspaceUri, "WorkspaceUri", WorkspaceUri);

#[pyclass(name = "EnvPath", frozen, module = "_omp", from_py_object)]
/// A path in the workspace Environment filesystem namespace.
#[derive(Clone, Debug)]
pub struct PyEnvPath(pub(crate) EnvPath);

#[pymethods]
impl PyEnvPath {
	#[new]
	fn new(value: &str) -> PyResult<Self> {
		EnvPath::new(Str::new(value)).map(Self).map_err(value_error)
	}

	#[getter]
	fn uri(&self) -> PyResult<String> {
		path_uri(self.0.as_str())
	}

	#[pyo3(signature = (*parts))]
	fn join(&self, parts: &Bound<'_, PyTuple>) -> PyResult<Self> {
		let parts = parts
			.iter()
			.map(|part| part.extract::<String>())
			.collect::<PyResult<Vec<_>>>()?;
		join_env_path(self.0.as_str(), parts.iter().map(String::as_str))
	}

	#[pyo3(signature = (encoding = "utf-8"))]
	fn read_text(&self, py: Python<'_>, encoding: &str) -> PyResult<Py<PyAny>> {
		let module = py.import("omp.env")?;
		Ok(module
			.getattr("_read_text")?
			.call1((self.clone(), encoding))?
			.unbind())
	}

	fn read_bytes(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
		let module = py.import("omp.env")?;
		Ok(module
			.getattr("_read_bytes")?
			.call1((self.clone(),))?
			.unbind())
	}

	fn local_path(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
		let module = py.import("omp.env")?;
		Ok(module
			.getattr("_local_path")?
			.call1((self.clone(),))?
			.unbind())
	}

	fn __str__(&self) -> &str {
		self.0.as_str()
	}

	fn __repr__(&self) -> String {
		format!("EnvPath({:?})", self.0.as_str())
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.0.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.0 == other.0,
			CompareOp::Ne => self.0 != other.0,
			_ => false,
		}
	}
}

#[pyclass(name = "ClientPath", frozen, module = "_omp", from_py_object)]
/// A path in the client-machine filesystem namespace.
#[derive(Clone, Debug)]
struct PyClientPath(ClientPath);

#[pymethods]
impl PyClientPath {
	#[new]
	fn new(value: &str) -> PyResult<Self> {
		ClientPath::new(Str::new(value))
			.map(Self)
			.map_err(value_error)
	}

	#[getter]
	fn uri(&self) -> &str {
		self.0.as_str()
	}

	#[pyo3(signature = (*parts))]
	fn join(&self, parts: &Bound<'_, PyTuple>) -> PyResult<Self> {
		let parts = parts
			.iter()
			.map(|part| part.extract::<String>())
			.collect::<PyResult<Vec<_>>>()?;
		join_client_path(self.0.as_str(), parts.iter().map(String::as_str))
	}

	fn __str__(&self) -> &str {
		self.0.as_str()
	}

	fn __repr__(&self) -> String {
		format!("ClientPath({:?})", self.0.as_str())
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.0.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.0 == other.0,
			CompareOp::Ne => self.0 != other.0,
			_ => false,
		}
	}
}

fn join_env_path<'a>(base: &str, parts: impl Iterator<Item = &'a str>) -> PyResult<PyEnvPath> {
	let joined = join_path(base, parts)?;
	EnvPath::new(Str::new(joined))
		.map(PyEnvPath)
		.map_err(value_error)
}

fn join_client_path<'a>(
	base: &str,
	parts: impl Iterator<Item = &'a str>,
) -> PyResult<PyClientPath> {
	let joined = join_path(base, parts)?;
	ClientPath::new(Str::new(joined))
		.map(PyClientPath)
		.map_err(value_error)
}

fn join_path<'a>(base: &str, parts: impl Iterator<Item = &'a str>) -> PyResult<String> {
	let mut joined = String::from(base.trim_end_matches('/'));
	for part in parts {
		if part.is_empty() || part.as_bytes().contains(&0) {
			return Err(PyValueError::new_err("path components must be non-empty and contain no NUL"));
		}
		joined.push('/');
		joined.push_str(part.trim_matches('/'));
	}
	Ok(joined)
}

fn path_uri(path: &str) -> PyResult<String> {
	if path.starts_with("file://") {
		return Ok(path.to_owned());
	}
	let root = RUNTIME.root_uri.read();
	let root = root
		.as_deref()
		.ok_or_else(|| EnvUnavailable::new_err("no Environment is installed"))?;
	let mut uri = String::with_capacity(root.len() + path.len() + 1);
	uri.push_str(root.trim_end_matches('/'));
	if !path.starts_with('/') {
		uri.push('/');
	}
	uri.push_str(path);
	Ok(uri)
}

#[pyclass(name = "BlobRef", frozen, module = "_omp", from_py_object)]
/// A content-addressed reference in one Environment blob store.
#[derive(Clone, Debug)]
pub struct PyBlobRef {
	hash: [u8; 32],
	size: u64,
}

#[pymethods]
impl PyBlobRef {
	#[new]
	fn new(hash: &[u8], size: u64) -> PyResult<Self> {
		let hash = <[u8; 32]>::try_from(hash)
			.map_err(|_| PyValueError::new_err("BlobRef hash must contain exactly 32 bytes"))?;
		Ok(Self { hash, size })
	}

	#[getter]
	fn hash<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
		PyBytes::new(py, &self.hash)
	}

	#[getter]
	const fn size(&self) -> u64 {
		self.size
	}

	#[getter]
	fn hex(&self) -> String {
		hex::encode(&self.hash).to_string()
	}

	fn __repr__(&self) -> String {
		format!("BlobRef(hash={}, size={})", self.hex(), self.size)
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.hash.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.hash == other.hash,
			CompareOp::Ne => self.hash != other.hash,
			_ => false,
		}
	}
}

/// Core-authenticated principal identity exposed read-only to Python.
#[pyclass(name = "Principal", frozen, module = "_omp", from_py_object)]
#[derive(Clone, Debug)]
struct PyPrincipal(Principal);

#[pymethods]
impl PyPrincipal {
	#[getter]
	fn id(&self) -> &str {
		self.0.id()
	}

	#[getter]
	fn display(&self) -> &str {
		self.0.display()
	}

	#[staticmethod]
	const fn __repr__() -> &'static str {
		"Principal(<core-issued>)"
	}

	fn __hash__(&self) -> isize {
		let mut hasher = DefaultHasher::new();
		self.0.hash(&mut hasher);
		hasher.finish() as isize
	}

	fn __richcmp__(&self, other: &Self, op: CompareOp) -> bool {
		match op {
			CompareOp::Eq => self.0 == other.0,
			CompareOp::Ne => self.0 != other.0,

			_ => false,
		}
	}
}
/// Creates the read-only Python view of a core-authenticated principal.
pub fn bind_principal(py: Python<'_>, principal: Principal) -> PyResult<Py<PyAny>> {
	Ok(Py::new(py, PyPrincipal(principal))?.into_any())
}
#[pyfunction]
fn _principal_from_host(id: &str, display: &str) -> PyPrincipal {
	PyPrincipal(Principal::new(Str::new(id), Str::new(display)))
}

/// One quota's immutable local standing.
#[pyclass(name = "QuotaStatus", frozen, module = "_omp", skip_from_py_object)]
#[derive(Clone, Debug)]
struct PyQuotaStatus {
	#[pyo3(get)]
	limit:  u64,
	#[pyo3(get)]
	used:   u64,
	#[pyo3(get)]
	window: Option<PyDuration>,
}

/// Immutable snapshot of extension resource quota standing.
#[pyclass(name = "ResourceReceipt", frozen, module = "_omp")]
#[derive(Debug)]
struct PyResourceReceipt {
	#[pyo3(get)]
	quotas:  Py<PyAny>,
	#[pyo3(get)]
	dropped: Py<PyAny>,
}

fn parse_resource_quotas(
	quotas: Vec<(String, u64, u64, Option<String>)>,
) -> PyResult<Vec<(Str, u64, u64, Option<Duration>)>> {
	quotas
		.into_iter()
		.map(|(name, limit, used, window)| {
			let window = window
				.map(|window| Duration::from_str(&window))
				.transpose()
				.map_err(value_error)?;
			Ok((Str::from(name), limit, used, window))
		})
		.collect()
}

#[pyfunction]
fn _set_resource_receipt(
	quotas: Vec<(String, u64, u64, Option<String>)>,
	dropped: Vec<(String, u64)>,
) -> PyResult<()> {
	set_resource_receipt(
		parse_resource_quotas(quotas)?,
		dropped
			.into_iter()
			.map(|(name, count)| (Str::from(name), count)),
	);
	Ok(())
}

fn bind_resource_receipt(
	py: Python<'_>,
	quotas: impl IntoIterator<Item = (Str, QuotaStatusValue)>,
	dropped_rows: impl IntoIterator<Item = (Str, u64)>,
) -> PyResult<PyResourceReceipt> {
	let quotas_mapping = PyDict::new(py);
	for (name, status) in quotas {
		let value = Py::new(py, PyQuotaStatus {
			limit:  status.limit,
			used:   status.used,
			window: status.window.map(PyDuration),
		})?;
		quotas_mapping.set_item(name.as_str(), value)?;
	}
	let dropped = PyDict::new(py);
	for (name, count) in dropped_rows {
		dropped.set_item(name.as_str(), count)?;
	}
	let proxy = py.import("types")?.getattr("MappingProxyType")?;
	Ok(PyResourceReceipt {
		quotas:  proxy.call1((quotas_mapping,))?.unbind(),
		dropped: proxy.call1((dropped,))?.unbind(),
	})
}

#[pyfunction]
fn _resource_receipt_from_host(
	py: Python<'_>,
	quotas: Vec<(String, u64, u64, Option<String>)>,
	dropped: Vec<(String, u64)>,
) -> PyResult<PyResourceReceipt> {
	let quotas = parse_resource_quotas(quotas)?
		.into_iter()
		.map(|(name, limit, used, window)| (name, QuotaStatusValue { limit, used, window }));
	bind_resource_receipt(
		py,
		quotas,
		dropped
			.into_iter()
			.map(|(name, count)| (Str::from(name), count)),
	)
}

#[pyfunction]
fn resources(py: Python<'_>) -> PyResult<PyResourceReceipt> {
	let (quotas, dropped) = {
		let state = RUNTIME.resources.read();
		(state.quotas.clone(), state.dropped.clone())
	};
	bind_resource_receipt(py, quotas, dropped)
}

#[pyfunction]
fn _scheme_snapshot(py: Python<'_>) -> PyResult<Py<PyAny>> {
	let snapshot = RUNTIME.schemes.read();
	let urls = py.import("omp.urls")?;
	let scheme_type = urls.getattr("Scheme")?;
	let info_type = urls.getattr("SchemeInfo")?;
	let entries = PyList::empty(py);
	for entry in &snapshot.entries {
		let scheme = scheme_type.get_item(entry.member.as_str())?;
		let info = info_type.call1((
			entry.readable,
			entry.mintable,
			entry.selectors,
			entry.description.as_str(),
		))?;
		entries.append((scheme, info))?;
	}
	let hash = PyBytes::new(py, &snapshot.device_hash);
	Ok(PyTuple::new(py, [hash.into_any(), entries.into_any()])?
		.unbind()
		.into_any())
}
#[pyfunction]
fn _local_path_string(_path: &PyEnvPath) -> PyResult<String> {
	Err(PlacementError::new_err(
		"this extension is not colocated with an authorized Environment filesystem",
	))
}

/// Immutable reference to the inherited CONTROL transport.
#[pyclass(name = "ControlHandle", frozen, module = "_omp")]
#[derive(Debug)]
struct PyControlHandle {
	fd: i32,
}

#[pymethods]
impl PyControlHandle {
	#[new]
	const fn new(fd: i32) -> Self {
		Self { fd }
	}

	#[getter]
	const fn fd(&self) -> i32 {
		self.fd
	}
}

fn environment_exception(py: Python<'_>, name: &str, message: &str) -> PyErr {
	match py
		.import("omp.env")
		.and_then(|module| module.getattr(name))
		.and_then(|exception| exception.call1((message,)))
	{
		Ok(value) => PyErr::from_value(value),
		Err(error) => error,
	}
}

fn edit_rejection_exception(py: Python<'_>, rejected: &document_pb::TransactionRejected) -> PyErr {
	let Some(conflict) = rejected.conflicts.first() else {
		return environment_exception(py, "Stale", &rejected.message);
	};
	let result = (|| -> PyResult<PyErr> {
		let value = py
			.import("omp.env")?
			.getattr("Conflict")?
			.call1((&rejected.message,))?;
		value.setattr("expected", revision_value(py, conflict.expected.as_ref())?)?;
		value.setattr(
			"current",
			revision_value(
				py,
				conflict
					.current
					.as_ref()
					.and_then(|head| head.revision.as_ref()),
			)?,
		)?;
		let ranges: Vec<(u64, u64)> = conflict
			.conflicting_ranges
			.iter()
			.map(|range| (range.start, range.end))
			.collect();
		value.setattr("ranges", ranges)?;
		Ok(PyErr::from_value(value))
	})();
	result.unwrap_or_else(|error| error)
}

fn client_error(py: Python<'_>, error: ClientError) -> PyErr {
	match error {
		ClientError::EffectsNotAuthorized(protocol) => {
			environment_exception(py, "EffectsNotAuthorized", &protocol.message)
		},
		ClientError::Protocol(protocol) => {
			let kind = match env_pb::ProtocolErrorCode::try_from(protocol.code) {
				Ok(env_pb::ProtocolErrorCode::InvalidArgument) => "Invalid",
				Ok(env_pb::ProtocolErrorCode::NotFound) => "NotFound",
				Ok(env_pb::ProtocolErrorCode::PermissionDenied) => "Denied",
				Ok(env_pb::ProtocolErrorCode::Unsupported) => "Unsupported",
				Ok(env_pb::ProtocolErrorCode::AlreadyExists) => "AlreadyExists",
				Ok(env_pb::ProtocolErrorCode::PreconditionFailed) => "PreconditionFailed",
				Ok(env_pb::ProtocolErrorCode::Cancelled) => "Cancelled",
				Ok(env_pb::ProtocolErrorCode::DeadlineExceeded) => "TimedOut",
				Ok(env_pb::ProtocolErrorCode::Uncommitted) => "EffectsNotAuthorized",
				_ => "Io",
			};
			environment_exception(py, kind, &protocol.message)
		},
		ClientError::TransportClosed | ClientError::Transport(_) => {
			environment_exception(py, "Disconnected", &error.to_string())
		},
		ClientError::InvalidEnvPath(_)
		| ClientError::InvalidBlobDigest { .. }
		| ClientError::BlobTooLarge { .. }
		| ClientError::BlobResumeOffsetMismatch { .. }
		| ClientError::InvalidBlobMetadata
		| ClientError::BlobDigestMismatch
		| ClientError::BlobSizeMismatch { .. } => {
			environment_exception(py, "Invalid", &error.to_string())
		},
		ClientError::InvalidInvocationPrincipal => environment_exception(
			py,
			"Invalid",
			"invocation principal requires nonempty session_id and agent_id",
		),
		ClientError::ScopedOperationDenied => environment_exception(py, "Denied", &error.to_string()),
		ClientError::StreamLost(_) => environment_exception(py, "StreamLost", &error.to_string()),
		ClientError::IncompleteBlob => environment_exception(py, "Disconnected", &error.to_string()),
		ClientError::TransportBusy
		| ClientError::RequestIdExhausted
		| ClientError::UnexpectedResponse { .. }
		| ClientError::BlobWrite { .. } => environment_exception(py, "Io", &error.to_string()),
	}
}

fn process_started(py: Python<'_>, value: &env_pb::ProcessStarted) -> PyResult<Py<PyAny>> {
	Ok(Py::new(py, env_types::StartedProcess {
		name:       env_types::any(py, &value.name)?,
		generation: env_types::any(py, value.generation)?,
		endpoint:   env_types::any(py, value.endpoint.as_deref())?,
	})?
	.into_any())
}

fn revision_value(py: Python<'_>, value: Option<&document_pb::Revision>) -> PyResult<Py<PyAny>> {
	let Some(value) = value else {
		return Ok(py.None());
	};
	Ok(Py::new(py, env_types::Revision::new(value.sequence, value.content_hash.to_vec()))?
		.into_any())
}

fn argument_revision(
	arguments: &Bound<'_, PyDict>,
	name: &str,
) -> PyResult<Option<document_pb::Revision>> {
	let Some(value) = arguments.get_item(name)? else {
		return Ok(None);
	};
	if value.is_none() {
		return Ok(None);
	}
	Ok(Some(document_pb::Revision {
		sequence:     value.getattr("sequence")?.extract()?,
		content_hash: value.getattr("content_hash")?.extract::<Vec<u8>>()?.into(),
	}))
}

fn argument_overwrite(
	arguments: &Bound<'_, PyDict>,
	name: &str,
) -> PyResult<document_pb::DestinationOverwritePolicy> {
	let value = arguments
		.get_item(name)?
		.ok_or_else(|| PyTypeError::new_err(format!("{name} is required")))?
		.extract::<String>()?;
	match value.as_str() {
		"fail" => Ok(document_pb::DestinationOverwritePolicy::FailIfExists),
		"replace_file" => Ok(document_pb::DestinationOverwritePolicy::ReplaceNonDirectory),
		"replace_empty_dir" => Ok(document_pb::DestinationOverwritePolicy::ReplaceEmptyDirectory),
		_ => Err(PyValueError::new_err("invalid overwrite policy")),
	}
}

fn duration_millis(value: &Bound<'_, PyAny>) -> PyResult<u64> {
	let duration = value.extract::<PyDuration>()?;
	duration
		.0
		.to_std()
		.map(|value| value.as_millis().try_into().unwrap_or(u64::MAX))
		.map_err(value_error)
}

fn append_ready_probes(
	value: &Bound<'_, PyAny>,
	probes: &mut Vec<env_pb::ReadyProbe>,
) -> PyResult<()> {
	if value.hasattr("probes")? {
		for probe in value.getattr("probes")?.try_iter()? {
			append_ready_probes(&probe?, probes)?;
		}
		return Ok(());
	}
	let timeout_ms = duration_millis(&value.getattr("timeout")?)?;
	let probe = if value.hasattr("pattern")? {
		ready_probe::Probe::Log(env_pb::ReadyLog {
			pattern: value.getattr("pattern")?.extract()?,
			props:   Default::default(),
		})
	} else if value.hasattr("port")? {
		ready_probe::Probe::Tcp(env_pb::ReadyTcp {
			host:  value.getattr("host")?.extract()?,
			port:  value.getattr("port")?.extract()?,
			props: Default::default(),
		})
	} else if value.hasattr("nonce")? {
		ready_probe::Probe::Ping(env_pb::ReadyPing {
			nonce: value.getattr("nonce")?.extract()?,
			props: Default::default(),
		})
	} else {
		return Err(PyTypeError::new_err("ready must be an omp.env.Ready value"));
	};
	probes.push(env_pb::ReadyProbe { probe: Some(probe), timeout_ms, props: Default::default() });
	Ok(())
}

fn path_value(py: Python<'_>, uri: &str) -> PyResult<Py<PyEnvPath>> {
	let path = EnvPath::new(Str::new(uri)).map_err(value_error)?;
	Py::new(py, PyEnvPath(path))
}

fn path_metadata(py: Python<'_>, value: &document_pb::PathMetadata) -> PyResult<Py<PyAny>> {
	static FILE_KIND_MEMBERS: OnceLock<[Py<PyAny>; 4]> = OnceLock::new();
	let members = FILE_KIND_MEMBERS.get_or_init_py_attached(py, || {
		let kind = py
			.import("omp.env")
			.and_then(|module| module.getattr("FileKind"))
			.expect("omp.env.FileKind must exist while decoding DATA responses");
		["REGULAR_FILE", "DIRECTORY", "SYMLINK", "OTHER"].map(|name| {
			kind
				.getattr(name)
				.expect("omp.env.FileKind member must exist")
				.unbind()
		})
	});
	let index = match document_pb::FileKind::try_from(value.kind) {
		Ok(document_pb::FileKind::RegularFile) => 0,
		Ok(document_pb::FileKind::Directory) => 1,
		Ok(document_pb::FileKind::SymbolicLink) => 2,
		_ => 3,
	};
	let kind = members[index].clone_ref(py);
	let (read_only, executable) = value
		.permissions
		.as_ref()
		.map_or((None, None), |permissions| (permissions.read_only, permissions.executable));
	Ok(Py::new(py, env_types::PathMeta {
		path: path_value(py, &value.uri)?,
		kind,
		byte_length: value.byte_length,
		read_only,
		executable,
		modified: value
			.modified_time_unix_nanos
			.map(|value| value as f64 / 1_000_000_000.0),
		accessed: value
			.accessed_time_unix_nanos
			.map(|value| value as f64 / 1_000_000_000.0),
		created: value
			.created_time_unix_nanos
			.map(|value| value as f64 / 1_000_000_000.0),
	})?
	.into_any())
}

fn exec_status(py: Python<'_>, value: &env_pb::ExecStatusMsg) -> PyResult<Py<PyAny>> {
	let result = PyDict::new(py);
	let outcome = match env_pb::ExecOutcome::try_from(value.outcome) {
		Ok(env_pb::ExecOutcome::Exited) => "exited",
		Ok(env_pb::ExecOutcome::Timeout) => "timeout",
		Ok(env_pb::ExecOutcome::Cancelled) => "cancelled",
		Ok(env_pb::ExecOutcome::Denied) => "denied",
		_ => "failed",
	};
	result.set_item("outcome", outcome)?;
	result.set_item("exit_code", value.exit_code)?;
	result.set_item("signal", &value.signal)?;
	result.set_item(
		"wall",
		Py::new(py, PyDuration(Duration::new(value.wall_clock_ms, DurationUnit::Milliseconds)))?,
	)?;
	result.set_item("output", PyBytes::new(py, &[]))?;
	if let Some(artifact) = &value.spilled_output {
		let hash = <[u8; 32]>::try_from(artifact.hash.as_ref())
			.map_err(|_| PyRuntimeError::new_err("Environment returned an invalid blob hash"))?;
		result.set_item("artifact", Py::new(py, PyBlobRef { hash, size: artifact.size })?)?;
	} else {
		result.set_item("artifact", py.None())?;
	}
	result.set_item("aborted", value.aborted)?;
	Ok(result.unbind().into_any())
}

fn process_info(py: Python<'_>, value: &env_pb::ProcessInfo) -> PyResult<Py<PyAny>> {
	let result = PyDict::new(py);
	result.set_item("name", &value.name)?;
	result.set_item("generation", value.generation)?;
	let state = match env_pb::ProcessState::try_from(value.state) {
		Ok(env_pb::ProcessState::Starting) => "starting",
		Ok(env_pb::ProcessState::Ready) => "ready",
		Ok(env_pb::ProcessState::Running) => "running",
		Ok(env_pb::ProcessState::Exited) => "exited",
		Ok(env_pb::ProcessState::Stopped) => "stopped",
		_ => "failed",
	};
	result.set_item("state", state)?;
	if let Some(status) = &value.status {
		result.set_item("status", exec_status(py, status)?)?;
	} else {
		result.set_item("status", py.None())?;
	}
	Ok(result.unbind().into_any())
}
#[derive(Debug)]
enum NativeStream {
	Document(Arc<Mutex<DocumentLease>>),
	Lsp(LspEvents),
	Exec(Arc<Mutex<ExecRun>>),
	Process(ProcessAttachment, bool),
	Blob(BlobDownload),
	Walk(WalkStream),
	Search(SearchStream),
}

#[derive(Debug)]
enum NativeStreamItem {
	Document(document_pb::DocumentEvent),
	Lsp(LspStreamEvent),
	Exec(ExecEvent),
	Process(ProcessAttachmentEvent),
	Blob(BlobDownloadEvent),
	Walk(WalkEvent),
	Search(SearchEvent),
}

impl NativeStream {
	async fn next(&mut self) -> Result<Option<NativeStreamItem>, ClientError> {
		loop {
			let item = match self {
				Self::Document(lease) => lease
					.lock()
					.events()
					.next_event()
					.await?
					.map(NativeStreamItem::Document),
				Self::Lsp(stream) => stream.next_event().await?.map(NativeStreamItem::Lsp),
				Self::Exec(run) => run.lock().next_event().await?.map(NativeStreamItem::Exec),
				Self::Process(stream, states_only) => {
					let event = stream.next_event().await?;
					match event {
						Some(ProcessAttachmentEvent::Output(_)) if *states_only => continue,
						Some(ProcessAttachmentEvent::State(_)) if !*states_only => continue,
						event => event.map(NativeStreamItem::Process),
					}
				},
				Self::Blob(stream) => stream.next_event().await?.map(NativeStreamItem::Blob),
				Self::Walk(stream) => stream.next_event().await?.map(NativeStreamItem::Walk),
				Self::Search(stream) => stream.next_event().await?.map(NativeStreamItem::Search),
			};
			match item {
				Some(
					NativeStreamItem::Exec(ExecEvent::Started(_))
					| NativeStreamItem::Process(ProcessAttachmentEvent::Attached(_))
					| NativeStreamItem::Blob(BlobDownloadEvent::Complete(_))
					| NativeStreamItem::Walk(WalkEvent::Complete(_))
					| NativeStreamItem::Search(SearchEvent::Complete(_)),
				) => continue,
				Some(NativeStreamItem::Lsp(LspStreamEvent::Bindings(_))) => continue,
				item => return Ok(item),
			}
		}
	}
}

#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
struct PyEnvironmentStream {
	stream: Mutex<Option<NativeStream>>,
}

#[pymethods]
impl PyEnvironmentStream {
	const fn __iter__(slf: Py<Self>) -> Py<Self> {
		slf
	}

	fn __next__(&self, py: Python<'_>) -> PyResult<Option<Py<PyAny>>> {
		let result = py.detach(|| {
			let mut state = self.stream.lock();
			let Some(stream) = state.as_mut() else {
				return Ok(None);
			};
			let item = ASYNC_RUNTIME.block_on(stream.next())?;
			if item.is_none() {
				state.take();
			}
			Ok::<_, ClientError>(item)
		});
		match result {
			Ok(Some(item)) => native_stream_item(py, item).map(Some),
			Ok(None) => Ok(None),
			Err(error) => {
				self.stream.lock().take();
				Err(client_error(py, error))
			},
		}
	}

	fn close(&self) {
		self.stream.lock().take();
	}
}

fn output_channel(value: i32) -> &'static str {
	match OutputChannel::try_from(value) {
		Ok(OutputChannel::Stdout) => "stdout",
		Ok(OutputChannel::Stderr) => "stderr",
		Ok(OutputChannel::Pty) => "pty",
		_ => "stdout",
	}
}

fn lsp_binding(py: Python<'_>, value: document_pb::LspServerBinding) -> PyResult<Py<PyAny>> {
	let result = PyDict::new(py);
	result.set_item("server_id", PyBytes::new(py, &value.server_id))?;
	result.set_item("name", value.name)?;
	let sync = value.sync_policy.unwrap_or_default();
	let policy = PyDict::new(py);
	policy.set_item("change", match document_pb::TextDocumentSyncKind::try_from(sync.change) {
		Ok(document_pb::TextDocumentSyncKind::TextDocumentSyncFull) => "full",
		Ok(document_pb::TextDocumentSyncKind::TextDocumentSyncIncremental) => "incremental",
		_ => "none",
	})?;
	policy.set_item("open_close", sync.open_close)?;
	policy.set_item("will_save", sync.will_save)?;
	policy.set_item("will_save_wait_until", sync.will_save_wait_until)?;
	policy.set_item("save", sync.save)?;
	policy.set_item("save_include_text", sync.save_include_text)?;
	policy.set_item("position_encoding", sync.position_encoding)?;
	result.set_item("sync_policy", policy)?;
	let json = py.import("json")?;
	result.set_item(
		"capabilities",
		json.call_method1("loads", (str::from_utf8(&value.capabilities_json).unwrap_or("{}"),))?,
	)?;
	Ok(result.unbind().into_any())
}

fn native_stream_item(py: Python<'_>, item: NativeStreamItem) -> PyResult<Py<PyAny>> {
	let result = PyDict::new(py);
	match item {
		NativeStreamItem::Document(event) => {
			result.set_item("sequence", event.event_sequence)?;
			result.set_item("kind", match document_pb::DocumentEventKind::try_from(event.kind) {
				Ok(document_pb::DocumentEventKind::Committed) => "committed",
				Ok(document_pb::DocumentEventKind::ExternalCreated) => "external_created",
				Ok(document_pb::DocumentEventKind::ExternalModified) => "external_modified",
				Ok(document_pb::DocumentEventKind::ExternalDeleted) => "external_deleted",
				Ok(document_pb::DocumentEventKind::ExternalRenamed) => "external_renamed",
				_ => "watch_rescanned",
			})?;
			result.set_item(
				"revision",
				revision_value(py, event.head.as_ref().and_then(|head| head.revision.as_ref()))?,
			)?;
			result
				.set_item("previous_revision", revision_value(py, event.previous_revision.as_ref())?)?;
			result.set_item(
				"txn_id",
				if event.transaction_id.is_empty() {
					py.None()
				} else {
					PyBytes::new(py, &event.transaction_id).unbind().into_any()
				},
			)?;
			let invalidated = PyTuple::new(
				py,
				event
					.invalidated_transaction_ids
					.iter()
					.map(|id| PyBytes::new(py, id)),
			)?;
			result.set_item("invalidated_txn_ids", invalidated)?;
			result.set_item(
				"previous_path",
				if event.previous_uri.is_empty() {
					py.None()
				} else {
					path_value(py, &event.previous_uri)?.into_any()
				},
			)?;
		},
		NativeStreamItem::Exec(ExecEvent::Output(event)) => {
			result.set_item("channel", output_channel(event.channel))?;
			result.set_item("data", PyBytes::new(py, &event.data))?;
			result.set_item("sequence", event.sequence)?;
		},
		NativeStreamItem::Exec(ExecEvent::Exit(event)) => {
			result.set_item(
				"status",
				exec_status(
					py,
					event
						.status
						.as_ref()
						.ok_or_else(|| PyRuntimeError::new_err("Environment omitted exec status"))?,
				)?,
			)?;
		},
		NativeStreamItem::Process(ProcessAttachmentEvent::Output(event)) => {
			result.set_item("generation", event.generation)?;
			result.set_item("channel", output_channel(event.channel))?;
			result.set_item("data", PyBytes::new(py, &event.data))?;
			result.set_item("sequence", event.sequence)?;
		},
		NativeStreamItem::Process(ProcessAttachmentEvent::State(event)) => {
			return process_info(
				py,
				event
					.process
					.as_ref()
					.ok_or_else(|| PyRuntimeError::new_err("Environment omitted process state"))?,
			);
		},
		NativeStreamItem::Blob(BlobDownloadEvent::Chunk(chunk)) => {
			return Ok(PyBytes::new(py, &chunk.data).unbind().into_any());
		},
		NativeStreamItem::Walk(WalkEvent::Entry(entry)) => {
			result.set_item("path", path_value(py, &entry.path)?)?;
			result.set_item("kind", match document_pb::FileKind::try_from(entry.kind) {
				Ok(document_pb::FileKind::RegularFile) => "file",
				Ok(document_pb::FileKind::Directory) => "directory",
				Ok(document_pb::FileKind::SymbolicLink) => "symlink",
				_ => "other",
			})?;
			result.set_item("size", entry.size.map(|value| value as u64))?;
			result.set_item("mtime_ms", entry.mtime_ms)?;
			result.set_item("depth", entry.depth)?;
		},
		NativeStreamItem::Search(SearchEvent::Match(value)) => {
			result.set_item("path", path_value(py, &value.path)?)?;
			result.set_item("line", value.line)?;
			result.set_item("byte_offset", value.byte_offset)?;
			result.set_item("line_bytes", PyBytes::new(py, &value.line_bytes))?;
		},
		NativeStreamItem::Lsp(LspStreamEvent::Bindings(bindings)) => {
			let values = PyList::empty(py);
			for binding in bindings.bindings {
				values.append(lsp_binding(py, binding)?)?;
			}
			return Ok(values.unbind().into_any());
		},
		NativeStreamItem::Lsp(LspStreamEvent::Event(event)) => {
			result.set_item("server_id", PyBytes::new(py, &event.server_id))?;
			result.set_item("method", event.method)?;
			let json = py.import("json")?;
			result.set_item(
				"params",
				json.call_method1("loads", (str::from_utf8(&event.params_json).unwrap_or("null"),))?,
			)?;
			result.set_item("path", event.document.map(|value| value.uri))?;
			result.set_item("revision", revision_value(py, event.revision.as_ref())?)?;
		},
		NativeStreamItem::Lsp(LspStreamEvent::Binding(event)) => {
			result.set_item("kind", match document_pb::LspBindingEventKind::try_from(event.kind) {
				Ok(document_pb::LspBindingEventKind::Ready) => "ready",
				Ok(document_pb::LspBindingEventKind::PolicyChanged) => "policy_changed",
				Ok(document_pb::LspBindingEventKind::Restarted) => "restarted",
				_ => "stopped",
			})?;
			result.set_item(
				"binding",
				lsp_binding(
					py,
					event
						.binding
						.ok_or_else(|| PyRuntimeError::new_err("Environment omitted LSP binding"))?,
				)?,
			)?;
			result.set_item("path", event.document.map(|value| value.uri))?;
		},
		NativeStreamItem::Exec(ExecEvent::Started(_))
		| NativeStreamItem::Process(ProcessAttachmentEvent::Attached(_))
		| NativeStreamItem::Blob(BlobDownloadEvent::Complete(_))
		| NativeStreamItem::Walk(WalkEvent::Complete(_))
		| NativeStreamItem::Search(SearchEvent::Complete(_)) => unreachable!(),
	}
	Ok(result.unbind().into_any())
}
fn optional_bool(arguments: &Bound<'_, PyDict>, name: &str, default: bool) -> PyResult<bool> {
	arguments
		.get_item(name)?
		.map(|value| value.extract::<bool>())
		.transpose()
		.map(|value| value.unwrap_or(default))
}

fn walk_request(arguments: &Bound<'_, PyDict>) -> PyResult<env_pb::WalkRequest> {
	let include = arguments
		.get_item("include")?
		.map(|value| value.extract::<Vec<String>>())
		.transpose()?
		.unwrap_or_default();
	let exclude = arguments
		.get_item("exclude")?
		.map(|value| value.extract::<Vec<String>>())
		.transpose()?
		.unwrap_or_default();
	let limit = arguments
		.get_item("limit")?
		.filter(|value| !value.is_none())
		.map(|value| value.extract::<u64>())
		.transpose()?;
	let follow_links = match arguments
		.get_item("follow")?
		.map(|value| value.extract::<String>())
		.transpose()?
		.as_deref()
	{
		Some("files") => env_pb::WalkFollowLinks::Roots,
		Some("all") => env_pb::WalkFollowLinks::Always,
		_ => env_pb::WalkFollowLinks::Never,
	};
	let detail = match arguments
		.get_item("detail")?
		.map(|value| value.extract::<String>())
		.transpose()?
		.as_deref()
	{
		Some("metadata") => env_pb::WalkDetail::Full,
		_ => env_pb::WalkDetail::Minimal,
	};
	let order = match arguments
		.get_item("order")?
		.map(|value| value.extract::<String>())
		.transpose()?
		.as_deref()
	{
		Some("breadth_first") => env_pb::WalkOrder::Path,
		_ => env_pb::WalkOrder::Native,
	};
	Ok(env_pb::WalkRequest {
		options: Some(env_pb::WalkOptionsMsg {
			include_hidden:    optional_bool(arguments, "hidden", false)?,
			use_gitignore:     optional_bool(arguments, "gitignore", true)?,
			skip_git:          optional_bool(arguments, "skip_git", true)?,
			skip_node_modules: optional_bool(arguments, "skip_node_modules", true)?,
			follow_links:      follow_links as i32,
			detail:            detail as i32,
			order:             order as i32,
			emit_root:         optional_bool(arguments, "emit_root", false)?,
			min_depth:         arguments
				.get_item("min_depth")?
				.map(|value| value.extract::<u64>())
				.transpose()?
				.unwrap_or(0),
			max_depth:         arguments
				.get_item("max_depth")?
				.filter(|value| !value.is_none())
				.map(|value| value.extract::<u64>())
				.transpose()?
				.unwrap_or(u64::MAX),
			contents_first:    optional_bool(arguments, "contents_first", false)?,
			directory_errors:  env_pb::DirectoryErrorMode::SkipSkippable as i32,
			same_file_system:  optional_bool(arguments, "same_file_system", false)?,
			cache:             optional_bool(arguments, "cache", true)?,
			props:             Default::default(),
		}),
		include,
		exclude,
		limit,
		..Default::default()
	})
}
fn search_request(arguments: &Bound<'_, PyDict>) -> PyResult<env_pb::SearchRequest> {
	let pattern = arguments
		.get_item("pattern")?
		.ok_or_else(|| PyTypeError::new_err("pattern is required"))?;
	let pattern = if let Ok(value) = pattern.extract::<Vec<u8>>() {
		value
	} else {
		pattern.extract::<String>()?.into_bytes()
	};
	Ok(env_pb::SearchRequest {
		walk:           Some(walk_request(arguments)?),
		pattern:        pattern.into(),
		case_sensitive: optional_bool(arguments, "case_sensitive", true)?,
		limit:          arguments
			.get_item("limit")?
			.filter(|value| !value.is_none())
			.map(|value| value.extract::<u64>())
			.transpose()?,
		props:          Default::default(),
	})
}
#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
struct PyBlobUpload {
	upload: Mutex<Option<BlobUpload>>,
}

impl PyBlobUpload {
	fn take(&self, py: Python<'_>) -> PyResult<BlobUpload> {
		self
			.upload
			.lock()
			.take()
			.ok_or_else(|| environment_exception(py, "PreconditionFailed", "blob upload is closed"))
	}
}

#[pyclass(frozen, module = "_omp")]
#[derive(Debug)]
struct PyEnvironmentBackend {
	client:    ExtensionEnvClient,
	root:      EnvPath,
	endpoints: RwLock<BTreeMap<(String, u64), String>>,
	documents: Mutex<BTreeMap<Vec<u8>, Arc<Mutex<DocumentLease>>>>,
	runs:      Mutex<BTreeMap<Vec<u8>, Arc<Mutex<ExecRun>>>>,
}

impl PyEnvironmentBackend {
	fn remember(&self, name: &str, generation: u64, endpoint: Option<&str>) {
		let mut values = self.endpoints.write();
		let key = (name.to_owned(), generation);
		if let Some(endpoint) = endpoint {
			values.insert(key, endpoint.to_owned());
		} else {
			values.remove(&key);
		}
	}

	fn forward_request(
		&self,
		py: Python<'_>,
		operation: &str,
		names: &[&str],
		args: &Bound<'_, PyTuple>,
		kwargs: Option<&Bound<'_, PyDict>>,
	) -> PyResult<Py<PyAny>> {
		if args.len() > names.len() {
			return Err(PyTypeError::new_err(format!(
				"{operation} takes at most {} positional arguments",
				names.len()
			)));
		}
		let arguments = PyDict::new(py);
		if let Some(kwargs) = kwargs {
			for (key, value) in kwargs {
				arguments.set_item(key, value)?;
			}
		}
		for (index, value) in args.iter().enumerate() {
			arguments.set_item(names[index], value)?;
		}
		self.request(py, operation, &arguments)
	}

	fn forward_stream(
		&self,
		py: Python<'_>,
		operation: &str,
		names: &[&str],
		args: &Bound<'_, PyTuple>,
		kwargs: Option<&Bound<'_, PyDict>>,
	) -> PyResult<Py<PyAny>> {
		if args.len() > names.len() {
			return Err(PyTypeError::new_err(format!(
				"{operation} takes at most {} positional arguments",
				names.len()
			)));
		}
		let arguments = PyDict::new(py);
		if let Some(kwargs) = kwargs {
			for (key, value) in kwargs {
				arguments.set_item(key, value)?;
			}
		}
		for (index, value) in args.iter().enumerate() {
			arguments.set_item(names[index], value)?;
		}
		self.stream(py, operation, &arguments)
	}

	fn start_process_request(
		&self,
		arguments: &Bound<'_, PyDict>,
	) -> PyResult<(env_pb::StartProcess, EnvPath)> {
		let name = arguments
			.get_item("name")?
			.ok_or_else(|| PyTypeError::new_err("name is required"))?
			.extract::<String>()?;
		let script = arguments
			.get_item("script")?
			.ok_or_else(|| PyTypeError::new_err("script is required"))?
			.extract::<String>()?;
		let cwd = arguments
			.get_item("cwd")?
			.map(|value| value.extract::<Option<PyEnvPath>>().map_err(PyErr::from))
			.transpose()?
			.flatten()
			.map_or_else(|| self.root.clone(), |value| value.0);
		let env = arguments
			.get_item("env")?
			.map(|value| value.extract::<Option<BTreeMap<String, String>>>())
			.transpose()?
			.flatten()
			.unwrap_or_default();
		let pty = arguments
			.get_item("pty")?
			.filter(|value| !value.is_none())
			.map(|value| -> PyResult<env_pb::PtySpec> {
				Ok(env_pb::PtySpec {
					rows:     value.getattr("rows")?.extract()?,
					columns:  value.getattr("columns")?.extract()?,
					terminal: value.getattr("terminal")?.extract()?,
					props:    Default::default(),
				})
			})
			.transpose()?;
		let restart = arguments
			.get_item("restart")?
			.filter(|value| !value.is_none())
			.map(|value| {
				let policy = match value.getattr("policy")?.extract::<String>()?.as_str() {
					"no" => env_pb::RestartPolicy::Never,
					"on-failure" => env_pb::RestartPolicy::OnFailure,
					"always" => env_pb::RestartPolicy::Always,
					_ => return Err(PyValueError::new_err("invalid restart policy")),
				};
				Ok(env_pb::RestartSpec {
					policy:       policy as i32,
					delay_ms:     duration_millis(&value.getattr("delay")?)?,
					max_restarts: value.getattr("max_restarts")?.extract()?,
					props:        Default::default(),
				})
			})
			.transpose()?
			.unwrap_or_default();
		let mut ready = Vec::new();
		if let Some(value) = arguments
			.get_item("ready")?
			.filter(|value| !value.is_none())
		{
			append_ready_probes(&value, &mut ready)?;
		}
		Ok((
			env_pb::StartProcess {
				name,
				spec: Some(env_pb::ProcessSpec {
					source: Some(env_pb::Script { text: script, props: Default::default() }),
					cwd_uri: path_uri(cwd.as_str())?,
					env_delta: Some(env_pb::EnvironmentDelta {
						set:   env,
						unset: Vec::new(),
						props: Default::default(),
					}),
					pty,
					restart: Some(restart),
					detached: false,
					persist: false,
					timeout_ms: None,
					props: Default::default(),
				}),
				ready,
				props: Default::default(),
			},
			cwd,
		))
	}

	fn document_operation(
		&self,
		op: document_op::Op,
	) -> Result<document_result::Result, ClientError> {
		ASYNC_RUNTIME.block_on(async {
			let response = self
				.client
				.request(env_pb::DataRequest {
					body:  Some(data_request::Body::Document(env_pb::DocumentOp {
						op:    Some(op),
						props: Default::default(),
					})),
					props: Default::default(),
				})
				.await?;
			match response.body {
				Some(data_response::Body::Document(result)) => result
					.result
					.ok_or(ClientError::UnexpectedResponse { expected: "DocumentResult" }),
				_ => Err(ClientError::UnexpectedResponse { expected: "DocumentResult" }),
			}
		})
	}

	fn read_path(&self, path: &EnvPath) -> Result<Vec<u8>, ClientError> {
		let client = self.client.clone();
		let path = path.clone();
		ASYNC_RUNTIME.block_on(async move {
			let lease = client.open_document(&path, None).await?;
			let read = client.read_document(&lease, None, None).await?;
			read
				.content()
				.map(|content| content.to_vec())
				.ok_or(ClientError::UnexpectedResponse { expected: "whole-document bytes" })
		})
	}

	fn upload(&self, bytes: Vec<u8>) -> Result<blob_pb::PutResponse, ClientError> {
		let client = self.client.clone();
		ASYNC_RUNTIME.block_on(async move {
			let upload = client.blob_put()?;
			for chunk in bytes.chunks(64 * 1024) {
				upload
					.send_chunk(blob_pb::Chunk {
						data: chunk.to_vec().into(),
						hash: Default::default(),
						size: None,
					})
					.await?;
			}
			upload.commit().await
		})
	}

	fn upload_path(&self, path: &EnvPath) -> Result<blob_pb::PutResponse, ClientError> {
		const CHUNK_SIZE: u64 = 64 * 1024;

		let client = self.client.clone();
		let path = path.clone();
		ASYNC_RUNTIME.block_on(async move {
			let lease = client.open_document(&path, None).await?;
			let length = lease.head().byte_length;
			let upload = client.blob_put()?;
			let mut offset = 0;
			while offset < length {
				let end = offset.saturating_add(CHUNK_SIZE).min(length);
				let read = client
					.read_document(
						&lease,
						None,
						Some(document_pb::ReadSelection {
							selection: Some(read_selection::Selection::Bytes(
								document_pb::ByteRangeSelection {
									ranges: vec![document_pb::ByteRange { start: offset, end }],
								},
							)),
						}),
					)
					.await?;
				let slices = read
					.slices()
					.ok_or(ClientError::UnexpectedResponse { expected: "document byte-range slices" })?;
				for slice in &slices.slices {
					upload
						.send_chunk(blob_pb::Chunk {
							data: slice.content.clone(),
							hash: Default::default(),
							size: None,
						})
						.await?;
				}
				offset = end;
			}
			upload.commit().await
		})
	}

	fn transaction_request(
		&self,
		arguments: &Bound<'_, PyDict>,
	) -> PyResult<document_pb::CommitTransactionRequest> {
		let transaction_id = arguments
			.get_item("txn_id")?
			.filter(|value| !value.is_none())
			.map(|value| value.extract::<Vec<u8>>())
			.transpose()?
			.unwrap_or_else(fresh_transaction_id);
		let mut mutations = Vec::new();
		let operations = arguments
			.get_item("operations")?
			.ok_or_else(|| PyTypeError::new_err("operations are required"))?;
		for operation in operations.try_iter()? {
			let operation = operation?;
			let (kind, values) = if let Ok(tuple) = operation.cast::<PyTuple>() {
				(tuple.get_item(0)?.extract::<String>()?, tuple.get_item(1)?.cast_into::<PyDict>()?)
			} else {
				let kind = operation.getattr("kind")?.extract::<String>()?;
				let values = PyDict::new(operation.py());
				for name in ["lease", "ops", "path", "content", "destination", "format"] {
					if operation.hasattr(name)? {
						let value = operation.getattr(name)?;
						if !value.is_none() {
							values.set_item(name, value)?;
						}
					}
				}
				(kind, values)
			};
			let format_policy = match values
				.get_item("format")?
				.map(|value| value.extract::<String>())
				.transpose()?
				.as_deref()
			{
				Some("required") => document_pb::FormatPolicy::Required,
				Some("best_effort") => document_pb::FormatPolicy::BestEffort,
				_ => document_pb::FormatPolicy::Disabled,
			};
			if kind == "create" {
				let path = values
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("create path is required"))?
					.extract::<PyEnvPath>()?;
				let content = values
					.get_item("content")?
					.ok_or_else(|| PyTypeError::new_err("create content is required"))?;
				let content = if let Ok(bytes) = content.extract::<Vec<u8>>() {
					bytes
				} else {
					content.extract::<String>()?.into_bytes()
				};
				mutations.push(document_pb::DocumentMutation {
					document:  Some(document_pb::DocumentTarget {
						target: Some(document_target::Target::Uri(path_uri(path.0.as_str())?)),
					}),
					operation: Some(document_mutation::Operation::Create(document_pb::CreateMutation {
						content:           content.into(),
						existing_document: document_pb::ExistingDocumentPolicy::FailIfExists as i32,
						format_policy:     format_policy as i32,
					})),
				});
				continue;
			}
			let lease_id = values
				.get_item("lease")?
				.ok_or_else(|| PyTypeError::new_err("document lease is required"))?
				.extract::<Vec<u8>>()?;
			let lease = self
				.documents
				.lock()
				.get(&lease_id)
				.cloned()
				.ok_or_else(|| PyValueError::new_err("document lease is closed"))?;
			let revision = lease
				.lock()
				.head()
				.revision
				.clone()
				.ok_or_else(|| PyRuntimeError::new_err("document lease has no revision"))?;
			let target = document_pb::DocumentTarget {
				target: Some(document_target::Target::LeaseId(lease_id.clone().into())),
			};
			let mutation = match kind.as_str() {
				"edit" => {
					let edits = values
						.get_item("ops")?
						.ok_or_else(|| PyTypeError::new_err("edit operations are required"))?
						.try_iter()?
						.map(|edit| {
							let edit = edit?;
							Ok(document_pb::ByteEdit {
								start:       edit.getattr("start")?.extract()?,
								end:         edit.getattr("end")?.extract()?,
								replacement: edit.getattr("replacement")?.extract::<Vec<u8>>()?.into(),
							})
						})
						.collect::<PyResult<Vec<_>>>()?;
					document_mutation::Operation::Text(document_pb::TextMutation {
						base_revision: Some(revision),
						change:        Some(text_mutation::Change::Edits(document_pb::ByteEdits {
							edits,
						})),
						stale_policy:  document_pb::StalePolicy::Fail as i32,
						format_policy: format_policy as i32,
					})
				},
				"write" => {
					let content = values
						.get_item("content")?
						.ok_or_else(|| PyTypeError::new_err("write content is required"))?;
					let content = if let Ok(bytes) = content.extract::<Vec<u8>>() {
						bytes
					} else {
						content.extract::<String>()?.into_bytes()
					};
					document_mutation::Operation::Text(document_pb::TextMutation {
						base_revision: Some(revision),
						change:        Some(text_mutation::Change::ProposedContent(content.into())),
						stale_policy:  document_pb::StalePolicy::Fail as i32,
						format_policy: format_policy as i32,
					})
				},
				"delete" => document_mutation::Operation::Delete(document_pb::DeleteMutation {
					base_revision: Some(revision),
				}),
				"move" => {
					let destination = values
						.get_item("destination")?
						.ok_or_else(|| PyTypeError::new_err("move destination is required"))?
						.extract::<PyEnvPath>()?;
					document_mutation::Operation::Move(document_pb::MoveMutation {
						base_revision:            Some(revision),
						destination_uri:          path_uri(destination.0.as_str())?,
						destination_precondition: Some(DestinationPrecondition::DestinationMustNotExist(
							true,
						)),
					})
				},
				_ => return Err(PyValueError::new_err("invalid transaction operation")),
			};
			mutations.push(document_pb::DocumentMutation {
				document:  Some(target),
				operation: Some(mutation),
			});
		}
		Ok(document_pb::CommitTransactionRequest {
			transaction_id: transaction_id.into(),
			operations:     mutations,
		})
	}
}

macro_rules! backend_methods {
	($($table:tt)*) => {
		emit_backend_methods! {
			custom {
	fn process_endpoint(&self, name: &str, generation: u64) -> Option<String> {
		self
			.endpoints
			.read()
			.get(&(name.to_owned(), generation))
			.cloned()
	}

	fn session(&self, py: Python<'_>, arguments: &Bound<'_, PyDict>) -> PyResult<Py<PyAny>> {
		let cwd = arguments
			.get_item("cwd")?
			.filter(|value| !value.is_none())
			.map(|value| value.extract::<PyEnvPath>().map_err(PyErr::from))
			.transpose()?
			.map_or_else(|| self.root.clone(), |path| path.0);
		let env = arguments
			.get_item("env")?
			.filter(|value| !value.is_none())
			.map(|value| value.extract::<BTreeMap<String, String>>())
			.transpose()?
			.unwrap_or_default();
		let pty = arguments
			.get_item("pty")?
			.filter(|value| !value.is_none())
			.map(|value| -> PyResult<env_pb::PtySpec> {
				Ok(env_pb::PtySpec {
					rows:     value.getattr("rows")?.extract()?,
					columns:  value.getattr("columns")?.extract()?,
					terminal: value.getattr("terminal")?.extract()?,
					props:    Default::default(),
				})
			})
			.transpose()?;
		let response = block_on_data(self.client.open_session(&cwd, env_pb::OpenSessionRequest {
			env_delta: Some(env_pb::EnvironmentDelta {
				set:   env,
				unset: Vec::new(),
				props: Default::default(),
			}),
			pty,
			..Default::default()
		}))
		.map_err(|error| client_error(py, error))?;
		let result = PyDict::new(py);
		result.set_item("id", PyBytes::new(py, &response.session))?;
		result.set_item("cwd", path_value(py, &response.cwd_uri)?)?;
		Ok(result.unbind().into_any())
	}

	fn blob_writer(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
		let upload = self
			.client
			.blob_put()
			.map_err(|error| client_error(py, error))?;
		Ok(Py::new(py, PyBlobUpload { upload: Mutex::new(Some(upload)) })?.into_any())
	}

	fn abort_blob(&self, upload: &PyBlobUpload) {
		if let Some(upload) = upload.upload.lock().take() {
			upload.abort();
		}
	}

	fn cancel_run(&self, run_id: &[u8]) {
		self.runs.lock().remove(run_id);
	}

	fn parse_script(&self, py: Python<'_>, _script: &str) -> PyResult<Py<PyAny>> {
		Err(environment_exception(
			py,
			"Unsupported",
			"the Environment protocol does not expose a parse-only capability",
		))
	}

	fn request(
		&self,
		py: Python<'_>,
		operation: &str,
		arguments: &Bound<'_, PyDict>,
	) -> PyResult<Py<PyAny>> {
		match operation {
			"omp.env.worktree" => {
				let response = ASYNC_RUNTIME
					.block_on(self.client.current_worktree(env_pb::CurrentWorktree {
						wire_revision: omp_env::SCHEMA_REV,
						props:         Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				let Some(value) = response.primary else {
					return Ok(py.None());
				};
				let result = PyDict::new(py);
				result.set_item("id", value.id)?;
				result.set_item("root", value.root_uri)?;
				result.set_item("base", value.base)?;
				result.set_item("generation", value.generation)?;
				Ok(result.unbind().into_any())
			},
			"omp.env.docs.open" => {
				if arguments
					.get_item("create")?
					.map(|value| value.extract::<bool>())
					.transpose()?
					.unwrap_or(false)
				{
					let path = arguments
						.get_item("path")?
						.ok_or_else(|| PyTypeError::new_err("path is required"))?
						.extract::<PyEnvPath>()?;
					let request = document_pb::CommitTransactionRequest {
						transaction_id: fresh_transaction_id().into(),
						operations:     vec![document_pb::DocumentMutation {
							document:  Some(document_pb::DocumentTarget {
								target: Some(document_target::Target::Uri(path_uri(path.0.as_str())?)),
							}),
							operation: Some(document_mutation::Operation::Create(
								document_pb::CreateMutation {
									content:           Default::default(),
									existing_document: document_pb::ExistingDocumentPolicy::FailIfExists
										as i32,
									format_policy:     document_pb::FormatPolicy::Disabled as i32,
								},
							)),
						}],
					};
					match ASYNC_RUNTIME
						.block_on(self.client.commit_transaction(request))
						.map_err(|error| client_error(py, error))?
					{
						TransactionOutcome::Committed(_) => {},
						TransactionOutcome::Rejected(value) => {
							return Err(environment_exception(py, "PreconditionFailed", &value.message));
						},
						TransactionOutcome::Partial(value) => {
							return Err(environment_exception(py, "Partial", &value.message));
						},
					}
				}
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let language = arguments
					.get_item("language")?
					.map(|value| value.extract::<Option<String>>())
					.transpose()?
					.flatten();
				let lease = ASYNC_RUNTIME
					.block_on(self.client.open_document(&path.0, language.as_deref()))
					.map_err(|error| client_error(py, error))?;
				let lease_id = lease.id().to_vec();
				let revision = revision_value(py, lease.head().revision.as_ref())?;
				self
					.documents
					.lock()
					.insert(lease_id.clone(), Arc::new(Mutex::new(lease)));
				let result = PyDict::new(py);
				result.set_item("lease", PyBytes::new(py, &lease_id))?;
				result.set_item("revision", revision)?;
				Ok(result.unbind().into_any())
			},
			"omp.env.docs.Doc.read_bytes" | "omp.env.docs.Doc.refresh" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let revision = argument_revision(arguments, "revision")?;
				let documents = self.documents.lock();
				let lease = documents
					.get(&lease_id)
					.ok_or_else(|| environment_exception(py, "Stale", "document lease is closed"))?;
				let read = ASYNC_RUNTIME
					.block_on(self.client.read_document(&lease.lock(), revision, None))
					.map_err(|error| client_error(py, error))?;
				if operation.ends_with("refresh") {
					return revision_value(py, read.head().revision.as_ref());
				}
				let content = read.content().ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted document content")
				})?;
				Ok(PyBytes::new(py, content).unbind().into_any())
			},
			"omp.env.docs.Doc.lines" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let start = arguments
					.get_item("start")?
					.ok_or_else(|| PyTypeError::new_err("start is required"))?
					.extract::<u64>()?;
				let end = arguments
					.get_item("end")?
					.ok_or_else(|| PyTypeError::new_err("end is required"))?
					.extract::<u64>()?;
				let lease = self
					.documents
					.lock()
					.get(&lease_id)
					.cloned()
					.ok_or_else(|| environment_exception(py, "Stale", "document lease is closed"))?;
				let read = ASYNC_RUNTIME
					.block_on(self.client.read_document(
						&lease.lock(),
						argument_revision(arguments, "revision")?,
						Some(document_pb::ReadSelection {
							selection: Some(read_selection::Selection::Lines(
								document_pb::LineRangeSelection {
									ranges: vec![document_pb::LineRange { start, end }],
								},
							)),
						}),
					))
					.map_err(|error| client_error(py, error))?;
				let slices = read.slices().ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted requested line range")
				})?;
				let values = PyList::empty(py);
				for slice in &slices.slices {
					let text = str::from_utf8(&slice.content)
						.map_err(|_| environment_exception(py, "Invalid", "document is not UTF-8"))?;
					for line in text.lines() {
						values.append(line)?;
					}
				}
				Ok(values.unbind().into_any())
			},
			"omp.env.docs.Doc.summary" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let options = arguments
					.get_item("options")?
					.filter(|value| !value.is_none());
				let options = if let Some(value) = options {
					Some(document_pb::CodeSummaryOptions {
						min_body_lines:     value.getattr("min_body_lines")?.extract()?,
						min_comment_lines:  value.getattr("min_comment_lines")?.extract()?,
						unfold_until_lines: value.getattr("unfold_until_lines")?.extract()?,
						unfold_limit_lines: value.getattr("unfold_limit_lines")?.extract()?,
						enable_prose:       value.getattr("prose")?.extract()?,
						min_total_lines:    value.getattr("min_total_lines")?.extract()?,
						render_mode:        match value.getattr("render")?.extract::<String>()?.as_str() {
							"numbered" => document_pb::SummaryRenderMode::Numbered as i32,
							"plain" => document_pb::SummaryRenderMode::Plain as i32,
							_ => document_pb::SummaryRenderMode::Hashline as i32,
						},
						language:           value
							.getattr("language")?
							.extract::<Option<String>>()?
							.unwrap_or_default(),
					})
				} else {
					Some(document_pb::CodeSummaryOptions::default())
				};
				let result = self
					.document_operation(document_op::Op::Summarize(
						document_pb::SummarizeDocumentRequest {
							document: Some(document_pb::DocumentTarget {
								target: Some(document_target::Target::LeaseId(lease_id.into())),
							}),
							revision: None,
							options,
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Summarized(summary) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong summary result",
					));
				};
				let value = PyDict::new(py);
				match summary.outcome {
					Some(summarize_document_response::Outcome::Summary(summary)) => {
						value.set_item("language", summary.language)?;
						value.set_item("parsed", summary.parsed)?;
						value.set_item("elided", summary.elided)?;
						value.set_item("total_lines", summary.total_lines)?;
						let segments = PyList::empty(py);
						for segment in summary.segments {
							let row = PyDict::new(py);
							row.set_item(
								"kept",
								segment.kind == document_summary_segment::Kind::Kept as i32,
							)?;
							row.set_item("start_line", segment.start_line)?;
							row.set_item("end_line", segment.end_line)?;
							row.set_item("text", segment.text)?;
							segments.append(row)?;
						}
						value.set_item("segments", segments)?;
						let rendered = summary.rendered.unwrap_or_default();
						value.set_item("text", rendered.text)?;
						value.set_item("display_text", rendered.display_text)?;
						value.set_item(
							"elided_ranges",
							rendered
								.elided_ranges
								.into_iter()
								.map(|range| (range.start_line, range.end_line))
								.collect::<Vec<_>>(),
						)?;
						value.set_item("elided_lines", rendered.elided_lines)?;
					},
					Some(summarize_document_response::Outcome::Unavailable(value_)) => {
						value.set_item(
							"reason",
							match document_pb::SummaryUnavailableReason::try_from(value_.reason) {
								Ok(document_pb::SummaryUnavailableReason::Binary) => "binary",
								Ok(document_pb::SummaryUnavailableReason::MissingDocument) => {
									"missing_document"
								},
								Ok(document_pb::SummaryUnavailableReason::TooLarge) => "too_large",
								Ok(document_pb::SummaryUnavailableReason::TooManyLines) => "too_many_lines",
								Ok(document_pb::SummaryUnavailableReason::BelowMinimumLines) => {
									"below_minimum_lines"
								},
								Ok(document_pb::SummaryUnavailableReason::ProseDisabled) => {
									"prose_disabled"
								},
								Ok(document_pb::SummaryUnavailableReason::UnsupportedLanguage) => {
									"unsupported_language"
								},
								Ok(document_pb::SummaryUnavailableReason::Empty) => "empty",
								Ok(document_pb::SummaryUnavailableReason::SyntaxError) => "syntax_error",
								Ok(document_pb::SummaryUnavailableReason::NoElisions) => "no_elisions",
								_ => "parser_failure",
							},
						)?;
						value.set_item("total_lines", value_.total_lines)?;
						value.set_item("language", value_.language)?;
						value.set_item("parsed", value_.parsed)?;
					},
					None => {
						return Err(environment_exception(
							py,
							"Io",
							"Environment omitted summary outcome",
						));
					},
				}
				Ok(value.unbind().into_any())
			},
			"omp.env.docs.Doc.edit" | "omp.env.docs.Doc.write" | "omp.env.docs.Doc.hashline" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let lease = self
					.documents
					.lock()
					.get(&lease_id)
					.cloned()
					.ok_or_else(|| environment_exception(py, "Stale", "document lease is closed"))?;
				let revision =
					lease.lock().head().revision.clone().ok_or_else(|| {
						environment_exception(py, "Io", "document lease has no revision")
					})?;
				let change = if operation.ends_with("edit") {
					let edits = arguments
						.get_item("edits")?
						.ok_or_else(|| PyTypeError::new_err("edits are required"))?
						.try_iter()?
						.map(|edit| {
							let edit = edit?;
							Ok(document_pb::ByteEdit {
								start:       edit.getattr("start")?.extract()?,
								end:         edit.getattr("end")?.extract()?,
								replacement: edit.getattr("replacement")?.extract::<Vec<u8>>()?.into(),
							})
						})
						.collect::<PyResult<Vec<_>>>()?;
					text_mutation::Change::Edits(document_pb::ByteEdits { edits })
				} else if operation.ends_with("write") {
					let data = arguments
						.get_item("data")?
						.ok_or_else(|| PyTypeError::new_err("data is required"))?;
					let data = if let Ok(bytes) = data.extract::<Vec<u8>>() {
						bytes
					} else {
						data.extract::<String>()?.into_bytes()
					};
					text_mutation::Change::ProposedContent(data.into())
				} else {
					text_mutation::Change::Proposal(document_pb::EditFormatProposal {
						format:       "omp.hashline".to_owned(),
						payload:      arguments
							.get_item("patch")?
							.ok_or_else(|| PyTypeError::new_err("patch is required"))?
							.extract::<String>()?
							.into_bytes()
							.into(),
						options_json: b"{}".to_vec().into(),
					})
				};
				let request = document_pb::CommitTransactionRequest {
					transaction_id: fresh_transaction_id().into(),
					operations:     vec![document_pb::DocumentMutation {
						document:  Some(document_pb::DocumentTarget {
							target: Some(document_target::Target::LeaseId(lease_id.into())),
						}),
						operation: Some(document_pb::document_mutation::Operation::Text(
							document_pb::TextMutation {
								base_revision: Some(revision),
								change:        Some(change),
								stale_policy:  document_pb::StalePolicy::Fail as i32,
								format_policy: document_pb::FormatPolicy::Disabled as i32,
							},
						)),
					}],
				};
				match ASYNC_RUNTIME
					.block_on(self.client.commit_transaction(request))
					.map_err(|error| client_error(py, error))?
				{
					TransactionOutcome::Committed(value) => {
						let result = PyDict::new(py);
						result.set_item("txn_id", PyBytes::new(py, &value.transaction_id))?;
						if let Some(operation) = value.operations.first() {
							result.set_item(
								"revision",
								revision_value(
									py,
									operation
										.head
										.as_ref()
										.and_then(|head| head.revision.as_ref()),
								)?,
							)?;
							result.set_item("rebased", operation.rebased)?;
							result.set_item("formatted", operation.formatted)?;
						}
						Ok(result.unbind().into_any())
					},
					TransactionOutcome::Rejected(value) => Err(edit_rejection_exception(py, &value)),
					TransactionOutcome::Partial(value) => {
						Err(environment_exception(py, "Partial", &value.message))
					},
				}
			},
			"omp.env.docs.Doc.close" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let Some(lease) = self.documents.lock().remove(&lease_id) else {
					return Ok(py.None());
				};
				ASYNC_RUNTIME
					.block_on(
						Arc::try_unwrap(lease)
							.map_err(|_| {
								environment_exception(py, "PreconditionFailed", "document stream is active")
							})?
							.into_inner()
							.close(),
					)
					.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.Txn.commit" => {
				let request = self.transaction_request(arguments)?;
				let outcome = ASYNC_RUNTIME
					.block_on(self.client.commit_transaction(request))
					.map_err(|error| client_error(py, error))?;
				match outcome {
					TransactionOutcome::Committed(committed) => {
						let result = PyDict::new(py);
						result.set_item("txn_id", PyBytes::new(py, &committed.transaction_id))?;
						result.set_item("committed", true)?;
						result.set_item("operation_count", committed.operations.len())?;
						Ok(result.unbind().into_any())
					},
					TransactionOutcome::Rejected(rejected) => {
						Err(environment_exception(py, "Stale", &rejected.message))
					},
					TransactionOutcome::Partial(partial) => {
						Err(environment_exception(py, "Partial", &partial.message))
					},
				}
			},
			"omp.env.docs.read_bytes" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let bytes = self
					.read_path(&path.0)
					.map_err(|error| client_error(py, error))?;
				Ok(PyBytes::new(py, &bytes).unbind().into_any())
			},
			"omp.env.fs.stat" | "omp.env.fs.lstat" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let uri = path_uri(path.0.as_str())?;
				let follow_symlinks = if operation.ends_with("lstat") {
					document_pb::FollowSymlinks::No
				} else {
					document_pb::FollowSymlinks::Yes
				};
				let result = self
					.document_operation(document_op::Op::Stat(document_pb::StatPathRequest {
						uri,
						follow_symlinks: follow_symlinks as i32,
					}))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Stat(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong stat result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.fs.canonicalize" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let result = self
					.document_operation(document_op::Op::Canonicalize(
						document_pb::CanonicalizePathRequest { uri: path_uri(path.0.as_str())? },
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Canonicalized(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong canonicalize result",
					));
				};
				Ok(path_value(py, &result.canonical_uri)?.into_any())
			},
			"omp.env.fs.list_dir" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let follow = arguments
					.get_item("follow")?
					.ok_or_else(|| PyTypeError::new_err("follow is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::ListDirectory(
						document_pb::ListDirectoryRequest {
							uri:             path_uri(path.0.as_str())?,
							follow_symlinks: if follow {
								document_pb::FollowSymlinks::Yes as i32
							} else {
								document_pb::FollowSymlinks::No as i32
							},
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Directory(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong directory result",
					));
				};
				let values = PyList::empty(py);
				for entry in result.entries {
					let metadata = entry.metadata.ok_or_else(|| {
						environment_exception(py, "Io", "Environment omitted directory metadata")
					})?;
					let value = PyDict::new(py);
					value.set_item("name", entry.name)?;
					value.set_item("meta", path_metadata(py, &metadata)?)?;
					values.append(value)?;
				}
				Ok(values.unbind().into_any())
			},
			"omp.env.fs.read_link" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let result = self
					.document_operation(document_op::Op::ReadLink(document_pb::ReadLinkRequest {
						uri: path_uri(path.0.as_str())?,
					}))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Link(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong link result",
					));
				};
				let target = result.target.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted symlink target")
				})?;
				let value = PyDict::new(py);
				value.set_item("target", path_value(py, &target.uri)?)?;
				value.set_item(
					"relative",
					target.form == document_pb::SymlinkTargetForm::Relative as i32,
				)?;
				Ok(value.unbind().into_any())
			},
			"omp.env.fs.mkdir" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let parents = arguments
					.get_item("parents")?
					.ok_or_else(|| PyTypeError::new_err("parents is required"))?
					.extract::<bool>()?;
				let exist_ok = arguments
					.get_item("exist_ok")?
					.ok_or_else(|| PyTypeError::new_err("exist_ok is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::CreateDirectory(
						document_pb::CreateDirectoryRequest {
							uri:           path_uri(path.0.as_str())?,
							recursive:     parents,
							existing_leaf: if exist_ok {
								document_pb::ExistingDirectoryPolicy::AllowExistingDirectory as i32
							} else {
								document_pb::ExistingDirectoryPolicy::FailIfExists as i32
							},
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::DirectoryCreated(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong mkdir result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.fs.remove" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let recursive = arguments
					.get_item("recursive")?
					.ok_or_else(|| PyTypeError::new_err("recursive is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::Remove(document_pb::RemovePathRequest {
						uri: path_uri(path.0.as_str())?,
						recursive,
						revision: argument_revision(arguments, "revision")?,
					}))
					.map_err(|error| client_error(py, error))?;
				if !matches!(result, document_result::Result::Removed(_)) {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong remove result",
					));
				}
				Ok(py.None())
			},
			"omp.env.fs.rename" => {
				let src = arguments
					.get_item("src")?
					.ok_or_else(|| PyTypeError::new_err("src is required"))?
					.extract::<PyEnvPath>()?;
				let dest = arguments
					.get_item("dest")?
					.ok_or_else(|| PyTypeError::new_err("dest is required"))?
					.extract::<PyEnvPath>()?;
				let result = self
					.document_operation(document_op::Op::Rename(document_pb::RenamePathRequest {
						source_uri:           path_uri(src.0.as_str())?,
						destination_uri:      path_uri(dest.0.as_str())?,
						overwrite:            argument_overwrite(arguments, "overwrite")? as i32,
						source_revision:      argument_revision(arguments, "src_revision")?,
						destination_revision: argument_revision(arguments, "dest_revision")?,
					}))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Renamed(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong rename result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.fs.copy" => {
				let src = arguments
					.get_item("src")?
					.ok_or_else(|| PyTypeError::new_err("src is required"))?
					.extract::<PyEnvPath>()?;
				let dest = arguments
					.get_item("dest")?
					.ok_or_else(|| PyTypeError::new_err("dest is required"))?
					.extract::<PyEnvPath>()?;
				let follow = arguments
					.get_item("follow")?
					.ok_or_else(|| PyTypeError::new_err("follow is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::Copy(document_pb::CopyPathRequest {
						source_uri:             path_uri(src.0.as_str())?,
						destination_uri:        path_uri(dest.0.as_str())?,
						follow_source_symlinks: if follow {
							document_pb::FollowSymlinks::Yes as i32
						} else {
							document_pb::FollowSymlinks::No as i32
						},
						overwrite:              argument_overwrite(arguments, "overwrite")? as i32,
						destination_revision:   argument_revision(arguments, "dest_revision")?,
					}))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::Copied(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong copy result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				let value = PyDict::new(py);
				value.set_item("meta", path_metadata(py, &metadata)?)?;
				value.set_item("bytes_copied", result.bytes_copied)?;
				Ok(value.unbind().into_any())
			},
			"omp.env.fs.symlink" => {
				let target = arguments
					.get_item("target")?
					.ok_or_else(|| PyTypeError::new_err("target is required"))?
					.extract::<PyEnvPath>()?;
				let link = arguments
					.get_item("link")?
					.ok_or_else(|| PyTypeError::new_err("link is required"))?
					.extract::<PyEnvPath>()?;
				let relative = arguments
					.get_item("relative")?
					.ok_or_else(|| PyTypeError::new_err("relative is required"))?
					.extract::<bool>()?;
				let kind = arguments
					.get_item("kind")?
					.ok_or_else(|| PyTypeError::new_err("kind is required"))?
					.extract::<String>()?;
				let result = self
					.document_operation(document_op::Op::CreateSymlink(
						document_pb::CreateSymlinkRequest {
							target:      Some(document_pb::SymlinkTarget {
								uri:  path_uri(target.0.as_str())?,
								form: if relative {
									document_pb::SymlinkTargetForm::Relative as i32
								} else {
									document_pb::SymlinkTargetForm::Absolute as i32
								},
							}),
							link_uri:    path_uri(link.0.as_str())?,
							target_kind: match kind.as_str() {
								"file" => document_pb::SymlinkTargetKind::File as i32,
								"directory" => document_pb::SymlinkTargetKind::Directory as i32,
								_ => return Err(PyValueError::new_err("invalid symlink target kind")),
							},
							overwrite:   argument_overwrite(arguments, "overwrite")? as i32,
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::SymlinkCreated(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong symlink result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.fs.hard_link" => {
				let src = arguments
					.get_item("src")?
					.ok_or_else(|| PyTypeError::new_err("src is required"))?
					.extract::<PyEnvPath>()?;
				let link = arguments
					.get_item("link")?
					.ok_or_else(|| PyTypeError::new_err("link is required"))?
					.extract::<PyEnvPath>()?;
				let follow = arguments
					.get_item("follow")?
					.ok_or_else(|| PyTypeError::new_err("follow is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::CreateHardLink(
						document_pb::CreateHardLinkRequest {
							source_uri:             path_uri(src.0.as_str())?,
							link_uri:               path_uri(link.0.as_str())?,
							follow_source_symlinks: if follow {
								document_pb::FollowSymlinks::Yes as i32
							} else {
								document_pb::FollowSymlinks::No as i32
							},
							overwrite:              argument_overwrite(arguments, "overwrite")? as i32,
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::HardLinkCreated(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong hard-link result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.fs.chmod" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let read_only = arguments
					.get_item("read_only")?
					.map(|value| value.extract::<Option<bool>>())
					.transpose()?
					.flatten();
				let executable = arguments
					.get_item("executable")?
					.map(|value| value.extract::<Option<bool>>())
					.transpose()?
					.flatten();
				if read_only.is_none() && executable.is_none() {
					return Err(PyValueError::new_err("chmod requires read_only or executable"));
				}
				let follow = arguments
					.get_item("follow")?
					.ok_or_else(|| PyTypeError::new_err("follow is required"))?
					.extract::<bool>()?;
				let result = self
					.document_operation(document_op::Op::SetPermissions(
						document_pb::SetPermissionsRequest {
							uri:             path_uri(path.0.as_str())?,
							permissions:     Some(document_pb::PortablePermissions {
								read_only,
								executable,
							}),
							follow_symlinks: if follow {
								document_pb::FollowSymlinks::Yes as i32
							} else {
								document_pb::FollowSymlinks::No as i32
							},
							revision:        argument_revision(arguments, "revision")?,
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::PermissionsSet(result) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong chmod result",
					));
				};
				let metadata = result.metadata.ok_or_else(|| {
					environment_exception(py, "Io", "Environment omitted path metadata")
				})?;
				path_metadata(py, &metadata)
			},
			"omp.env.lsp.bindings" => {
				let path = arguments
					.get_item("path")?
					.ok_or_else(|| PyTypeError::new_err("path is required"))?
					.extract::<PyEnvPath>()?;
				let lease = ASYNC_RUNTIME
					.block_on(self.client.open_document(&path.0, None))
					.map_err(|error| client_error(py, error))?;
				let lease_id = lease.id().to_vec();
				let result = self
					.document_operation(document_op::Op::GetLspBindings(
						document_pb::GetLspBindingsRequest {
							document: Some(document_pb::DocumentTarget {
								target: Some(document_target::Target::LeaseId(lease.id().clone())),
							}),
						},
					))
					.map_err(|error| client_error(py, error))?;
				let document_result::Result::LspBindings(bindings) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong LSP result",
					));
				};
				self
					.documents
					.lock()
					.insert(lease_id, Arc::new(Mutex::new(lease)));
				let values = PyList::empty(py);
				for binding in bindings.bindings {
					values.append(lsp_binding(py, binding)?)?;
				}
				Ok(values.unbind().into_any())
			},
			"omp.env.lsp.request" | "omp.env.lsp.notify" => {
				let server_id = arguments
					.get_item("server")?
					.ok_or_else(|| PyTypeError::new_err("server is required"))?
					.extract::<Vec<u8>>()?;
				let method = arguments
					.get_item("method")?
					.ok_or_else(|| PyTypeError::new_err("method is required"))?
					.extract::<String>()?;
				let params = arguments
					.get_item("params")?
					.ok_or_else(|| PyTypeError::new_err("params are required"))?;
				let params_json = py
					.import("json")?
					.call_method1("dumps", (params,))?
					.extract::<String>()?
					.into_bytes()
					.into();
				let op = if operation.ends_with("notify") {
					document_op::Op::LspNotification(document_pb::LspNotificationRequest {
						server_id: server_id.into(),
						method,
						params_json,
					})
				} else {
					let doc = arguments.get_item("doc")?.filter(|value| !value.is_none());
					let (document, revision) = if let Some(doc) = doc {
						let lease = doc.getattr("_lease")?.extract::<Vec<u8>>()?;
						let revision = {
							let value = doc.getattr("revision")?;
							if value.is_none() {
								None
							} else {
								Some(document_pb::Revision {
									sequence:     value.getattr("sequence")?.extract()?,
									content_hash: value
										.getattr("content_hash")?
										.extract::<Vec<u8>>()?
										.into(),
								})
							}
						};
						(
							Some(document_pb::DocumentTarget {
								target: Some(document_target::Target::LeaseId(lease.into())),
							}),
							revision,
						)
					} else {
						(None, None)
					};
					let stale = arguments
						.get_item("on_stale")?
						.map(|value| value.extract::<String>())
						.transpose()?
						.unwrap_or_else(|| "retry_head".to_owned());
					document_op::Op::LspRequest(document_pb::LspRequest {
						server_id: server_id.into(),
						method,
						params_json,
						document,
						revision,
						stale_policy: if stale == "fail" {
							document_pb::LspStalePolicy::Fail as i32
						} else {
							document_pb::LspStalePolicy::RetryCurrentHead as i32
						},
					})
				};
				let result = self
					.document_operation(op)
					.map_err(|error| client_error(py, error))?;
				if operation.ends_with("notify") {
					if !matches!(result, document_result::Result::LspNotified(_)) {
						return Err(environment_exception(
							py,
							"Io",
							"Environment returned wrong LSP notification result",
						));
					}
					return Ok(py.None());
				}
				let document_result::Result::LspResponse(response) = result else {
					return Err(environment_exception(
						py,
						"Io",
						"Environment returned wrong LSP response",
					));
				};
				let value = PyDict::new(py);
				value.set_item("revision", revision_value(py, response.revision.as_ref())?)?;
				match response.outcome {
					Some(lsp_response::Outcome::ResultJson(bytes)) => {
						value.set_item(
							"result",
							py.import("json")?
								.call_method1("loads", (str::from_utf8(&bytes).unwrap_or("null"),))?,
						)?;
					},
					Some(lsp_response::Outcome::Error(error)) => {
						let failure = PyDict::new(py);
						failure.set_item("code", error.code)?;
						failure.set_item("message", error.message)?;
						failure.set_item(
							"data",
							py.import("json")?.call_method1(
								"loads",
								(str::from_utf8(&error.data_json).unwrap_or("null"),),
							)?,
						)?;
						value.set_item("error", failure)?;
					},
					None => {
						return Err(environment_exception(py, "Io", "Environment omitted LSP outcome"));
					},
				}
				Ok(value.unbind().into_any())
			},
			"omp.env.Session.run" => {
				let session = arguments
					.get_item("session")?
					.ok_or_else(|| PyTypeError::new_err("session is required"))?
					.extract::<Vec<u8>>()?;
				let script = arguments
					.get_item("script")?
					.ok_or_else(|| PyTypeError::new_err("script is required"))?
					.extract::<String>()?;
				let mut run = block_on_data(self.client.exec(env_pb::ExecRequest {
					session:        session.into(),
					source:         Some(env_pb::Script { text: script, props: Default::default() }),
					output_request: env_pb::OutputRequest::Unspecified as i32,
					props:          Default::default(),
				}))
				.map_err(|error| client_error(py, error))?;
				let started = block_on_data(run.next_event())
					.map_err(|error| client_error(py, error))?
					.ok_or_else(|| {
						environment_exception(py, "Disconnected", "exec stream ended before start")
					})?;
				let ExecEvent::Started(started) = started else {
					return Err(environment_exception(py, "Io", "exec stream omitted start receipt"));
				};
				let id = started.exec.to_vec();
				self
					.runs
					.lock()
					.insert(id.clone(), Arc::new(Mutex::new(run)));
				let result = PyDict::new(py);
				result.set_item("id", PyBytes::new(py, &id))?;
				Ok(result.unbind().into_any())
			},
			"omp.env.Session.close" => {
				let session = arguments
					.get_item("session")?
					.ok_or_else(|| PyTypeError::new_err("session is required"))?
					.extract::<Vec<u8>>()?;
				block_on_data(self.client.close_session(env_pb::CloseSessionRequest {
					session: session.into(),
					props:   Default::default(),
				}))
				.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.Run.stdin" | "omp.env.Run.eof" | "omp.env.Run.signal" | "omp.env.Run.resize" => {
				let run_id = arguments
					.get_item("run")?
					.ok_or_else(|| PyTypeError::new_err("run is required"))?
					.extract::<Vec<u8>>()?;
				let run = self
					.runs
					.lock()
					.get(&run_id)
					.cloned()
					.ok_or_else(|| environment_exception(py, "Stale", "exec run is closed"))?;
				let run = run.lock();
				if operation.ends_with("stdin") || operation.ends_with("eof") {
					let input = if operation.ends_with("eof") {
						stdin_frame::Input::Eof(true)
					} else {
						stdin_frame::Input::Data(
							arguments
								.get_item("data")?
								.ok_or_else(|| PyTypeError::new_err("data is required"))?
								.extract::<Vec<u8>>()?
								.into(),
						)
					};
					ASYNC_RUNTIME.block_on(run.stdin(env_pb::StdinFrame {
						exec:  run_id.into(),
						input: Some(input),
						props: Default::default(),
					}))
				} else if operation.ends_with("signal") {
					ASYNC_RUNTIME.block_on(
						run.signal(env_pb::SignalRequest {
							exec:   run_id.into(),
							signal: arguments
								.get_item("signal")?
								.ok_or_else(|| PyTypeError::new_err("signal is required"))?
								.extract()?,
							props:  Default::default(),
						}),
					)
				} else {
					ASYNC_RUNTIME.block_on(
						run.resize(env_pb::ResizeRequest {
							exec:    run_id.into(),
							rows:    arguments
								.get_item("rows")?
								.ok_or_else(|| PyTypeError::new_err("rows is required"))?
								.extract()?,
							columns: arguments
								.get_item("columns")?
								.ok_or_else(|| PyTypeError::new_err("columns is required"))?
								.extract()?,
							props:   Default::default(),
						}),
					)
				}
				.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.Run.wait" => {
				let run_id = arguments
					.get_item("run")?
					.ok_or_else(|| PyTypeError::new_err("run is required"))?
					.extract::<Vec<u8>>()?;
				let run = self
					.runs
					.lock()
					.remove(&run_id)
					.ok_or_else(|| environment_exception(py, "Stale", "exec run is closed"))?;
				let (status, output) = ASYNC_RUNTIME
					.block_on(async {
						let mut output = Vec::new();
						let mut run = run.lock();
						loop {
							match run.next_event().await? {
								Some(ExecEvent::Output(frame)) => output.extend_from_slice(&frame.data),
								Some(ExecEvent::Exit(exit)) => {
									let status = exit.status.ok_or(ClientError::UnexpectedResponse {
										expected: "ExecStatusMsg",
									})?;
									return Ok::<_, ClientError>((status, output));
								},
								Some(ExecEvent::Started(_)) => {},
								None => return Err(ClientError::TransportClosed),
							}
						}
					})
					.map_err(|error| client_error(py, error))?;
				let value = exec_status(py, &status)?;
				value
					.bind(py)
					.cast::<PyDict>()?
					.set_item("output", PyBytes::new(py, &output))?;
				Ok(value)
			},
			"omp.env.Run.detach" => {
				let run_id = arguments
					.get_item("run")?
					.ok_or_else(|| PyTypeError::new_err("run is required"))?
					.extract::<Vec<u8>>()?;
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let run = self
					.runs
					.lock()
					.remove(&run_id)
					.ok_or_else(|| environment_exception(py, "Stale", "exec run is closed"))?;
				let run = Arc::try_unwrap(run)
					.map_err(|_| {
						environment_exception(py, "PreconditionFailed", "exec stream is active")
					})?
					.into_inner();
				let started = ASYNC_RUNTIME
					.block_on(self.client.detach_exec(run, run_id.into(), name))
					.map_err(|error| client_error(py, error))?;
				self.remember(&started.name, started.generation, started.endpoint.as_deref());
				process_started(py, &started)
			},
			"omp.env.Process.info" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let value = ASYNC_RUNTIME
					.block_on(self.client.process_info(env_pb::GetProcess {
						name: name.clone(),
						generation,
						wire_revision: omp_env::SCHEMA_REV,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				self.remember(&name, generation, value.endpoint.as_deref());
				process_info(py, &value)
			},
			"omp.env.Process.restart" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let value = ASYNC_RUNTIME
					.block_on(self.client.restart_process(env_pb::RestartProcess {
						name,
						generation,
						wire_revision: omp_env::SCHEMA_REV,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				self.remember(&value.name, value.generation, value.endpoint.as_deref());
				process_started(py, &value)
			},
			"omp.env.Process.send" | "omp.env.Process.eof" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let input = if operation.ends_with("eof") {
					send_input::Input::Eof(true)
				} else {
					let data = arguments
						.get_item("data")?
						.ok_or_else(|| PyTypeError::new_err("data is required"))?
						.extract::<Vec<u8>>()?;
					send_input::Input::Data(data.into())
				};
				ASYNC_RUNTIME
					.block_on(self.client.send_process_input(env_pb::SendInput {
						name,
						input: Some(input),
						generation,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.Process.signal" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let signal = arguments
					.get_item("signal")?
					.ok_or_else(|| PyTypeError::new_err("signal is required"))?
					.extract::<String>()?;
				ASYNC_RUNTIME
					.block_on(self.client.signal_process(env_pb::SignalProcess {
						name,
						signal,
						generation,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.Process.stop" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let grace_ms = arguments.get_item("grace")?.map_or(Ok(5_000), |value| {
					value
						.extract::<PyDuration>()?
						.0
						.to_std()
						.map(|span| span.as_millis().try_into().unwrap_or(u64::MAX))
						.map_err(value_error)
				})?;
				ASYNC_RUNTIME
					.block_on(self.client.stop_process(env_pb::StopProcess {
						name: name.clone(),
						grace_ms,
						generation,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				let value = ASYNC_RUNTIME
					.block_on(self.client.process_info(env_pb::GetProcess {
						name,
						generation,
						wire_revision: omp_env::SCHEMA_REV,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				self.remember(&value.name, value.generation, value.endpoint.as_deref());
				process_info(py, &value)
			},
			"omp.env.proc.start" | "omp.env.proc.ensure" => {
				let (request, cwd) = self.start_process_request(arguments)?;
				if operation.ends_with("ensure") {
					let list = ASYNC_RUNTIME
						.block_on(self.client.list_processes(env_pb::ListProcesses::default()))
						.map_err(|error| client_error(py, error))?;
					if let Some(value) = list.processes.iter().find(|value| {
						value.name == request.name
							&& matches!(
								env_pb::ProcessState::try_from(value.state),
								Ok(env_pb::ProcessState::Starting
									| env_pb::ProcessState::Ready
									| env_pb::ProcessState::Running)
							)
					}) {
						self.remember(&value.name, value.generation, value.endpoint.as_deref());
						return process_started(py, &env_pb::ProcessStarted {
							name: value.name.clone(),
							generation: value.generation,
							endpoint: value.endpoint.clone(),
							..Default::default()
						});
					}
				}
				let value =
					match ASYNC_RUNTIME.block_on(self.client.start_process(&cwd, request.clone())) {
						Ok(value) => value,
						Err(ClientError::Protocol(protocol))
							if operation.ends_with("ensure")
								&& protocol.code == env_pb::ProtocolErrorCode::AlreadyExists as i32 =>
						{
							let list = ASYNC_RUNTIME
								.block_on(self.client.list_processes(env_pb::ListProcesses::default()))
								.map_err(|error| client_error(py, error))?;
							let value = list
								.processes
								.into_iter()
								.find(|value| {
									value.name == request.name
										&& matches!(
											env_pb::ProcessState::try_from(value.state),
											Ok(env_pb::ProcessState::Starting
												| env_pb::ProcessState::Ready
												| env_pb::ProcessState::Running)
										)
								})
								.ok_or_else(|| client_error(py, ClientError::Protocol(protocol)))?;
							env_pb::ProcessStarted {
								name: value.name,
								generation: value.generation,
								endpoint: value.endpoint,
								..Default::default()
							}
						},
						Err(error) => return Err(client_error(py, error)),
					};
				self.remember(&value.name, value.generation, value.endpoint.as_deref());
				process_started(py, &value)
			},
			"omp.env.proc.list" | "omp.env.proc.adopt" => {
				let list = ASYNC_RUNTIME
					.block_on(self.client.list_processes(env_pb::ListProcesses::default()))
					.map_err(|error| client_error(py, error))?;
				if operation.ends_with("adopt") {
					let name = arguments
						.get_item("name")?
						.ok_or_else(|| PyTypeError::new_err("name is required"))?
						.extract::<String>()?;
					let Some(value) = list.processes.iter().find(|value| {
						value.name == name
							&& matches!(
								env_pb::ProcessState::try_from(value.state),
								Ok(env_pb::ProcessState::Starting
									| env_pb::ProcessState::Ready
									| env_pb::ProcessState::Running)
							)
					}) else {
						return Ok(py.None());
					};
					self.remember(&value.name, value.generation, value.endpoint.as_deref());
					return process_started(py, &env_pb::ProcessStarted {
						name: value.name.clone(),
						generation: value.generation,
						endpoint: value.endpoint.clone(),
						..Default::default()
					});
				}
				let result = PyList::empty(py);
				for value in list.processes {
					self.remember(&value.name, value.generation, value.endpoint.as_deref());
					result.append(process_info(py, &value)?)?;
				}
				Ok(result.unbind().into_any())
			},
			"omp.env.http.get" | "omp.env.http.post" | "omp.env.http.put" => {
				let method = arguments
					.get_item("method")?
					.ok_or_else(|| PyTypeError::new_err("method is required"))?
					.extract::<String>()?;
				let url = arguments
					.get_item("url")?
					.ok_or_else(|| PyTypeError::new_err("url is required"))?
					.extract::<String>()?;
				let body = arguments
					.get_item("body")?
					.ok_or_else(|| PyTypeError::new_err("body is required"))?
					.extract::<Vec<u8>>()?;
				let headers = arguments
					.get_item("headers")?
					.ok_or_else(|| PyTypeError::new_err("headers are required"))?
					.extract::<BTreeMap<String, String>>()?
					.into_iter()
					.map(|(name, value)| env_pb::HttpHeader { name, value, props: Default::default() })
					.collect();
				let redirects = arguments
					.get_item("redirects")?
					.ok_or_else(|| PyTypeError::new_err("redirects is required"))?
					.extract::<u32>()?;
				let timeout_ms = arguments.get_item("timeout")?.map_or(Ok(0), |value| {
					value
						.extract::<Option<PyDuration>>()?
						.map_or(Ok(0), |duration| {
							duration
								.0
								.to_std()
								.map(|span| span.as_millis().try_into().unwrap_or(u64::MAX))
								.map_err(value_error)
						})
				})?;
				let value = ASYNC_RUNTIME
					.block_on(self.client.http(env_pb::HttpRequest {
						method,
						url,
						headers,
						body: body.into(),
						timeout_ms,
						redirects,
						props: Default::default(),
					}))
					.map_err(|error| client_error(py, error))?;
				let result = PyDict::new(py);
				result.set_item("status", value.status)?;
				result.set_item(
					"headers",
					value
						.headers
						.into_iter()
						.map(|header| (header.name, header.value))
						.collect::<BTreeMap<_, _>>(),
				)?;
				result.set_item("body", PyBytes::new(py, &value.body))?;
				result.set_item("final_url", value.final_url)?;
				Ok(result.unbind().into_any())
			},
			"omp.env.find.files" | "omp.env.find.grep" => {
				let root = arguments
					.get_item("root")?
					.filter(|value| !value.is_none())
					.map_or_else(
						|| Ok::<_, PyErr>(self.root.clone()),
						|value| Ok(value.extract::<PyEnvPath>()?.0.clone()),
					)?;
				let items = if operation.ends_with("files") {
					let mut stream = ASYNC_RUNTIME
						.block_on(self.client.walk(&root, walk_request(arguments)?))
						.map_err(|error| client_error(py, error))?;
					ASYNC_RUNTIME
						.block_on(async {
							let mut items = Vec::new();
							while let Some(event) = stream.next_event().await? {
								if let WalkEvent::Entry(entry) = event {
									items.push(NativeStreamItem::Walk(WalkEvent::Entry(entry)));
								}
							}
							Ok::<_, ClientError>(items)
						})
						.map_err(|error| client_error(py, error))?
				} else {
					let mut stream = ASYNC_RUNTIME
						.block_on(self.client.search(&root, search_request(arguments)?))
						.map_err(|error| client_error(py, error))?;
					ASYNC_RUNTIME
						.block_on(async {
							let mut items = Vec::new();
							while let Some(event) = stream.next_event().await? {
								if let SearchEvent::Match(value) = event {
									items.push(NativeStreamItem::Search(SearchEvent::Match(value)));
								}
							}
							Ok::<_, ClientError>(items)
						})
						.map_err(|error| client_error(py, error))?
				};
				let result = PyList::empty(py);
				for item in items {
					result.append(native_stream_item(py, item)?)?;
				}
				Ok(result.unbind().into_any())
			},
			"omp.env.blobs.stat" | "omp.env.blobs.get" | "omp.env.blobs.delete" => {
				let reference = arguments
					.get_item("ref")?
					.ok_or_else(|| PyTypeError::new_err("ref is required"))?
					.extract::<PyBlobRef>()?;
				let hash = reference.hash.to_vec().into();
				if operation.ends_with("stat") {
					let value = ASYNC_RUNTIME
						.block_on(self.client.blob_stat(blob_pb::StatRequest { hash }))
						.map_err(|error| client_error(py, error))?;
					let result = PyDict::new(py);
					result.set_item("present", value.present)?;
					result.set_item("size", value.size)?;
					return Ok(result.unbind().into_any());
				}
				if operation.ends_with("delete") {
					let value = ASYNC_RUNTIME
						.block_on(self.client.blob_delete(blob_pb::DeleteRequest { hash }))
						.map_err(|error| client_error(py, error))?;
					return Ok(PyBool::new(py, value.deleted)
						.to_owned()
						.unbind()
						.into_any());
				}
				let offset = arguments
					.get_item("offset")?
					.map(|value| value.extract::<Option<u64>>())
					.transpose()?
					.flatten()
					.unwrap_or(0);
				let length = arguments
					.get_item("length")?
					.map(|value| value.extract::<Option<u64>>())
					.transpose()?
					.flatten()
					.unwrap_or(0);
				let client = self.client.clone();
				let bytes = ASYNC_RUNTIME
					.block_on(async move {
						let mut download = client
							.blob_get(blob_pb::GetRequest { hash, offset, length })
							.await?;
						let mut bytes = Vec::new();
						while let Some(event) = download.next_event().await? {
							match event {
								BlobDownloadEvent::Chunk(chunk) => {
									bytes.extend_from_slice(&chunk.data);
								},
								BlobDownloadEvent::Complete(_) => break,
							}
						}
						Ok::<_, ClientError>(bytes)
					})
					.map_err(|error| client_error(py, error))?;
				Ok(PyBytes::new(py, &bytes).unbind().into_any())
			},
			"omp.env.BlobWriter.write" => {
				let upload = arguments
					.get_item("upload")?
					.ok_or_else(|| PyTypeError::new_err("upload is required"))?
					.extract::<Py<PyBlobUpload>>()?;
				let chunk = arguments
					.get_item("chunk")?
					.ok_or_else(|| PyTypeError::new_err("chunk is required"))?
					.extract::<Vec<u8>>()?;
				let upload = upload.get();
				let guard = upload.upload.lock();
				let upload = guard.as_ref().ok_or_else(|| {
					environment_exception(py, "PreconditionFailed", "blob upload is closed")
				})?;
				ASYNC_RUNTIME
					.block_on(upload.send_chunk(blob_pb::Chunk {
						data: chunk.into(),
						hash: Default::default(),
						size: None,
					}))
					.map_err(|error| client_error(py, error))?;
				Ok(py.None())
			},
			"omp.env.BlobWriter.commit" => {
				let upload = arguments
					.get_item("upload")?
					.ok_or_else(|| PyTypeError::new_err("upload is required"))?
					.extract::<Py<PyBlobUpload>>()?;
				let value = ASYNC_RUNTIME
					.block_on(upload.get().take(py)?.commit())
					.map_err(|error| client_error(py, error))?;
				let hash = <[u8; 32]>::try_from(value.hash.as_ref())
					.map_err(|_| PyRuntimeError::new_err("Environment returned an invalid blob hash"))?;
				Ok(Py::new(py, PyBlobRef { hash, size: value.size })?.into_any())
			},
			"omp.env.blobs.put" => {
				let data = arguments
					.get_item("data")?
					.ok_or_else(|| PyTypeError::new_err("data is required"))?;
				let value = if let Ok(path) = data.extract::<PyEnvPath>() {
					self.upload_path(&path.0)
				} else {
					self.upload(data.extract::<Vec<u8>>()?)
				}
				.map_err(|error| client_error(py, error))?;
				let hash = <[u8; 32]>::try_from(value.hash.as_ref())
					.map_err(|_| PyRuntimeError::new_err("Environment returned an invalid blob hash"))?;
				Ok(Py::new(py, PyBlobRef { hash, size: value.size })?.into_any())
			},
			_ => Err(environment_exception(
				py,
				"Unsupported",
				&format!("native DATA backend does not implement {operation}"),
			)),
		}
	}

	fn stream(
		&self,
		py: Python<'_>,
		operation: &str,
		arguments: &Bound<'_, PyDict>,
	) -> PyResult<Py<PyAny>> {
		let stream = match operation {
			"omp.env.docs.Doc.events" => {
				let lease_id = arguments
					.get_item("lease")?
					.ok_or_else(|| PyTypeError::new_err("lease is required"))?
					.extract::<Vec<u8>>()?;
				let lease = self
					.documents
					.lock()
					.get(&lease_id)
					.cloned()
					.ok_or_else(|| environment_exception(py, "Stale", "document lease is closed"))?;
				NativeStream::Document(lease)
			},
			"omp.env.lsp.events" => {
				let lease = self
					.documents
					.lock()
					.values()
					.next()
					.cloned()
					.ok_or_else(|| {
						environment_exception(
							py,
							"PreconditionFailed",
							"LSP events require an open document lease",
						)
					})?;
				let events = ASYNC_RUNTIME
					.block_on(self.client.lsp_events(&lease.lock()))
					.map_err(|error| client_error(py, error))?;
				NativeStream::Lsp(events)
			},
			"omp.env.Run.events" => {
				let run_id = arguments
					.get_item("run")?
					.ok_or_else(|| PyTypeError::new_err("run is required"))?
					.extract::<Vec<u8>>()?;
				let run = self
					.runs
					.lock()
					.get(&run_id)
					.cloned()
					.ok_or_else(|| environment_exception(py, "Stale", "exec run is closed"))?;
				NativeStream::Exec(run)
			},
			"omp.env.Process.output" | "omp.env.Process.states" => {
				let name = arguments
					.get_item("name")?
					.ok_or_else(|| PyTypeError::new_err("name is required"))?
					.extract::<String>()?;
				let generation = arguments
					.get_item("generation")?
					.ok_or_else(|| PyTypeError::new_err("generation is required"))?
					.extract::<u64>()?;
				let after_sequence = arguments
					.get_item("after")?
					.map(|value| value.extract::<u64>())
					.transpose()?
					.unwrap_or(0);
				let attachment = ASYNC_RUNTIME
					.block_on(self.client.attach_output(env_pb::AttachOutput {
						name,
						after_sequence,
						generation,
						..Default::default()
					}))
					.map_err(|error| client_error(py, error))?;
				NativeStream::Process(attachment, operation.ends_with("states"))
			},
			"omp.env.blobs.stream" => {
				let reference = arguments
					.get_item("ref")?
					.ok_or_else(|| PyTypeError::new_err("ref is required"))?
					.extract::<PyBlobRef>()?;
				let offset = arguments
					.get_item("offset")?
					.map(|value| value.extract::<u64>())
					.transpose()?
					.unwrap_or(0);
				let length = arguments
					.get_item("length")?
					.filter(|value| !value.is_none())
					.map(|value| value.extract::<u64>())
					.transpose()?
					.unwrap_or(0);
				let download = ASYNC_RUNTIME
					.block_on(self.client.blob_get(blob_pb::GetRequest {
						hash: reference.hash.to_vec().into(),
						offset,
						length,
					}))
					.map_err(|error| client_error(py, error))?;
				NativeStream::Blob(download)
			},
			"omp.env.find.walk" => {
				let root = arguments
					.get_item("root")?
					.filter(|value| !value.is_none())
					.map_or_else(
						|| Ok::<_, PyErr>(self.root.clone()),
						|value| Ok(value.extract::<PyEnvPath>()?.0.clone()),
					)?;
				let walk = ASYNC_RUNTIME
					.block_on(self.client.walk(&root, walk_request(arguments)?))
					.map_err(|error| client_error(py, error))?;
				NativeStream::Walk(walk)
			},
			"omp.env.find.search" => {
				let root = arguments
					.get_item("root")?
					.filter(|value| !value.is_none())
					.map_or_else(
						|| Ok::<_, PyErr>(self.root.clone()),
						|value| Ok(value.extract::<PyEnvPath>()?.0.clone()),
					)?;
				let search = ASYNC_RUNTIME
					.block_on(self.client.search(&root, search_request(arguments)?))
					.map_err(|error| client_error(py, error))?;
				NativeStream::Search(search)
			},
			_ => {
				return Err(environment_exception(
					py,
					"Unsupported",
					&format!("native DATA backend does not implement stream {operation}"),
				));
			},
		};
		Ok(Py::new(py, PyEnvironmentStream { stream: Mutex::new(Some(stream)) })?.into_any())
	}
			}
			$($table)*
		}
	};
}
include!("env_backend.rs");

#[pyfunction]
#[cfg(unix)]
fn _open_environment_scope(
	py: Python<'_>,
	socket: &str,
	invocation: &str,
	effect_token: &[u8],
	host_generation: u64,
	session_generation: u64,
	pty_denied: bool,
) -> PyResult<(Py<PyEnvironmentBackend>, Py<PyAny>)> {
	let mut scope = DataScope::new(
		Str::new(invocation),
		effect_token.to_vec().into(),
		host_generation,
		session_generation,
	);
	if pty_denied {
		scope = scope.deny_pty();
	}
	let hello = env_pb::ClientHello {
		client:        String::from("omp-py"),
		schema_rev:    omp_env::SCHEMA_REV,
		capabilities:  vec![
			"env.doc.read",
			"env.doc.write",
			"env.fs.read",
			"env.fs.write",
			"env.exec",
			"env.process",
			"env.blob",
			"env.search",
			"env.lsp",
			"env.net",
			"env.workspace.snapshot",
			"env.worktree",
		]
		.into_iter()
		.map(str::to_owned)
		.collect(),
		client_id:     format!("omp-py:{}:{host_generation}", std::process::id()).into(),
		approval_mode: env_pb::ApprovalMode::Unspecified as i32,
		props:         Default::default(),
	};
	let client = ASYNC_RUNTIME
		.block_on(ExtensionEnvClient::connect_uds(socket, &hello, scope))
		.map_err(|error| client_error(py, error))?;
	let info = client
		.info()
		.ok_or_else(|| PyRuntimeError::new_err("Environment handshake receipt was lost"))?;
	let root = EnvPath::new(Str::new(&info.root_uri)).map_err(value_error)?;
	set_environment_root(info.root_uri.clone());
	let result = PyDict::new(py);
	result.set_item("workspace_id", PyBytes::new(py, &info.workspace_id))?;
	result.set_item("root", info.root_uri)?;
	result.set_item("server_epoch", PyBytes::new(py, &info.server_epoch))?;
	result.set_item("server_version", info.server_version)?;
	result.set_item("server_build", info.server_build)?;
	result.set_item("schema_rev", info.schema_rev)?;
	result.set_item("capabilities", info.capabilities)?;
	result.set_item("remote", false)?;
	Ok((
		Py::new(py, PyEnvironmentBackend {
			client,
			root,
			endpoints: RwLock::new(BTreeMap::new()),
			documents: Mutex::new(BTreeMap::new()),
			runs: Mutex::new(BTreeMap::new()),
		})?,
		result.unbind().into_any(),
	))
}

#[pyfunction]
#[cfg(not(unix))]
fn _open_environment_scope(
	_socket: &str,
	_invocation: &str,
	_effect_token: &[u8],
	_host_generation: u64,
	_session_generation: u64,
	_pty_denied: bool,
) -> PyResult<(Py<PyEnvironmentBackend>, Py<PyAny>)> {
	Err(EnvUnavailable::new_err(
		"the native Environment DATA socket transport is unavailable on this platform",
	))
}

/// Frozen cancellation token shared safely by free-threaded Python callers.
#[pyclass(name = "Cancellation", frozen, module = "_omp")]
#[derive(Debug, Default)]
struct PyCancellation {
	cancelled: atomic::AtomicBool,
}

#[pymethods]
impl PyCancellation {
	#[new]
	fn new() -> Self {
		Self::default()
	}

	fn cancel(&self) {
		self.cancelled.store(true, atomic::Ordering::Release);
	}

	#[getter]
	fn cancelled(&self) -> bool {
		self.cancelled.load(atomic::Ordering::Acquire)
	}
}

/// Return `CPython`'s identifier for the attached current thread.
#[pyfunction]
fn _thread_id() -> u64 {
	interrupt::current_thread_id()
}
/// Builtin-only scribe engine shared by every compiled template.
///
/// Registered helpers are the deterministic builtins, so one shared,
/// immutable registry is safe under free-threaded rendering.
static SCRIBE_ENGINE: LazyLock<ScribeEngine> = LazyLock::new(ScribeEngine::new);

/// Renders a scribe failure once, at the Python boundary, source chain
/// included (helper failures carry their cause as `source`).
fn template_error(error: ScribeError) -> PyErr {
	use std::error::Error as _;
	let mut message = error.to_string();
	let mut source = error.source();
	while let Some(cause) = source {
		message.push_str(": ");
		message.push_str(&cause.to_string());
		source = cause.source();
	}
	TemplateError::new_err(message)
}

/// Converts one Python props value into a scribe value.
///
/// Accepts the JSON shape scribe values serialize to: `None`, `bool`,
/// `int` (64-bit signed), `float`, `str`, `list`/`tuple`, and `dict` with
/// string keys. Anything else raises `TypeError`.
fn scribe_value(value: &Bound<'_, PyAny>) -> PyResult<ScribeValue> {
	if value.is_none() {
		return Ok(ScribeValue::None);
	}
	if value.is_instance_of::<PyBool>() {
		return value.extract::<bool>().map(ScribeValue::Bool);
	}
	if value.is_instance_of::<PyInt>() {
		return value.extract::<i64>().map(ScribeValue::Int);
	}
	if value.is_instance_of::<PyFloat>() {
		return value.extract::<f64>().map(ScribeValue::Float);
	}
	if value.is_instance_of::<PyString>() {
		return Ok(ScribeValue::Str(Str::new(value.extract::<&str>()?)));
	}
	if let Ok(dict) = value.cast::<PyDict>() {
		return dict
			.iter()
			.map(|(key, item)| {
				let key = key
					.extract::<&str>()
					.map_err(|_| PyTypeError::new_err("template props keys must be str"))?;
				Ok((Str::new(key), scribe_value(&item)?))
			})
			.collect::<PyResult<ScribeValue>>();
	}
	if let Ok(list) = value.cast::<PyList>() {
		return list.iter().map(|item| scribe_value(&item)).collect();
	}
	if let Ok(tuple) = value.cast::<PyTuple>() {
		return tuple.iter().map(|item| scribe_value(&item)).collect();
	}
	Err(PyTypeError::new_err(format!(
		"unsupported template props value type: {}",
		value.get_type().name()?
	)))
}

/// Converts a Python props dict into a scribe props bag.
fn scribe_props(props: Option<&Bound<'_, PyDict>>) -> PyResult<ScribeProps> {
	let mut bag = ScribeProps::new();
	if let Some(dict) = props {
		for (key, value) in dict.iter() {
			let key = key
				.extract::<&str>()
				.map_err(|_| PyTypeError::new_err("template props keys must be str"))?;
			bag.set(key, scribe_value(&value)?);
		}
	}
	Ok(bag)
}

/// Compiled, immutable scribe template rendering against the shared
/// builtin engine. Rendering is pure: output depends only on the source
/// and the props.
#[pyclass(name = "Template", frozen, module = "omp.scribe")]
#[derive(Debug)]
struct PyScribeTemplate(omp_scribe::Template);

#[pymethods]
impl PyScribeTemplate {
	#[new]
	#[pyo3(signature = (source, *, name = "template"))]
	fn new(source: &str, name: &str) -> PyResult<Self> {
		SCRIBE_ENGINE
			.compile_owned(Str::new(name), source)
			.map(Self)
			.map_err(template_error)
	}

	/// The name supplied at compile time (used in error messages).
	#[getter]
	fn name(&self) -> &str {
		self.0.name()
	}

	/// Sorted, deduplicated top-level prop names the template reads.
	#[getter]
	fn referenced_keys<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyTuple>> {
		PyTuple::new(py, self.0.referenced_keys())
	}

	/// Renders the template with `props` (a `dict` with string keys).
	#[pyo3(signature = (props = None))]
	fn render<'py>(
		&self,
		py: Python<'py>,
		props: Option<&Bound<'py, PyDict>>,
	) -> PyResult<Bound<'py, PyString>> {
		let bag = scribe_props(props)?;
		let out = self
			.0
			.render_str(&SCRIBE_ENGINE, &bag)
			.map_err(template_error)?;
		Ok(PyString::new(py, out.as_str()))
	}

	fn __repr__(&self) -> String {
		format!("Template(name={:?})", self.0.name())
	}
}

/// Canonicalizes rendered prompt text: strips HTML comments, collapses
/// blank runs, compacts GFM table separators, and aliases RFC 2119
/// phrasing, all outside code fences and inline code spans.
#[pyfunction]
fn _scribe_canonicalize(text: &str) -> String {
	canon::canonicalize_prompt(text)
}

/// Deliver a stage-two `KeyboardInterrupt` to a Python thread id.
#[pyfunction]
fn _interrupt(py: Python<'_>, thread_id: u64) -> bool {
	interrupt::interrupt(py, thread_id)
}

/// Registers the native `_omp` module before `CPython` initialization.
pub fn register() {
	pyo3::append_to_inittab!(_omp);
}

#[pymodule(gil_used = false)]
mod _omp {
	#[pymodule_export]
	use super::{
		_interrupt, _local_path_string, _open_environment_scope, _phase_legality_matrix,
		_principal_from_host, _resource_receipt_from_host, _runtime_metadata, _scheme_snapshot,
		_scribe_canonicalize, _set_resource_receipt, _thread_id, EnvUnavailable, HostDisconnected,
		OmpError, PlacementError, PyActivateReason, PyAgentUrl, PyArtifactUrl, PyAuthority,
		PyBlobRef, PyBlobUpload, PyCancellation, PyClientPath, PyControlHandle, PyCostClass,
		PyDurability, PyDuration, PyEnvPath, PyEnvironmentBackend, PyEnvironmentStream, PyHistoryUrl,
		PyInvocationPhase, PyLifecyclePhase, PyOperationSpec, PyPrincipal, PyQuotaStatus,
		PyResourceReceipt, PyRestartReason, PyScribeTemplate, PySecret, PySecretUse, PySessionSetup,
		PyStateScope, PyWorkspaceUri, StaleGeneration, TemplateError, operation_spec, resources,
	};
	#[pymodule_export]
	use crate::env_types::{
		BlobStat, Completed, CopyResult, DirEntry, DocEvent, Entry, EnvInfo, Exit, HttpResponse,
		LspBinding, LspBindingEvent, LspError, LspEvent, LspReply, Match, OpenedDoc, OpenedSession,
		Output, PathMeta, ProcessInfo, ProcessOutput, Revision, StartedProcess, StartedRun, Summary,
		SummarySegment, SummaryUnavailable, SymlinkTarget, SyncPolicy, TxnOutcome, TxnReceipt,
		WorktreeInfo,
	};
}
