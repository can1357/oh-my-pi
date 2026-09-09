//! Verifies Python environment streams and blob writers preserve close and
//! abort semantics.

use omp_py::{Engine, pyo3::ffi::c_str};

#[test]
fn async_data_handles_preserve_streaming_and_close_semantics() {
	let engine = Engine::builder().init().expect("boot embedded Python");
	engine
		.attach(|py| {
			py.run(
				c_str!(
					r#"
import asyncio
import omp
import omp.env

class Stream:
    def __init__(self, values):
        self.values = iter(values)
        self.closed = False
    def __iter__(self):
        return self
    def __next__(self):
        return next(self.values)
    def close(self):
        self.closed = True

class Upload:
    pass

class Backend:
    def __init__(self):
        self.calls = []
        self.streams = []
        self.upload = Upload()
        self.chunks = []
        self.aborted = False

    def blobs_stream(self, ref, offset=0, length=None):
        self.calls.append(("blobs_stream", ref, offset, length))
        stream = Stream([b"a", b"b"])
        self.streams.append(stream)
        return stream

    def doc_events(self, lease):
        self.calls.append(("doc_events", lease))
        stream = Stream([omp.env.DocEvent(
            4, omp.env.DocEventKind.COMMITTED,
            omp.env.Revision(2, b"new"), omp.env.Revision(1, b"old"),
            b"txn", (), None,
        )])
        self.streams.append(stream)
        return stream

    def blob_writer(self):
        return self.upload

    def abort_blob(self, upload):
        assert upload is self.upload
        self.aborted = True

    async def blob_write(self, upload, chunk):
        self.calls.append(("blob_write", upload, chunk))
        assert upload is self.upload
        self.chunks.append(chunk)

    async def blob_commit(self, upload):
        self.calls.append(("blob_commit", upload))
        assert upload is self.upload
        return omp.BlobRef(bytes.fromhex("00" * 32), sum(map(len, self.chunks)))

backend = Backend()
receipt = omp.env.EnvInfo(
    workspace_id=b"workspace", root=omp.EnvPath("file:///workspace"),
    server_epoch=b"epoch", server_version="test", server_build="build",
    schema_rev=1,
    capabilities=frozenset({omp.env.Capability.BLOB, omp.env.Capability.DOC_READ}),
    remote=False,
)
tokens = omp.env._install_backend(backend, receipt)
completed = omp.env._as_completed({
    "outcome": "timeout",
    "exit_code": None,
    "signal": "SIGKILL",
    "wall": omp.Duration("25ms"),
    "output": b"partial",
    "artifact": None,
    "aborted": True,
})
assert completed.outcome is omp.env.Outcome.TIMEOUT
assert completed.exit_code is None and completed.signal == "SIGKILL"
assert completed.aborted and completed.wall == omp.Duration("25ms")

async def chunks():
    yield b"one"
    yield b"two"

async def exercise():
    reference = omp.BlobRef(bytes.fromhex("11" * 32), 2)
    stream = omp.env.blobs.stream(reference)
    assert await anext(stream) == b"a"
    await stream.aclose()
    assert backend.streams[-1].closed

    stored = await omp.env.blobs.put(chunks())
    assert stored.size == 6 and backend.chunks == [b"one", b"two"]

    doc = omp.env.Doc(b"lease", omp.EnvPath("file:///workspace/a.py"))
    event = await anext(doc.events())
    assert event.kind is omp.env.DocEventKind.COMMITTED
    assert event.revision.sequence == 2 and event.previous_revision.sequence == 1

asyncio.run(exercise())
omp.env._reset_backend(tokens)
"#
				),
				None,
				None,
			)
		})
		.expect("exercise async DATA handles");
}
