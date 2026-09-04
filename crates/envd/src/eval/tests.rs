use std::{
	ffi::CString,
	fs,
	sync::{
		Arc,
		atomic::{AtomicI64, Ordering},
	},
};

use async_trait::async_trait;
use omp_core::sf;
use omp_tools::eval::idle_timeout::TimeoutHandle;
use parking_lot::Mutex;
use pyo3::{
	prelude::*,
	types::{PyDict, PyModule},
};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::runtime::Runtime;

use super::{super::tools, *};

struct PreludeHost {
	calls:             Mutex<Vec<(String, Value)>>,
	concurrency_limit: AtomicI64,
}

impl Default for PreludeHost {
	fn default() -> Self {
		Self { calls: Mutex::new(Vec::new()), concurrency_limit: AtomicI64::new(2) }
	}
}

impl PreludeHost {
	fn set_concurrency_limit(&self, limit: i64) {
		self.concurrency_limit.store(limit, Ordering::Release);
	}
}

#[async_trait]
impl BridgeHost for PreludeHost {
	async fn call(
		&self,
		name: &str,
		args: Value,
		_progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		self.calls.lock().push((name.to_owned(), args.clone()));
		match name {
			"echo" => Ok(args),
			"read" => match args["path"].as_str().unwrap_or_default() {
				"agent://alpha:raw" => Ok(Value::String(
					r#"{"id":"alpha","status":"completed","output":"one\ntwo\nthree\n"}"#.to_owned(),
				)),
				"agent://data:raw" => Ok(Value::String(
					r#"{"id":"data","status":"completed","output":{"endpoints":[{"file":"src/a.rs"}]}}"#
						.to_owned(),
				)),
				"agent://ansi:raw" => Ok(Value::String(
					r#"{"id":"ansi","status":"completed","output":"\u001b[31mred\u001b[0m"}"#.to_owned(),
				)),
				"artifact://sha256/\
				 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:raw" => {
					Ok(Value::String("durable artifact".to_owned()))
				},
				"artifact://sha256/\
				 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2-2" => {
					Ok(Value::String("artifact line two".to_owned()))
				},
				path => Ok(Value::String(format!("delegated:{path}"))),
			},
			"fail" => Err(BridgeHostError::message("host exploded")),
			"updates" => Ok(json!({
				"__omp_bridge_value__": { "done": true },
				"__omp_bridge_updates__": [{ "step": 1 }, { "step": 2 }]
			})),
			"__completion__" if !args["schema"].is_null() => Ok(json!({ "text": "{\"answer\":42}" })),
			"__completion__" => Ok(json!({ "text": "completed" })),
			"__agent__" if !args["outputSchema"].is_null() => Ok(json!({
				"text": "{\"answer\":42}",
				"data": { "answer": 42 },
				"details": { "id": "child-structured", "agent": "task" }
			})),
			"__agent__" => Ok(json!({
				"text": "child output",
				"details": { "id": "child-1", "agent": "task", "isolated": true }
			})),
			"__workpool__" => match args["op"].as_str() {
				Some("create") => Ok(json!({ "name": "audit", "agent": "task", "limit": 2 })),
				Some("push") => Ok(json!({ "ids": ["audit#1", "audit#2"] })),
				Some("status") => Ok(json!({ "name": "audit", "closed": false })),
				Some("peek") => Ok(json!({ "batches": [], "pending": 2 })),
				Some("close") => Ok(json!({ "dropped": ["audit#2"] })),
				_ => Err(BridgeHostError::message("unexpected workpool operation")),
			},
			"__concurrency__" => {
				Ok(json!({ "limit": self.concurrency_limit.load(Ordering::Acquire) }))
			},
			"__budget__" => Ok(json!({ "total": 100, "spent": 35, "hard": true })),
			"__prelude__:merge_patches" => Ok(args),
			_ => Err(BridgeHostError::message(format!("unexpected bridge call: {name}"))),
		}
	}
}

