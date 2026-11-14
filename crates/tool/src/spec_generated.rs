//! Canonical generated projections of the runtime symbol specification.
//!
//! The symbol rows below are the single Rust source of truth. The phase matrix
//! and machine-readable CI artifact are projections of these typed rows;
//! neither is maintained separately.

use omp_core::{Duration, InvocationPhase};
use serde::Serialize;
use strum::{Display, EnumString, IntoStaticStr};

use crate::{Authority, CostClass, DEFAULT_INTERRUPT_GRACE, Durability, OperationSpec};

/// Callback calling convention attached to a public runtime symbol.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallbackAbi {
	/// The symbol is called directly and is not a registered callback.
	#[strum(serialize = "none")]
	None,
	/// The runtime invokes the callback with the payload first and context
	/// second.
	#[strum(serialize = "(payload, ctx)")]
	PayloadContext,
}

/// One canonical public runtime symbol and its enforcement metadata.
#[derive(Clone, Copy, Debug)]
pub struct RuntimeSymbolSpec {
	/// Documentation file that owns the public symbol definition.
	pub owner:        &'static str,
	/// Publisher-visible, fully qualified symbol name.
	pub public_name:  &'static str,
	/// Canonical public signature.
	pub signature:    &'static str,
	/// Internal dispatch keys for transport vocabulary that differs from the
	/// public API name. A handle method can answer to several: the public
	/// symbol `omp.telemetry.span` is driven by the wire verbs
	/// `omp.telemetry.span.open` and `omp.telemetry.span.close`, so one row
	/// carries both. Empty when the public name is the only lookup key.
	pub dispatch_key: &'static [&'static str],
	/// Runtime callback argument ordering, when this is a callback surface.
	pub callback_abi: CallbackAbi,
	/// Phase, durability, cost, and enforcing authority.
	pub operation:    OperationSpec,
	/// Optional fixed runtime timeout with an integer magnitude and explicit
	/// unit.
	pub timeout:      Option<Duration>,
	/// Runnable or type-checkable examples exercising the public symbol.
	pub examples:     &'static [&'static str],
}

/// Persisted, default, and telemetry names associated with a runtime duration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeDurationMetadata {
	/// Public context query that returns the configured live value.
	pub public_name:       &'static str,
	/// Default used when persisted settings omit the key.
	pub default_value:     Duration,
	/// Dot-qualified persisted settings key.
	pub configuration_key: &'static str,
	/// Exact nanosecond telemetry attribute.
	pub telemetry_ns:      &'static str,
	/// Original-unit telemetry attribute.
	pub telemetry_unit:    &'static str,
}

/// A generated row in the phase legality matrix.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct PhaseLegalityRow {
	/// Fully qualified public symbol name.
	pub public_name: &'static str,
	/// Legality in [`InvocationPhase::ALL`] order.
	pub legal:       [bool; InvocationPhase::ALL.len()],
}

const OPEN_LOCAL: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::Open,
	durability:    Durability::Ephemeral,
	cost:          CostClass::None,
	authority:     Authority::Core,
};
const OPEN_METERED: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::Open,
	durability:    Durability::Ephemeral,
	cost:          CostClass::Metered,
	authority:     Authority::Core,
};
const CORE_EFFECT: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::EffectsAuthorized,
	durability:    Durability::Ephemeral,
	cost:          CostClass::Metered,
	authority:     Authority::Core,
};
const CORE_DURABLE: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::EffectsAuthorized,
	durability:    Durability::Durable,
	cost:          CostClass::Metered,
	authority:     Authority::Core,
};
/// Durable, yet legal from `Open`. `docs/py/08-context.md` is the contract for
/// its namespace and states that nothing there authorizes a DATA effect, so no
/// symbol in it ever waits on `EFFECTS_AUTHORIZED` — even the durable ones.
/// Identical to `CORE_DURABLE` apart from that phase.
const OPEN_DURABLE: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::Open,
	durability:    Durability::Durable,
	cost:          CostClass::Metered,
	authority:     Authority::Core,
};
/// Spends a paid upstream resource. `docs/py/13-inference.md` states the rule
/// this encodes: inference-triggering operations are durable Requests with
/// `minimum_phase=EFFECTS_AUTHORIZED`, so a device body can trigger paid
/// inference only once its own invocation holds an effect token and a
/// speculative fragment can never spend money.
const CORE_PAID: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::EffectsAuthorized,
	durability:    Durability::Durable,
	cost:          CostClass::Paid,
	authority:     Authority::Core,
};
const ENV_EPHEMERAL: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::EffectsAuthorized,
	durability:    Durability::Ephemeral,
	cost:          CostClass::Metered,
	authority:     Authority::Environment,
};
const ENV_WRITE: OperationSpec = OperationSpec {
	minimum_phase: InvocationPhase::EffectsAuthorized,
	durability:    Durability::Durable,
	cost:          CostClass::Metered,
	authority:     Authority::Environment,
};