fn python() -> Arc<omp_py::Engine> {
	tools::python_engine().expect("initialize embedded Python")
}

fn run(py: Python<'_>, globals: &Bound<'_, PyDict>, source: String) -> PyResult<()> {
	let source = CString::new(source).expect("test source has no NUL");
	py.run(source.as_c_str(), Some(globals), Some(globals))
}

#[test]
fn complete_prelude_persists_and_bridges_host_helpers() {
	let root = tempdir().expect("temp root");
	let local = root.path().join("local");
	fs::create_dir_all(&local).expect("local directory");

	let runtime = Runtime::new().expect("test runtime");
	let dispatcher = BridgeDispatcher::new();
	let host = Arc::new(PreludeHost::default());
	let registration = dispatcher
		.register(
			sf!("session"),
			sf!("run"),
			BridgeCapabilities::new([sf!("echo"), sf!("read"), sf!("updates"), sf!("fail")])
				.with_completion()
				.with_agent()
				.with_workpool()
				.with_concurrency()
				.with_budget(),
			host.clone(),
			TimeoutHandle::new(None),
		)
		.expect("bridge registration");

	python().attach(|py| -> PyResult<()> {
		let globals = PyDict::new(py);
		globals.set_item("__builtins__", PyModule::import(py, "builtins")?)?;
		run(py, &globals, r#"__omp_events = []
__omp_timeout_events = []
def __omp_display(value, raw=False):
    __omp_events.append((value, raw))
def __omp_timeout_pause__():
    __omp_timeout_events.append("pause")
def __omp_timeout_resume__():
    __omp_timeout_events.append("resume")
"#.to_owned())?;
		install_python_bridge(py, &globals, registration.client(), runtime.handle().clone())?;
		install_python_prelude(py, &globals)?;
		let setup = format!(
			"OMP_EVAL_LOCAL_ROOTS = json.dumps({{'local': {local}}})\n",
			local = serde_json::to_string(&local.to_string_lossy()).unwrap(),
		);
		run(py, &globals, setup)?;
		run(py, &globals, r#"
import contextlib, io
assert "__workpool__" in __omp_bridge_capabilities__

# display + ordinary print output
display({"answer": 42})
assert __omp_events[-1] == (({"application/json": {"answer": 42}, "text/plain": "{'answer': 42}"}), True)
_printed = io.StringIO()
with contextlib.redirect_stdout(_printed):
    print("hello", "eval")
assert _printed.getvalue() == "hello eval\n"

# local filesystem helpers and environment persistence
assert env("OMP_PRELUDE_TEST", "present") == "present"
assert env("OMP_PRELUDE_TEST") == "present"
assert env()["OMP_PRELUDE_TEST"] == "present"
assert str(write("local://nested/value.txt", "first\nsecond\nthird\n")).endswith("nested/value.txt")
assert read("local://nested/value.txt", offset=2, limit=1) == "second\n"
assert read("skill://demo", offset=3, limit=2) == "delegated:skill://demo:3-4"

# output lookup: raw/json/stripped/query/ranges/multiple
assert output("alpha") == "one\ntwo\nthree\n"
_alpha = output("alpha", format="json", offset=2, limit=1)
assert _alpha["content"] == "two" and _alpha["range"] == {"start_line": 2, "end_line": 2, "total_lines": 3}
assert output("ansi", format="stripped") == "red"
assert output("data", query=".endpoints[0].file") == '"src/a.rs"'
assert output("alpha", "data")[0] == {"id": "alpha", "content": "one\ntwo\nthree\n"}
assert output("artifact://sha256/" + "a" * 64) == "durable artifact"
assert output("artifact://sha256/" + "a" * 64, offset=2, limit=1) == "artifact line two"
try:
    output("alpha", query=".x", offset=1)
except ValueError as error:
    assert str(error) == "query cannot be combined with offset/limit"
else:
    raise AssertionError("invalid output arguments were accepted")


# authenticated host helpers
assert tool.echo({"value": 7}) == {"value": 7, "i": "py prelude"}
assert tool["echo"](value=8) == {"value": 8, "i": "py prelude"}
assert repr(tool) == "<tool proxy session=session>"
assert tool.updates({}) == {"done": True}
_tool_statuses = [
    value["application/x-omp-status"]
    for value, raw in __omp_events
    if raw and isinstance(value, dict)
    and value.get("application/x-omp-status", {}).get("op") == "tool"
]
assert _tool_statuses[-2:] == [
    {"op": "tool", "name": "updates", "update": {"step": 1}},
    {"op": "tool", "name": "updates", "update": {"step": 2}},
]
assert completion("prompt", model="smol") == "completed"
assert completion("prompt", schema={"type": "object"}) == {"answer": 42}
_child = agent("do work", name="Worker", effort="high", handle=True, isolated=True)
assert _child == {
    "text": "child output", "output": "child output", "handle": "agent://child-1",
    "id": "child-1", "agent": "task", "isolated": True,
}
assert agent("structured", outputSchema={"type": "object"}) == {"answer": 42}

@tool(rev=3)
def remember(key: str, value: int = 1):
    """Retain a structured key/value pair."""
    return {"key": key, "value": value}

assert tool.defined() == ["remember"]
_roster = __omp_eval_tool_request__({"op": "describe", "names": ["remember"]})
assert _roster["ok"] is True and _roster["missing"] == []
_registration = _roster["tools"][0]
assert _registration["rev"] == 3
assert _registration["parameters"]["required"] == ["key"]
assert __omp_eval_tool_request__({
    "op": "call",
    "name": "remember",
    "rev": _registration["rev"],
    "handler": _registration["handler"],
    "generation": _registration["generation"],
    "args": {"key": "alpha", "value": 7},
}) == {"ok": True, "value": {"key": "alpha", "value": 7}}
_pool = workpool("task", name="audit", context="shared", tools=["remember"])
assert repr(_pool) == "<workpool audit (task) 2 agents>"

@tool(name="remember", rev=4)
def remember_replacement(key: str):
    return {"replacement": key}

_stale = __omp_eval_tool_request__({
    "op": "call",
    "name": "remember",
    "rev": _registration["rev"],
    "handler": _registration["handler"],
    "generation": _registration["generation"],
    "args": {"key": "alpha"},
})
assert _stale["ok"] is False and "stale" in _stale["error"]
assert _pool.push("left", "right") == ["audit#1", "audit#2"]
assert _pool.status() == {"name": "audit", "closed": False}
assert _pool.peek() == {"batches": [], "pending": 2}
assert _pool.close() == {"dropped": ["audit#2"]}
assert parallel([lambda: 1, lambda: 2]) == [1, 2]
assert pipeline([1, 2], lambda n: n + 1, lambda n: n * 2) == [4, 6]
log("working")
phase("checking")
assert __omp_current_phase__ == "checking"
assert budget.total == 100 and budget.hard is True
assert budget.spent() == 35 and budget.remaining() == 65
assert repr(budget) == "<budget total=100 spent=35>"
assert __omp_timeout_events.count("pause") == __omp_timeout_events.count("resume")
assert __omp_timeout_events.count("pause") > 0

# Namespace and one-time prelude guard persist across cells.
persisted_value = 73
"#.to_owned())?;
		run(py, &globals, r"
import concurrent.futures as _omp_test_futures

def _observed_parallel_width(item_count):
    original = _omp_test_futures.ThreadPoolExecutor
    observed = []
    class RecordingPool(original):
        def __init__(self, max_workers=None, *args, **kwargs):
            observed.append(max_workers)
            super().__init__(max_workers=max_workers, *args, **kwargs)
    _omp_test_futures.ThreadPoolExecutor = RecordingPool
    try:
        values = parallel([lambda i=i: i for i in range(item_count)])
        assert values == list(range(item_count))
    finally:
        _omp_test_futures.ThreadPoolExecutor = original
    return observed
".to_owned())?;
		host.set_concurrency_limit(0);
		run(
			py,
			&globals,
			"assert _observed_parallel_width(1000) == [1000]\n".to_owned(),
		)?;
		host.set_concurrency_limit(10_000);
		run(
			py,
			&globals,
			"assert _observed_parallel_width(1000) == [1000]\n".to_owned(),
		)?;
		host.set_concurrency_limit(3);
		run(py, &globals, "assert _observed_parallel_width(1000) == [3]\n".to_owned())?;
		install_python_prelude(py, &globals)?;
		run(py, &globals, "assert persisted_value == 73\nassert tool.echo({'again': True})['again'] is True\n".to_owned())?;
		Ok(())
	}).expect("exercise complete Python helper prelude");

	let calls = host.calls.lock();
	assert!(
		calls
			.iter()
			.any(|(name, args)| name == "echo" && args["i"] == "py prelude")
	);
	assert!(calls.iter().any(|(name, args)| {
		name == "__agent__" && args["name"] == "Worker" && args["effort"] == "high"
	}));
	assert!(calls.iter().any(|(name, _)| name == "__completion__"));
	assert!(calls.iter().any(|(name, args)| {
		name == "__workpool__"
			&& args["op"] == "create"
			&& args["tools"] == json!(["remember"])
			&& args["tool_registrations"][0]["name"] == "remember"
			&& args["tool_registrations"][0]["rev"] == 3
			&& args["tool_registrations"][0]["handler"]
				.as_str()
				.is_some_and(|handler| handler.len() == 32)
	}));
	drop(calls);
}

#[test]
fn workpool_helper_is_absent_without_an_authenticated_parent_capability() {
	let runtime = Runtime::new().expect("test runtime");
	let dispatcher = BridgeDispatcher::new();
	let registration = dispatcher
		.register(
			sf!("session-without-parent"),
			sf!("run-without-parent"),
			BridgeCapabilities::new([]),
			Arc::new(PreludeHost::default()),
			TimeoutHandle::new(None),
		)
		.expect("bridge registration");

	python()
		.attach(|py| -> PyResult<()> {
			let globals = PyDict::new(py);
			globals.set_item("__builtins__", PyModule::import(py, "builtins")?)?;
			globals.set_item("__omp_display", py.None())?;
			install_python_bridge(py, &globals, registration.client(), runtime.handle().clone())?;
			install_python_prelude(py, &globals)?;
			assert!(!globals.contains("workpool")?);
			assert!(!globals.contains("WorkPool")?);
			Ok(())
		})
		.expect("prelude without workpool capability");
}

#[test]
fn extension_prelude_helpers_bind_signatures_before_host_dispatch() {
	let runtime = Runtime::new().expect("test runtime");
	let dispatcher = BridgeDispatcher::new();
	let host = Arc::new(PreludeHost::default());
	let registration = dispatcher
		.register(
			sf!("session-prelude"),
			sf!("run-prelude"),
			BridgeCapabilities::new([]).with_prelude([sf!("merge_patches")]),
			host.clone(),
			TimeoutHandle::new(None),
		)
		.expect("bridge registration");

	python()
		.attach(|py| -> PyResult<()> {
			let globals = PyDict::new(py);
			globals.set_item("__builtins__", PyModule::import(py, "builtins")?)?;
			run(
				py,
				&globals,
				r#"def __omp_display(value, raw=False):
    pass
def __omp_timeout_pause__():
    pass
def __omp_timeout_resume__():
    pass
"#
				.to_owned(),
			)?;
			install_python_bridge(py, &globals, registration.client(), runtime.handle().clone())?;
			install_python_prelude(py, &globals)?;
			run(
				py,
				&globals,
				r#"
import inspect, pydoc

__omp_install_prelude_helpers__([
    {
        "name": "merge_patches",
        "doc": "Merge patches using the requested strategy.",
        "params": [
            {
                "name": "patches",
                "keyword_only": False,
                "default_json": None,
                "annotation": None,
            },
            {
                "name": "strategy",
                "keyword_only": True,
                "default_json": '"sequential"',
                "annotation": None,
            },
        ],
    },
    {"name": "denied_helper", "doc": "", "params": []},
])

assert str(inspect.signature(merge_patches)) == "(patches, *, strategy='sequential')"
assert merge_patches.__doc__ == "Merge patches using the requested strategy."
_help = pydoc.render_doc(merge_patches, renderer=pydoc.plaintext)
assert "merge_patches(patches, *, strategy='sequential')" in _help
assert "Merge patches using the requested strategy." in _help
assert merge_patches(["a"]) == {
    "patches": ["a"],
    "strategy": "sequential",
}

try:
    merge_patches()
except TypeError:
    pass
else:
    raise AssertionError("missing required helper argument reached the host")

try:
    denied_helper()
except RuntimeError as error:
    assert str(error) == "bridge capability denied: __prelude__:denied_helper"
else:
    raise AssertionError("ungranted helper reached the host")

try:
    __omp_install_prelude_helpers__([
        {"name": "json", "doc": "", "params": []},
    ])
except RuntimeError as error:
    assert str(error) == "prelude helper shadows an existing global: json"
else:
    raise AssertionError("prelude global drift was accepted")
try:
    __omp_install_prelude_helpers__([
        {"name": "class", "doc": "", "params": []},
    ])
except RuntimeError as error:
    assert str(error) == "invalid prelude helper name: 'class'"
else:
    raise AssertionError("Python keyword helper was accepted")
try:
    __omp_install_prelude_helpers__([
        {
            "name": "invalid_parameter",
            "doc": "",
            "params": [{"name": "é", "keyword_only": False, "default_json": None}],
        },
    ])
except RuntimeError as error:
    assert str(error) == "invalid prelude helper parameter name: 'é'"
else:
    raise AssertionError("non-ASCII helper parameter was accepted")
"#
				.to_owned(),
			)
		})
		.expect("extension prelude helpers install and dispatch");

	assert_eq!(host.calls.lock().as_slice(), &[(
		"__prelude__:merge_patches".to_owned(),
		json!({ "patches": ["a"], "strategy": "sequential" }),
	)]);
}

#[test]
fn python_bridge_propagates_host_errors_and_capability_denial() {
	let runtime = Runtime::new().expect("test runtime");
	let dispatcher = BridgeDispatcher::new();
	let registration = dispatcher
		.register(
			sf!("session-errors"),
			sf!("run-errors"),
			BridgeCapabilities::new([sf!("fail")]),
			Arc::new(PreludeHost::default()),
			TimeoutHandle::new(None),
		)
		.expect("bridge registration");

	python()
		.attach(|py| -> PyResult<()> {
			let globals = PyDict::new(py);
			globals.set_item("__builtins__", PyModule::import(py, "builtins")?)?;
			run(
				py,
				&globals,
				r#"__omp_timeout_events = []
def __omp_display(value, raw=False):
    pass
def __omp_timeout_pause__():
    __omp_timeout_events.append("pause")
def __omp_timeout_resume__():
    __omp_timeout_events.append("resume")
"#
				.to_owned(),
			)?;
			install_python_bridge(py, &globals, registration.client(), runtime.handle().clone())?;
			install_python_prelude(py, &globals)?;
			run(
				py,
				&globals,
				r#"
try:
    tool.fail({})
except RuntimeError as error:
    assert str(error) == "host exploded"
else:
    raise AssertionError("host failure did not propagate")

try:
    tool.read({"path": "secret"})
except RuntimeError as error:
    assert str(error) == "bridge capability denied: read"
else:
    raise AssertionError("capability denial did not propagate")
assert __omp_timeout_events == ["pause", "resume", "pause", "resume"]
"#
				.to_owned(),
			)
		})
		.expect("bridge errors surface in Python");
}