macro_rules! symbol {
	(
		$owner:literal,
		$name:literal,
		$signature:literal,
		$abi:expr,
		$operation:expr,
		$example:literal
	) => {
		symbol!($owner, $name, $signature, $abi, $operation, $example, &[])
	};
	(
		$owner:literal,
		$name:literal,
		$signature:literal,
		$abi:expr,
		$operation:expr,
		$example:literal,
		$dispatch_key:expr
	) => {
		RuntimeSymbolSpec {
			owner:        $owner,
			public_name:  $name,
			signature:    $signature,
			dispatch_key: $dispatch_key,
			callback_abi: $abi,
			operation:    $operation,
			timeout:      None,
			examples:     &[$example],
		}
	};
}

/// Canonical runtime symbol rows.
///
/// New runtime operations are added here once. Consumers must use
/// [`runtime_symbols`], [`operation_spec`], or [`phase_legality_matrix`] rather
/// than maintaining a second table.
pub static RUNTIME_SYMBOLS: &[RuntimeSymbolSpec] = &[
	symbol!(
		"docs/py/00-overview.md",
		"omp.operation_spec",
		"(symbol: str) -> OperationSpec",
		CallbackAbi::None,
		OPEN_LOCAL,
		"omp.operation_spec(\"omp.sessions.create\")"
	),
	symbol!(
		"docs/py/00-overview.md",
		"omp.resources",
		"() -> ResourceReceipt",
		CallbackAbi::None,
		OPEN_LOCAL,
		"omp.resources()"
	),
	symbol!(
		"docs/py/00-overview.md",
		"omp.services.connect",
		"(name: str, *, rev: int) -> ServiceClient",
		CallbackAbi::None,
		CORE_EFFECT,
		"omp.services.connect(\"dev.example.index\", rev=1)"
	),
	symbol!(
		"docs/py/00-overview.md",
		"omp.extension_activate",
		"(payload, ctx) -> None",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"async def extension_activate(event, ctx): pass"
	),
	RuntimeSymbolSpec {
		owner:        "docs/py/03-params.md",
		public_name:  "omp.params.interrupt_grace",
		signature:    "Duration",
		dispatch_key: &[],
		callback_abi: CallbackAbi::None,
		operation:    OPEN_LOCAL,
		timeout:      None,
		examples:     &["grace = omp.params.interrupt_grace"],
	},
	symbol!(
		"docs/py/09-journal.md",
		"omp.journal.decode",
		"(raw) -> Any",
		CallbackAbi::None,
		OPEN_LOCAL,
		"omp.journal.decode(entry.raw)"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.sessions.current",
		"() -> SessionInfo",
		CallbackAbi::None,
		OPEN_LOCAL,
		"omp.sessions.current()"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.sessions.SessionSetup",
		"(title=None, parent=None, entries=(), initial_prompt=None)",
		CallbackAbi::None,
		OPEN_LOCAL,
		"omp.SessionSetup(title=\"Handoff\", initial_prompt=\"Continue here\")"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.sessions.create",
		"(setup=SessionSetup()) -> SessionInfo",
		CallbackAbi::None,
		CORE_DURABLE,
		"await omp.sessions.create(omp.SessionSetup(title=\"Handoff\"))"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.sessions.list",
		"(filter=None, *, cursor=None, limit=50) -> SessionPage",
		CallbackAbi::None,
		OPEN_METERED,
		"omp.sessions.list(limit=10)"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.sessions.usage",
		"(query) -> UsageReport",
		CallbackAbi::None,
		OPEN_METERED,
		"omp.sessions.usage(omp.UsageQuery())"
	),
	symbol!(
		"docs/py/09-journal.md",
		"omp.schemes.live",
		"() -> tuple[LiveDeclaration, ...]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.schemes.live()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.info",
		"() -> EnvInfo",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"omp.env.info()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.has",
		"(*caps: Capability) -> bool",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"omp.env.has(omp.Capability.ENV_DOC_READ)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.require",
		"(*caps: Capability) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"omp.env.require(omp.Capability.ENV_DOC_READ)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.docs.open",
		"(path, *, language=None, create=False) -> Doc",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.docs.open(omp.EnvPath(\"src/lib.rs\"))"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Doc.close",
		"() -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await doc.close()",
		&["omp.env.docs.close"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Doc.read",
		"(*, lines=None, byte_ranges=None) -> str",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await doc.read(lines=[(1, 40)])",
		&["omp.env.docs.read"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Doc.summary",
		"(options=None) -> Summary | SummaryUnavailable",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await doc.summary()",
		&["omp.env.docs.summarize"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Txn.commit",
		"() -> TransactionOutcome",
		CallbackAbi::None,
		ENV_WRITE,
		"await transaction.commit()",
		&["omp.env.docs.commit_transaction"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.canonicalize",
		"(path) -> EnvPath",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.fs.canonicalize(path)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.stat",
		"(path, *, follow=False) -> PathMeta",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.fs.stat(path)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.list_dir",
		"(path, *, follow=False) -> list[DirEntry]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.fs.list_dir(path)",
		&["omp.env.fs.list_directory"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.mkdir",
		"(path, *, parents=False, exist_ok=False) -> PathMeta",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.mkdir(path, parents=True)",
		&["omp.env.fs.create_directory"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.remove",
		"(path, *, recursive=False, missing_ok=False) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.remove(path)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.rename",
		"(source, destination, *, overwrite=Overwrite.FAIL) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.rename(source, destination)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.copy",
		"(source, destination, *, overwrite=Overwrite.FAIL) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.copy(source, destination)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.read_link",
		"(path) -> SymlinkTarget",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.fs.read_link(path)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.symlink",
		"(target, link) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.symlink(target, link)",
		&["omp.env.fs.create_symlink"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.hard_link",
		"(target, link) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.hard_link(target, link)",
		&["omp.env.fs.create_hard_link"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.chmod",
		"(path, permissions) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.fs.chmod(path, permissions)",
		&["omp.env.fs.set_permissions"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.lsp.bindings",
		"(path) -> list[LspBinding]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.lsp.bindings(path)",
		&["omp.env.lsp.get_bindings"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.lsp.status",
		"(reload=False) -> list[LspServerStatus]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.lsp.status()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.lsp.request",
		"(server, method, params, *, doc=None, on_stale=None, timeout=None) -> Any",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.lsp.request(server, \"textDocument/hover\", params)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.lsp.notify",
		"(server, method, params) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.lsp.notify(server, \"initialized\", {})",
		&["omp.env.lsp.notification"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.dap.launch",
		"(request: DapLaunchRequest) -> DapStream",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.dap_launch(request)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.dap.attach",
		"(request: DapAttachRequest) -> DapStream",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.dap_attach(request)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.dap.action",
		"(request: DapActionRequest) -> DapStream",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.dap_action(request)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.find.walk",
		"(**kwargs) -> AsyncIterator[Entry]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"async for entry in omp.env.find.walk(): pass"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.find.grep",
		"(pattern, *, regex=True, case=True, glob=None, root=None, hidden=False, gitignore=True, \
		 limit=None, context=0) -> list[Match]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.find.grep(\"OperationSpec\")",
		&["omp.env.find.search"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.sh.session",
		"(*, cwd=None, env=None, pty=None, ttl=None) -> Session",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.sh.session()",
		&["omp.env.sh.open_session"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Session.close",
		"() -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await session.close()",
		&["omp.env.sh.close_session"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Session.run",
		"(script, *, timeout=None) -> Run",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await session.run(\"git status --short\")",
		&["omp.env.sh.exec"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Run.stdin",
		"(data) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await run.stdin(data)",
		&["omp.env.sh.stdin"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Run.signal",
		"(signal) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await run.signal(\"TERM\")",
		&["omp.env.sh.signal"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Run.resize",
		"(rows: int, columns: int) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await run.resize(40, 120)",
		&["omp.env.sh.resize"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Run.detach",
		"(name) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await run.detach(\"build\")",
		&["omp.env.sh.detach"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.http_get",
		"(url, *, timeout=None, headers=...) -> HttpResponse",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.http_get(\"https://example.test\")",
		&["omp.env.http.get"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.http_post",
		"(url, *, body=b\"\", headers=..., timeout=None) -> HttpResponse",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.http_post(\"https://example.test\", body=b\"{}\")",
		&["omp.env.http.post"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.http_put",
		"(url, *, body=b\"\", headers=..., timeout=None) -> HttpResponse",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.http_put(\"https://example.test\", body=b\"{}\")",
		&["omp.env.http.put"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.proc.start",
		"(name, script, *, cwd=None, env=None, pty=None, restart=None, ready=None) -> Process",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.proc.start(\"web\", \"cargo run\")"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.proc.list",
		"() -> list[ProcessInfo]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.proc.list()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.proc.adopt",
		"(name) -> Process | None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.proc.adopt(\"web\")",
		&["omp.env.proc.attach"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Process.send",
		"(data) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await process.send(data)",
		&["omp.env.proc.send_input"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Process.signal",
		"(signal) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await process.signal(\"TERM\")",
		&["omp.env.proc.signal"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Process.stop",
		"() -> ProcessInfo",
		CallbackAbi::None,
		ENV_WRITE,
		"await process.stop()",
		&["omp.env.proc.stop"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Process.restart",
		"() -> Process",
		CallbackAbi::None,
		ENV_WRITE,
		"await process.restart()",
		&["omp.env.proc.restart"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.blobs.stat",
		"(ref) -> BlobStat",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.blobs.stat(blob)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.blobs.get",
		"(ref, *, offset=0, length=None) -> bytes",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.blobs.get(blob)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.blobs.put",
		"(chunk) -> BlobWriter",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"writer = omp.env.blobs.writer()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.BlobWriter.commit",
		"() -> BlobRef",
		CallbackAbi::None,
		ENV_WRITE,
		"await writer.commit()",
		&["omp.env.blobs.commit_put"]
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.blobs.delete",
		"(ref) -> bool",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.blobs.delete(blob)"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.abort",
		"() -> None",
		CallbackAbi::None,
		CORE_DURABLE,
		"await omp.agents.abort()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.shutdown",
		"(reason='') -> None",
		CallbackAbi::None,
		CORE_DURABLE,
		"await omp.agents.shutdown()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.reload_extensions",
		"() -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"await omp.agents.reload_extensions()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.is_idle",
		"() -> bool",
		CallbackAbi::None,
		OPEN_METERED,
		"await omp.agents.is_idle()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.wait_for_idle",
		"() -> None",
		CallbackAbi::None,
		OPEN_METERED,
		"await omp.agents.wait_for_idle()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.agents.pending_messages",
		"() -> int",
		CallbackAbi::None,
		OPEN_METERED,
		"await omp.agents.pending_messages()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.fs.privileged_mutation",
		"(request: PrivilegedMutationIntent) -> PrivilegedMutationResult",
		CallbackAbi::None,
		ENV_WRITE,
		"await env.privileged_mutation(request)"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.worktree",
		"() -> WorktreeInfo | None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worktree()"
	),
	symbol!(
		"docs/py/11-env.md",
		"omp.env.Process.info",
		"() -> ProcessInfo",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await process.info()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.workspace.list",
		"(*, limit=50) -> list[WorkspaceSnapshot]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.workspace.list()"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.status",
		"(request: McpStatusRequest) -> McpStatusResult",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_status(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.subscribe",
		"(request: McpSubscribeRequest) -> McpSubscription",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_subscribe(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.reset",
		"(request: McpResetRequest) -> McpResetResult",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_reset(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.live_header",
		"(request: McpLiveHeaderRequest) -> McpLiveHeader",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_live_header(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.resource",
		"(request: McpResourceRequest) -> McpResourceResult",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_resource(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.prompt",
		"(request: McpPromptRequest) -> McpPromptResult",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_prompt(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.invoke",
		"(request: McpInvokeRequest) -> McpInvokeResult",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await env.mcp_invoke(request)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.env.mcp.config",
		"(request: McpConfigRequest) -> McpConfigResult",
		CallbackAbi::None,
		ENV_WRITE,
		"await env.mcp_config(request)"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.workspace.snapshot",
		"(*, root=None) -> WorkspaceSnapshot",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.workspace.snapshot()"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.workspace.capture_inputs",
		"(request: CaptureInputsRequest) -> CaptureInputsReply",
		CallbackAbi::None,
		ENV_WRITE,
		"await env.capture_inputs(request)"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.workspace.restore",
		"(snapshot, *, dry_run=False) -> RestoreOutcome",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.workspace.restore(snapshot)"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.worktree.create",
		"(name, *, base=None) -> Worktree",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.worktree.create(\"review\")"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.worktree.destroy",
		"(worktree) -> None",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.worktree.destroy(worktree)"
	),
	symbol!(
		"docs/py/12-agents.md",
		"omp.env.worktree.merge",
		"(worktree, *, target=None) -> MergeOutcome",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.worktree.merge(worktree)"
	),
	symbol!(
		"docs/py/04-placement.md",
		"omp.env.worker.open",
		"(spec) -> Worker",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worker.open(spec)"
	),
	symbol!(
		"docs/py/04-placement.md",
		"omp.env.worker.close",
		"(name, generation) -> None",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worker.close(name, generation)"
	),
	symbol!(
		"docs/py/04-placement.md",
		"omp.env.worker.data",
		"(name, generation, channel, data) -> bytes",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worker.data(name, generation, channel, data)"
	),
	symbol!(
		"docs/py/04-placement.md",
		"omp.env.worker.info",
		"(name) -> WorkerInfo",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worker.info(name)"
	),
	symbol!(
		"docs/py/04-placement.md",
		"omp.env.worker.list",
		"() -> list[WorkerInfo]",
		CallbackAbi::None,
		ENV_EPHEMERAL,
		"await omp.env.worker.list()"
	),
	symbol!(
		"docs/py/14-deploy.md",
		"omp.env.site.materialize",
		"(site: SiteManifest, /) -> SiteTree",
		CallbackAbi::None,
		ENV_WRITE,
		"await omp.env.site.materialize(site)"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.tml",
		"(template: str, /, **fields: object) -> Tml",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.tml(\"<text>{value}</text>\", value=\"safe\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.text",
		"(value: object) -> Tml",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.text(value)"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.md",
		"(source: object) -> Tml",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.md(\"# heading\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.join",
		"(parts, sep='') -> Tml",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.join(parts)"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.icon",
		"(name: str, *, fg=None) -> Tml",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.icon(\"check\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.mount",
		"(placement, content, options=None, *, key=None) -> SlotHandle",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.mount(ui.Slot.HEADER, ui.text(\"ready\"))"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.handle",
		"(key: str) -> SlotHandle",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.handle(\"status\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.unmount",
		"(key: str) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.unmount(\"status\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.unmount_all",
		"() -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.unmount_all()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.focus_slot",
		"(key: str) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.focus_slot(\"rail\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.blur_slot",
		"() -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.blur_slot()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_status",
		"(key, content, *, order=100, side=Slot.STATUS_RIGHT) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_status(\"git\", ui.text(\"main\"))"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_working_message",
		"(content) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_working_message(ui.text(\"working\"))"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_title",
		"(title) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_title(\"omp\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_progress",
		"(state) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_progress(ui.Progress.indeterminate())"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.bell",
		"() -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.bell()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_ghost",
		"(ghost) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_ghost(ui.Ghost(\"next\"))"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.clear_ghost",
		"() -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.clear_ghost()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.set_editor_text",
		"(text: str) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.set_editor_text(\"draft\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.paste_to_editor",
		"(content) -> None",
		CallbackAbi::None,
		OPEN_LOCAL,
		"ui.paste_to_editor(\"draft\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.presentation",
		"() -> Presentation",
		CallbackAbi::None,
		OPEN_METERED,
		"await ui.presentation()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.icons",
		"(prefix='') -> tuple[str, ...]",
		CallbackAbi::None,
		OPEN_METERED,
		"await ui.icons()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.editor_text",
		"() -> str",
		CallbackAbi::None,
		OPEN_METERED,
		"await ui.editor_text()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.notify",
		"(message, *, level=Level.INFO, ...) -> None",
		CallbackAbi::None,
		CORE_DURABLE,
		"ui.notify(\"done\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.open_url",
		"(url: str) -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"ui.open_url(\"https://omp.dev\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.submit",
		"(text=None) -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"ui.submit()"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.image",
		"(source, *, w=None, h=None, trim=False) -> Tml",
		CallbackAbi::None,
		CORE_EFFECT,
		"ui.image(blob)"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.overlay",
		"(content, options=None, *, watch=()) -> OverlayHandle",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.overlay(ui.text(\"details\"))"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.confirm",
		"(title, message='', *, options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.confirm(\"Continue?\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.select",
		"(title, items, *, options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.select(\"Pick\", [\"one\"])"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.multi_select",
		"(title, items, *, checked=(), options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.multi_select(\"Pick\", [\"one\"])"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.input",
		"(title, *, placeholder='', prefill='', ...) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.input(\"Name\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.editor",
		"(title, *, prefill='', syntax=None, options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.editor(\"Edit\")"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.form",
		"(title, fields, *, options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.form(\"Edit\", [])"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.ask_user",
		"(questions, *, options=None) -> DialogOutcome",
		CallbackAbi::None,
		CORE_EFFECT,
		"await ui.ask_user([])"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.DynamicDeviceParent.mount_many",
		"(*specs: MountSpec) -> tuple[str, ...]",
		CallbackAbi::None,
		CORE_EFFECT,
		"paths = await parent.mount_many(spec)",
		&["omp.devices.dynamic_mount"]
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.devices.set_availability",
		"(*deltas: AvailabilityDelta) -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"await omp.devices.set_availability(omp.AvailabilityDelta(\"jira\", False))"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.devices.refresh",
		"() -> tuple[DeviceInfo, ...]",
		CallbackAbi::None,
		CORE_EFFECT,
		"rows = await omp.devices.refresh()"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.devices.invoke",
		"(path: str, args: Mapping[str, object], *, deadline: Duration | None = None) -> object",
		CallbackAbi::None,
		CORE_EFFECT,
		"result = await omp.devices.invoke(\"jira/create\", {\"title\": \"x\"})"
	),
	symbol!(
		"docs/py/05-hooks.md",
		"omp.hooks.dispatch_hook",
		"(event: str, payload: object = None) -> HookDecision",
		CallbackAbi::None,
		CORE_EFFECT,
		"decision = await omp.hooks.dispatch_hook(\"tool_call\", payload)",
		&["omp.hooks.dispatch"]
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.mcp.invoke",
		"(server: str, tool: str, arguments: dict) -> object",
		CallbackAbi::None,
		CORE_EFFECT,
		"result = await device(query=\"rust\")"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.prompts.invalidate",
		"(slot: str) -> int",
		CallbackAbi::None,
		OPEN_DURABLE,
		"generation = await omp.prompts.invalidate(\"project_rules\")"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.request",
		"(operation: Operation, request: ImageRequest | SpeechRequest | TranscriptionRequest | \
		 RealtimeRequest) -> ImageResult | SpeechResult | TranscriptionResult | RealtimeSession",
		CallbackAbi::None,
		CORE_PAID,
		"result = await handle.request(omp.Operation.GENERATE_IMAGE, request)"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.replace",
		"(spec: ProviderSpec) -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"await handle.replace(spec)"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.retract",
		"() -> None",
		CallbackAbi::None,
		CORE_EFFECT,
		"await handle.retract()"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.models",
		"() -> tuple[ModelCard, ...]",
		CallbackAbi::None,
		OPEN_METERED,
		"cards = await omp.provider.models()"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.is_authenticated",
		"() -> bool",
		CallbackAbi::None,
		OPEN_METERED,
		"ready = await handle.is_authenticated()"
	),
	symbol!(
		"docs/py/13-inference.md",
		"omp.provider.watch_models",
		"(since: Cursor | None = None) -> WatchModels",
		CallbackAbi::None,
		OPEN_METERED,
		"async for event in omp.provider.watch_models(): pass"
	),
	symbol!(
		"docs/py/10-telemetry.md",
		"omp.telemetry.flush",
		"(*, timeout: Duration = Duration(\"10s\")) -> bool",
		CallbackAbi::None,
		OPEN_METERED,
		"flushed = await omp.telemetry.flush()"
	),
	symbol!(
		"docs/py/10-telemetry.md",
		"omp.telemetry.query",
		"(q: Query) -> QueryResult",
		CallbackAbi::None,
		OPEN_METERED,
		"result = await omp.telemetry.query(q)"
	),
	symbol!(
		"docs/py/10-telemetry.md",
		"omp.telemetry.rev_metrics",
		"(tool: str, *, family: str | None = None, since: datetime | timedelta | None = None, \
		 scope: Scope = Scope.PROJECT) -> tuple[RevMetrics, ...]",
		CallbackAbi::None,
		OPEN_METERED,
		"rows = await omp.telemetry.rev_metrics(\"read\")"
	),
	symbol!(
		"docs/py/10-telemetry.md",
		"omp.telemetry.span",
		"(name: str, /, **attrs: str | int | float | bool) -> Span",
		CallbackAbi::None,
		OPEN_METERED,
		"async with omp.telemetry.span(\"index\"): pass",
		&["omp.telemetry.span.open", "omp.telemetry.span.close"]
	),
	symbol!(
		"docs/py/10-telemetry.md",
		"omp.telemetry.export",
		"(target: ExportTarget, *, kinds: Sequence[Kind | str] = (), sample: float = 1.0) -> \
		 ExportHandle",
		CallbackAbi::None,
		OPEN_METERED,
		"handle = omp.telemetry.export(omp.telemetry.OtlpTarget(endpoint))",
		&["omp.telemetry.export.stop", "omp.telemetry.export.stats"]
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.mcp.mount",
		"(spec: McpMount) -> tuple[Device, ...]",
		CallbackAbi::None,
		OPEN_METERED,
		"devices = await omp.mcp.mount(spec)"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.mcp.unmount",
		"(server: str) -> None",
		CallbackAbi::None,
		OPEN_METERED,
		"await omp.mcp.unmount(\"github\")"
	),
	symbol!(
		"docs/py/01-devices.md",
		"omp.mcp.servers",
		"() -> tuple[McpServer, ...]",
		CallbackAbi::None,
		OPEN_METERED,
		"rows = await omp.mcp.servers()"
	),
	symbol!(
		"docs/py/18-convars.md",
		"omp.convars.declare",
		"(key: str, *, kind: str, default, description=None, values=(), ui=None) -> Snapshot",
		CallbackAbi::None,
		OPEN_METERED,
		"setting = await omp.convars.declare(\"verbosity\", kind=\"string\", default=\"normal\")"
	),
	symbol!(
		"docs/py/18-convars.md",
		"omp.convars.get",
		"(name: str) -> Snapshot",
		CallbackAbi::None,
		OPEN_METERED,
		"snapshot = await omp.convars.get(\"sv_interrupt_grace\")"
	),
	symbol!(
		"docs/py/18-convars.md",
		"omp.convars.observe",
		"(name: str) -> Observation",
		CallbackAbi::None,
		OPEN_METERED,
		"async for snapshot in omp.convars.observe(name): pass"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.view",
		"() -> ContextView",
		CallbackAbi::None,
		OPEN_METERED,
		"view = await omp.context.view()"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.usage",
		"() -> ContextUsage",
		CallbackAbi::None,
		OPEN_METERED,
		"usage = await omp.context.usage()"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.epoch",
		"() -> int",
		CallbackAbi::None,
		OPEN_METERED,
		"epoch = await omp.context.epoch()"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.pin",
		"(ids: Iterable[str], *, reason: str) -> int",
		CallbackAbi::None,
		OPEN_DURABLE,
		"await omp.context.pin(ids, reason=\"carrying the repro\")"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.unpin",
		"(ids: Iterable[str]) -> int",
		CallbackAbi::None,
		OPEN_DURABLE,
		"await omp.context.unpin(ids)"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.context.compact",
		"(*, tier: CompactionTier | None = None, focus: str = \"\") -> CompactionOutcome",
		CallbackAbi::None,
		OPEN_DURABLE,
		"outcome = await omp.context.compact()"
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.MessageRef.parts",
		"() -> list[Part]",
		CallbackAbi::None,
		OPEN_METERED,
		"parts = await message.parts()",
		&["omp.context.message.parts"]
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.MessageRef.verdict",
		"() -> Payload | Fault",
		CallbackAbi::None,
		OPEN_METERED,
		"verdict = await message.verdict()",
		&["omp.context.message.verdict"]
	),
	symbol!(
		"docs/py/08-context.md",
		"omp.MessageRef.raw_args",
		"() -> bytes | None",
		CallbackAbi::None,
		OPEN_METERED,
		"raw = await message.raw_args()",
		&["omp.context.message.raw_args"]
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.dynamic_mount",
		"(*specs: CommandMountSpec) -> tuple[str, ...]",
		CallbackAbi::None,
		OPEN_LOCAL,
		"await omp.ui.dynamic_mount(spec)"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.message_renderer",
		"(kind: str) -> Decorator",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"@ui.message_renderer(\"notice\")\ndef render(message, ctx): return None"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.completion",
		"(trigger: Trigger) -> Decorator",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"@ui.completion(ui.Trigger(\"@\"))\nasync def complete(query, ctx): return []"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.shortcut",
		"(chord: str, *, action_id=None, ...) -> Decorator",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"@ui.shortcut(\"ctrl+alt+h\")\nasync def action(payload, ctx): pass"
	),
	symbol!(
		"docs/py/07-ui.md",
		"omp.ui.command",
		"(name: str, *, aliases=(), ...) -> Decorator",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"@ui.command(\"hello\")\nasync def command(payload, ctx): return None"
	),
	symbol!(
		"docs/py/02-verdicts.md",
		"omp.renderer",
		"(name, *, family=None, rev=None, reduce=None, decorates=False) -> Decorator",
		CallbackAbi::PayloadContext,
		OPEN_LOCAL,
		"@omp.renderer(\"tool\")\ndef render(view, ctx): return None"
	),
];

/// Returns every canonical runtime symbol row without allocation.
pub const fn runtime_symbols() -> &'static [RuntimeSymbolSpec] {
	RUNTIME_SYMBOLS
}

/// Runtime-duration configuration and telemetry names checked by CI.
pub static RUNTIME_DURATION_METADATA: &[RuntimeDurationMetadata] = &[RuntimeDurationMetadata {
	public_name:       "omp.params.interrupt_grace",
	default_value:     DEFAULT_INTERRUPT_GRACE,
	configuration_key: "runtime.interrupt_grace",
	telemetry_ns:      "omp.runtime.interrupt_grace.ns",
	telemetry_unit:    "omp.runtime.interrupt_grace.unit",
}];

/// Returns typed runtime-duration metadata without allocation.
pub const fn runtime_duration_metadata() -> &'static [RuntimeDurationMetadata] {
	RUNTIME_DURATION_METADATA
}

/// Returns canonical operation metadata by public symbol or internal dispatch
/// key.
pub fn operation_spec(symbol_name: &str) -> Option<&'static OperationSpec> {
	RUNTIME_SYMBOLS
		.iter()
		.find(|symbol| {
			symbol.public_name == symbol_name || symbol.dispatch_key.contains(&symbol_name)
		})
		.map(|symbol| &symbol.operation)
}

/// Lazily generates the phase legality matrix from canonical operation
/// metadata.
pub fn phase_legality_matrix()
-> impl DoubleEndedIterator<Item = PhaseLegalityRow> + ExactSizeIterator + Clone {
	RUNTIME_SYMBOLS.iter().map(|symbol| PhaseLegalityRow {
		public_name: symbol.public_name,
		legal:       InvocationPhase::ALL
			.map(|phase| phase.allows_operation(symbol.operation.minimum_phase)),
	})
}
