# `omp.policy`

`omp.policy` provides immutable Bash analysis, policy and sandbox data, durable approvals, and host-backed policy operations. Use it to reason about structured effects rather than parsing command strings yourself.

```python
import omp


@omp.hook("tool_call", phase=omp.HookPhase.PRECHECK)
def deny_egress(event: omp.ToolCallEvent, ctx: omp.Context):
    if event.bash is not None and event.bash.net_sinks():
        return omp.Deny("network egress is disabled", code="network.egress")
    return omp.Defer()
```

See [Regimes and policy](../guides/regimes-and-policy.md) for an end-to-end policy flow.

## Bash IR constants

### omp.policy.BASH_IR_REV

```python
BASH_IR_REV: Final[str] = "bashir@3"
```

Identifies the Bash IR schema emitted by this host.

### omp.policy.BASH_IR_MAX_SOURCE

```python
BASH_IR_MAX_SOURCE: Final[int] = 262144
```

Caps analyzed shell source at 262,144 bytes.

### omp.policy.BASH_IR_MAX_NODES

```python
BASH_IR_MAX_NODES: Final[int] = 50000
```

Caps one Bash IR at 50,000 syntax nodes.

### omp.policy.BASH_IR_MAX_DEPTH

```python
BASH_IR_MAX_DEPTH: Final[int] = 128
```

Caps analyzer nesting at 128 levels.

### omp.policy.POLICY_DEADLINE

```python
POLICY_DEADLINE: Final[Duration] = Duration("30s")
```

Provides the standard 30-second policy deadline.

### omp.policy.APPROVAL_DEADLINE

```python
APPROVAL_DEADLINE: Final[Duration] = Duration("5m")
```

Provides the default five-minute external-approver timeout.

### omp.policy.VIOLATION_COALESCE

```python
VIOLATION_COALESCE: Final[Duration] = Duration("1s")
```

Defines the one-second window for coalescing repeated violations.

## Bash vocabulary

### omp.policy.ParseFailure

```python
class ParseFailure(StrEnum)
```

Classifies a Bash IR parse failure.

| Member | Wire value | Meaning |
|---|---|---|
| `SYNTAX` | `"syntax"` | Invalid shell syntax |
| `UNTERMINATED` | `"unterminated"` | Unclosed syntax construct |
| `NODE_LIMIT` | `"node_limit"` | Node ceiling exceeded |
| `SOURCE_LIMIT` | `"source_limit"` | Source ceiling exceeded |
| `DEPTH_LIMIT` | `"depth_limit"` | Nesting ceiling exceeded |
| `TIMEOUT` | `"timeout"` | Analyzer timed out |

### omp.policy.AndOrOp

```python
class AndOrOp(StrEnum)
```

Names the operator between adjacent pipelines.

| Member | Wire value | Meaning |
|---|---|---|
| `AND` | `"and"` | `&&` |
| `OR` | `"or"` | `||` |

### omp.policy.Separator

```python
class Separator(StrEnum)
```

Describes how an and-or list terminates.

| Member | Wire value | Meaning |
|---|---|---|
| `SEQUENCE` | `"sequence"` | Sequential terminator |
| `ASYNC` | `"async"` | Background terminator |

### omp.policy.Dynamism

```python
class Dynamism(IntFlag)
```

Records dynamic shell-expansion features; flags may be combined.

| Member | Value | Meaning |
|---|---:|---|
| `NONE` | `0` | No dynamic expansion |
| `PARAMETER` | `1` | Parameter expansion |
| `COMMAND_SUB` | `2` | Command substitution |
| `ARITHMETIC` | `4` | Arithmetic expansion |
| `TILDE` | `8` | Tilde expansion |
| `GLOB` | `16` | Pathname globbing |
| `BRACE` | `32` | Brace expansion |
| `ESCAPE` | `64` | Escape processing |

### omp.policy.Quoting

```python
class Quoting(StrEnum)
```

Classifies shell-word quoting.

| Member | Wire value | Meaning |
|---|---|---|
| `BARE` | `"bare"` | Unquoted |
| `SINGLE` | `"single"` | Single quoted |
| `DOUBLE` | `"double"` | Double quoted |
| `ANSI_C` | `"ansi_c"` | ANSI-C quoted |
| `MIXED` | `"mixed"` | Multiple quoting forms |

### omp.policy.RedirectOp

```python
class RedirectOp(StrEnum)
```

Classifies a shell redirection operator.

| Member | Wire value | Meaning |
|---|---|---|
| `READ` | `"read"` | Read from a file |
| `WRITE` | `"write"` | Write a file |
| `APPEND` | `"append"` | Append to a file |
| `READ_WRITE` | `"read_write"` | Open for reading and writing |
| `CLOBBER` | `"clobber"` | Force overwrite |
| `DUP_IN` | `"dup_in"` | Duplicate input descriptor |
| `DUP_OUT` | `"dup_out"` | Duplicate output descriptor |
| `HERE_DOC` | `"here_doc"` | Here-document input |
| `HERE_STRING` | `"here_string"` | Here-string input |
| `OUT_AND_ERR` | `"out_and_err"` | Redirect stdout and stderr |

### omp.policy.RedirectTarget

```python
class RedirectTarget(StrEnum)
```

Classifies the target of a redirection.

| Member | Wire value | Meaning |
|---|---|---|
| `FILE` | `"file"` | Filesystem path |
| `FD` | `"fd"` | File descriptor |
| `PROCESS_SUB` | `"process_sub"` | Process substitution |
| `DUPLICATE` | `"duplicate"` | Expansion-dependent duplicate target |

### omp.policy.ProcessSubDirection

```python
class ProcessSubDirection(StrEnum)
```

Describes process-substitution data flow.

| Member | Wire value | Meaning |
|---|---|---|
| `READ` | `"read"` | `<(...)` |
| `WRITE` | `"write"` | `>(...)` |

### omp.policy.CompoundKind

```python
class CompoundKind(StrEnum)
```

Classifies a compound shell command.

| Member | Wire value | Meaning |
|---|---|---|
| `ARITHMETIC` | `"arithmetic"` | Arithmetic command |
| `ARITHMETIC_FOR` | `"arithmetic_for"` | Arithmetic `for` loop |
| `BRACE_GROUP` | `"brace_group"` | Brace group |
| `SUBSHELL` | `"subshell"` | Subshell group |
| `FOR` | `"for"` | `for` loop |
| `CASE` | `"case"` | `case` command |
| `IF` | `"if"` | Conditional |
| `WHILE` | `"while"` | `while` loop |
| `UNTIL` | `"until"` | `until` loop |
| `COPROCESS` | `"coprocess"` | Coprocess |

### omp.policy.Access

```python
class Access(IntFlag)
```

Describes inferred filesystem access; flags may be combined.

| Member | Value | Meaning |
|---|---:|---|
| `READ` | `1` | Read data |
| `WRITE` | `2` | Replace data |
| `APPEND` | `4` | Append data |
| `EXEC` | `8` | Execute path |
| `DELETE` | `16` | Remove path |
| `METADATA` | `32` | Inspect metadata |
| `CREATE` | `64` | Create path |

### omp.policy.PathOrigin

```python
class PathOrigin(StrEnum)
```

Identifies syntax that produced a path reference.

| Member | Wire value | Meaning |
|---|---|---|
| `ARGV` | `"argv"` | Command argument |
| `REDIRECT` | `"redirect"` | Redirection |
| `ASSIGNMENT` | `"assignment"` | Assignment |
| `CWD` | `"cwd"` | Working-directory change |
| `HEREDOC` | `"heredoc"` | Here-document |
| `INTERPRETER` | `"interpreter"` | Inline interpreter code |
| `PROCESS_SUB` | `"process_sub"` | Process substitution |
| `TEST` | `"test"` | Test expression |

### omp.policy.NetKind

```python
class NetKind(StrEnum)
```

Classifies inferred network activity.

| Member | Wire value | Meaning |
|---|---|---|
| `HTTP` | `"http"` | HTTP traffic |
| `GIT_REMOTE` | `"git_remote"` | Git remote |
| `SSH` | `"ssh"` | SSH |
| `SCP` | `"scp"` | SCP |
| `RSYNC` | `"rsync"` | rsync transport |
| `DNS` | `"dns"` | DNS |
| `RAW_SOCKET` | `"raw_socket"` | Raw socket tool |
| `PACKAGE_MANAGER` | `"package_manager"` | Package registry access |
| `UNKNOWN` | `"unknown"` | Unclassified network effect |

### omp.policy.NetDirection

```python
class NetDirection(StrEnum)
```

Describes inferred network data flow.

| Member | Wire value | Meaning |
|---|---|---|
| `EGRESS` | `"egress"` | Outbound |
| `INGRESS` | `"ingress"` | Inbound |
| `BIDIRECTIONAL` | `"bidirectional"` | Both directions |

### omp.policy.OpaqueReason

```python
class OpaqueReason(StrEnum)
```

Explains why shell behavior could not be analyzed.

| Member | Wire value | Meaning |
|---|---|---|
| `EVAL` | `"eval"` | `eval` executes generated text |
| `SOURCE` | `"source"` | Sourced code is unavailable |
| `EXEC_REPLACE` | `"exec_replace"` | Dynamic process replacement |
| `DYNAMIC_NAME` | `"dynamic_name"` | Command name is dynamic |
| `STDIN_DRIVEN` | `"stdin_driven"` | Standard input determines commands |
| `INTERPRETER_DYNAMIC` | `"interpreter_dynamic"` | Interpreter payload is dynamic |
| `JQ_SYSTEM` | `"jq_system"` | jq may invoke the system |
| `TEST_SUBSCRIPT` | `"test_subscript"` | Test subscript is dynamic |

## Bash IR data

All Bash IR records are frozen, slotted dataclasses.

### omp.policy.Span

```python
Span(start: int, end: int, line: int, column: int)
```

Locates syntax in the original script.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `start` | `int` | required | Inclusive UTF-8 byte offset |
| `end` | `int` | required | Exclusive UTF-8 byte offset |
| `line` | `int` | required | Source line |
| `column` | `int` | required | Source column |

### omp.policy.ParseError

```python
ParseError(kind: ParseFailure, message: str, span: Span | None)
```

Describes a failed parse.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ParseFailure` | required | Failure class |
| `message` | `str` | required | Analyzer explanation |
| `span` | `Span | None` | required | Related syntax location, if known |

### omp.policy.BashArg

```python
BashArg(text: str, dynamic: bool, dynamism: Dynamism, quoting: Quoting, span: Span)
```

Describes one shell argument.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `text` | `str` | required | Argument text |
| `dynamic` | `bool` | required | Whether any dynamic feature is present |
| `dynamism` | `Dynamism` | required | Expansion flags |
| `quoting` | `Quoting` | required | Quoting form |
| `span` | `Span` | required | Source location |

### omp.policy.BashAssignment

```python
BashAssignment(
    name: str,
    index: str | None,
    value: str | None,
    elements: tuple[tuple[str | None, str], ...],
    array: bool,
    append: bool,
    exported: bool,
    dynamism: Dynamism,
    span: Span,
)
```

Describes one shell assignment.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Variable name |
| `index` | `str | None` | required | Array subscript, if present |
| `value` | `str | None` | required | Scalar value |
| `elements` | `tuple[tuple[str | None, str], ...]` | required | Array entries |
| `array` | `bool` | required | Whether this is an array assignment |
| `append` | `bool` | required | Whether `+=` was used |
| `exported` | `bool` | required | Whether the value is exported |
| `dynamism` | `Dynamism` | required | Expansion flags |
| `span` | `Span` | required | Source location |

### omp.policy.HereDoc

```python
HereDoc(delimiter: str, body: str, strip_tabs: bool, expands: bool)
```

Describes a here-document payload.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `delimiter` | `str` | required | Closing delimiter |
| `body` | `str` | required | Document body |
| `strip_tabs` | `bool` | required | Whether leading tabs are stripped |
| `expands` | `bool` | required | Whether shell expansion applies |

### omp.policy.PathRef

```python
PathRef(
    lexical: str,
    resolved: str | None,
    absolute: str | None,
    access: Access,
    origin: PathOrigin,
    command_index: int,
    outside_workspace: bool,
    exists: bool,
    dynamic: bool,
    span: Span,
)
```

Describes one inferred filesystem reference.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `lexical` | `str` | required | Path as written |
| `resolved` | `str | None` | required | Resolved path, if known |
| `absolute` | `str | None` | required | Lexical path made absolute, if possible |
| `access` | `Access` | required | Inferred operations |
| `origin` | `PathOrigin` | required | Producing syntax |
| `command_index` | `int` | required | Index in `BashIR.commands` |
| `outside_workspace` | `bool` | required | Whether it is outside all workspace roots |
| `exists` | `bool` | required | Whether the target exists |
| `dynamic` | `bool` | required | Whether resolution depends on expansion |
| `span` | `Span` | required | Source location |

### omp.policy.NetRef

```python
NetRef(
    kind: NetKind,
    direction: NetDirection,
    host: str | None,
    port: int | None,
    scheme: str | None,
    url: str | None,
    command_index: int,
    dynamic: bool,
    span: Span,
)
```

Describes one inferred network reference.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `NetKind` | required | Network mechanism |
| `direction` | `NetDirection` | required | Data direction |
| `host` | `str | None` | required | Host, if known |
| `port` | `int | None` | required | Port, if known |
| `scheme` | `str | None` | required | URL scheme, if known |
| `url` | `str | None` | required | URL, if known |
| `command_index` | `int` | required | Index in `BashIR.commands` |
| `dynamic` | `bool` | required | Whether the target is dynamic |
| `span` | `Span` | required | Source location |

### omp.policy.OpaqueEvaluator

```python
OpaqueEvaluator(command_index: int, name: str, reason: OpaqueReason, span: Span)
```

Describes one evaluator whose executed behavior is not statically visible.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command_index` | `int` | required | Index in `BashIR.commands` |
| `name` | `str` | required | Evaluator name |
| `reason` | `OpaqueReason` | required | Why analysis is incomplete |
| `span` | `Span` | required | Source location |

### omp.policy.ProcessSubIR

```python
ProcessSubIR(direction: ProcessSubDirection, body: tuple[BashAndOrList, ...], span: Span)
```

Describes one process substitution.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `ProcessSubDirection` | required | Data direction |
| `body` | `tuple[BashAndOrList, ...]` | required | Nested shell structure |
| `span` | `Span` | required | Source location |

### omp.policy.BashRedirect

```python
BashRedirect(
    fd: int | None,
    op: RedirectOp,
    target_kind: RedirectTarget,
    target: str | None,
    target_fd: int | None,
    process_sub: ProcessSubIR | None,
    heredoc: HereDoc | None,
    dynamism: Dynamism,
    path: PathRef | None,
    span: Span,
)
```

Describes one shell redirection.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `fd` | `int | None` | required | Explicit source descriptor |
| `op` | `RedirectOp` | required | Redirection operation |
| `target_kind` | `RedirectTarget` | required | Target class |
| `target` | `str | None` | required | Target text |
| `target_fd` | `int | None` | required | Target descriptor |
| `process_sub` | `ProcessSubIR | None` | required | Nested process substitution |
| `heredoc` | `HereDoc | None` | required | Here-document data |
| `dynamism` | `Dynamism` | required | Expansion flags |
| `path` | `PathRef | None` | required | Inferred file effect |
| `span` | `Span` | required | Source location |

### omp.policy.BashCommandIR

```python
BashCommandIR(
    index: int,
    name: str | None,
    argv: tuple[BashArg, ...],
    dynamic_args: tuple[bool, ...],
    env: tuple[BashAssignment, ...],
    redirects: tuple[BashRedirect, ...],
    process_subs: tuple[ProcessSubIR, ...],
    reads: tuple[PathRef, ...],
    writes: tuple[PathRef, ...],
    net: tuple[NetRef, ...],
    cwd: str | None,
    depth: int,
    container: CompoundKind | None,
    subshell: bool,
    builtin: bool,
    coreutil: bool,
    external: bool,
    read_only: bool,
    interpreter_code: str | None,
    span: Span,
)
```

Describes one flattened simple command.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `index` | `int` | required | Position in `BashIR.commands` |
| `name` | `str | None` | required | Command name |
| `argv` | `tuple[BashArg, ...]` | required | Structured arguments |
| `dynamic_args` | `tuple[bool, ...]` | required | Dynamic flag parallel to `argv` |
| `env` | `tuple[BashAssignment, ...]` | required | Prefix assignments |
| `redirects` | `tuple[BashRedirect, ...]` | required | Redirections |
| `process_subs` | `tuple[ProcessSubIR, ...]` | required | Process substitutions |
| `reads` | `tuple[PathRef, ...]` | required | Command reads |
| `writes` | `tuple[PathRef, ...]` | required | Command writes |
| `net` | `tuple[NetRef, ...]` | required | Command network effects |
| `cwd` | `str | None` | required | Folded working directory |
| `depth` | `int` | required | Structural nesting depth |
| `container` | `CompoundKind | None` | required | Innermost compound kind |
| `subshell` | `bool` | required | Whether it runs in a subshell |
| `builtin` | `bool` | required | Shell builtin classification |
| `coreutil` | `bool` | required | In-process coreutil classification |
| `external` | `bool` | required | External executable classification |
| `read_only` | `bool` | required | Analyzer's per-command read-only result |
| `interpreter_code` | `str | None` | required | Literal inline program, if extracted |
| `span` | `Span` | required | Source location |

### omp.policy.BashCompound

```python
BashCompound(
    kind: CompoundKind,
    body: tuple[BashAndOrList, ...],
    subject: tuple[BashArg, ...],
    redirects: tuple[BashRedirect, ...],
    span: Span,
)
```

Describes one compound command.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `CompoundKind` | required | Compound form |
| `body` | `tuple[BashAndOrList, ...]` | required | Nested body |
| `subject` | `tuple[BashArg, ...]` | required | Condition or operand words |
| `redirects` | `tuple[BashRedirect, ...]` | required | Attached redirections |
| `span` | `Span` | required | Source location |

### omp.policy.BashFunctionDef

```python
BashFunctionDef(
    name: str,
    body: tuple[BashAndOrList, ...],
    redirects: tuple[BashRedirect, ...],
    span: Span,
)
```

Describes one shell function definition.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Function name |
| `body` | `tuple[BashAndOrList, ...]` | required | Function body |
| `redirects` | `tuple[BashRedirect, ...]` | required | Attached redirections |
| `span` | `Span` | required | Source location |

### omp.policy.BashTestExpr

```python
BashTestExpr(source: str, paths: tuple[PathRef, ...], dynamism: Dynamism, span: Span)
```

Describes one shell test expression.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `str` | required | Exact test source |
| `paths` | `tuple[PathRef, ...]` | required | Paths used by file predicates |
| `dynamism` | `Dynamism` | required | Expansion flags |
| `span` | `Span` | required | Source location |

### omp.policy.BashNode

```python
BashNode: TypeAlias = BashCommandIR | BashCompound | BashFunctionDef | BashTestExpr
```

Represents any node yielded by `BashIR.walk()` or stored in a pipeline.

### omp.policy.BashPipeline

```python
BashPipeline(commands: tuple[BashNode, ...], negated: bool, timed: bool, span: Span)
```

Describes a shell pipeline.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `commands` | `tuple[BashNode, ...]` | required | Pipeline nodes |
| `negated` | `bool` | required | Whether `!` negates status |
| `timed` | `bool` | required | Whether `time` applies |
| `span` | `Span` | required | Source location |

### omp.policy.BashAndOrList

```python
BashAndOrList(
    pipelines: tuple[BashPipeline, ...],
    operators: tuple[AndOrOp, ...],
    separator: Separator,
    span: Span,
)
```

Describes pipelines joined with Boolean operators.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `pipelines` | `tuple[BashPipeline, ...]` | required | Ordered pipelines |
| `operators` | `tuple[AndOrOp, ...]` | required | Operators between adjacent pipelines |
| `separator` | `Separator` | required | List terminator |
| `span` | `Span` | required | Source location |

### omp.policy.BashIR

```python
BashIR(
    source: str,
    rev: str,
    parser_rev: str,
    parse_ok: bool,
    parse_error: ParseError | None,
    truncated: bool,
    node_count: int,
    is_compound: bool,
    has_dynamic_eval: bool,
    lists: tuple[BashAndOrList, ...],
    commands: tuple[BashCommandIR, ...],
    functions: tuple[BashFunctionDef, ...],
    reads: tuple[PathRef, ...],
    writes: tuple[PathRef, ...],
    net: tuple[NetRef, ...],
    opaque: tuple[OpaqueEvaluator, ...],
)
```

Exposes immutable host-analyzed Bash syntax and effects.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `str` | required | Exact submitted script |
| `rev` | `str` | required | IR schema revision |
| `parser_rev` | `str` | required | Analyzer revision |
| `parse_ok` | `bool` | required | Whether parsing succeeded |
| `parse_error` | `ParseError | None` | required | Failure details |
| `truncated` | `bool` | required | Whether source was truncated |
| `node_count` | `int` | required | Parsed node count |
| `is_compound` | `bool` | required | Whether compound structure exists |
| `has_dynamic_eval` | `bool` | required | Whether executed behavior is opaque |
| `lists` | `tuple[BashAndOrList, ...]` | required | Structural root lists |
| `commands` | `tuple[BashCommandIR, ...]` | required | Flattened simple commands |
| `functions` | `tuple[BashFunctionDef, ...]` | required | Function definitions |
| `reads` | `tuple[PathRef, ...]` | required | Aggregated reads |
| `writes` | `tuple[PathRef, ...]` | required | Aggregated writes |
| `net` | `tuple[NetRef, ...]` | required | Aggregated network references |
| `opaque` | `tuple[OpaqueEvaluator, ...]` | required | Unanalyzable evaluators |

#### BashIR.walk

```python
def walk(self) -> Iterator[BashNode]
```

Yields every syntax node depth-first in source order, including nested process substitutions.

#### BashIR.simple_commands

```python
def simple_commands(self) -> Iterator[BashCommandIR]
```

Iterates the flattened `commands` tuple.

#### BashIR.segment

```python
def segment(self, index: int) -> str
```

Returns the exact UTF-8 source segment for `commands[index]`.

#### BashIR.is_read_only

```python
def is_read_only(self) -> bool
```

Returns true only when analysis found no writes, no network effects, no dynamic evaluation, and every command is read-only.

#### BashIR.writes_outside

```python
def writes_outside(
    self,
    roots: WorkspaceUri | str | Iterable[WorkspaceUri | str],
) -> tuple[PathRef, ...]
```

Returns writes outside every supplied root. Unresolved paths count as outside.

#### BashIR.reads_outside

```python
def reads_outside(
    self,
    roots: WorkspaceUri | str | Iterable[WorkspaceUri | str],
) -> tuple[PathRef, ...]
```

Returns reads outside every supplied root. Unresolved paths count as outside.

#### BashIR.net_sinks

```python
def net_sinks(self) -> tuple[NetRef, ...]
```

Returns egress and bidirectional network references.

#### BashIR.touches

```python
def touches(self, *patterns: str) -> tuple[PathRef, ...]
```

Returns reads and writes whose lexical or resolved path matches any `fnmatch` pattern.

```python
ir = await omp.policy.parse("curl https://example.com > result.txt")
if ir.net_sinks() or ir.writes_outside(ctx.roots):
    return omp.Deny("command crosses the policy boundary", code="boundary")
```

## Sandbox vocabulary

### omp.policy.SandboxMode

```python
class SandboxMode(StrEnum)
```

Selects sandbox behavior.

| Member | Wire value | Meaning |
|---|---|---|
| `OFF` | `"off"` | No confinement requested |
| `OBSERVE` | `"observe"` | Report without enforcing |
| `ENFORCE` | `"enforce"` | Enforce configured rules |

### omp.policy.SandboxBackend

```python
class SandboxBackend(StrEnum)
```

Names a sandbox backend.

| Member | Wire value | Meaning |
|---|---|---|
| `LANDLOCK` | `"landlock"` | Linux Landlock |
| `BWRAP` | `"bwrap"` | bubblewrap |
| `SEATBELT` | `"seatbelt"` | macOS Seatbelt |
| `JOB_OBJECT` | `"job_object"` | Windows job object |
| `NONE` | `"none"` | No backend |

### omp.policy.RuleEffect

```python
class RuleEffect(StrEnum)
```

Selects a rule's result.

| Member | Wire value | Meaning |
|---|---|---|
| `ALLOW` | `"allow"` | Permit |
| `DENY` | `"deny"` | Refuse |

### omp.policy.NetworkMode

```python
class NetworkMode(StrEnum)
```

Selects network confinement behavior.

| Member | Wire value | Meaning |
|---|---|---|
| `OPEN` | `"open"` | Open network |
| `PROXY` | `"proxy"` | Proxy-mediated network |
| `DENY` | `"deny"` | Denied network |

### omp.policy.DnsPolicy

```python
class DnsPolicy(StrEnum)
```

Selects DNS resolution policy.

| Member | Wire value | Meaning |
|---|---|---|
| `PROXY_ONLY` | `"proxy_only"` | Resolve only through the proxy |
| `ALLOW` | `"allow"` | Permit DNS |
| `DENY` | `"deny"` | Deny DNS |

### omp.policy.SandboxSessionKind

```python
class SandboxSessionKind(StrEnum)
```

Classifies a confined execution session.

| Member | Wire value | Meaning |
|---|---|---|
| `TOOL` | `"tool"` | Tool invocation |
| `USER` | `"user"` | User command |
| `PROCESS` | `"process"` | Named process |
| `WORKER` | `"worker"` | Extension worker |

### omp.policy.FilesystemGrade

```python
class FilesystemGrade(StrEnum)
```

Grades installed filesystem confinement.

| Member | Wire value | Meaning |
|---|---|---|
| `HARD` | `"hard"` | Hard confinement |
| `BROKERED` | `"brokered"` | Broker-mediated access |
| `BEST_EFFORT` | `"best_effort"` | Partial confinement |
| `NONE` | `"none"` | No filesystem confinement |

### omp.policy.NetworkGrade

```python
class NetworkGrade(StrEnum)
```

Grades installed network confinement.

| Member | Wire value | Meaning |
|---|---|---|
| `HARD` | `"hard"` | Hard confinement |
| `PROXY_ONLY` | `"proxy_only"` | Proxy-only confinement |
| `NONE` | `"none"` | No network confinement |

### omp.policy.ProcessGrade

```python
class ProcessGrade(StrEnum)
```

Grades installed process confinement.

| Member | Wire value | Meaning |
|---|---|---|
| `HARD` | `"hard"` | Hard confinement |
| `PARTIAL` | `"partial"` | Partial confinement |
| `NONE` | `"none"` | No process confinement |

### omp.policy.ViolationKind

```python
class ViolationKind(StrEnum)
```

Classifies a sandbox violation.

| Member | Wire value | Meaning |
|---|---|---|
| `FS_READ` | `"fs_read"` | Filesystem read |
| `FS_WRITE` | `"fs_write"` | Filesystem write |
| `FS_EXEC` | `"fs_exec"` | Filesystem execution |
| `FS_CREATE` | `"fs_create"` | Filesystem creation |
| `FS_DELETE` | `"fs_delete"` | Filesystem deletion |
| `NET_CONNECT` | `"net_connect"` | Network connection |
| `NET_BIND` | `"net_bind"` | Network bind |
| `NET_DNS` | `"net_dns"` | DNS access |
| `NET_DOMAIN` | `"net_domain"` | Domain rule |
| `RESOURCE` | `"resource"` | Resource ceiling |
| `PRIVILEGE` | `"privilege"` | Privileged action |
| `UNKNOWN` | `"unknown"` | Unclassified violation |

### omp.policy.TicketState

```python
class TicketState(StrEnum)
```

Describes an approval ticket's lifecycle.

| Member | Wire value | Meaning |
|---|---|---|
| `PENDING` | `"pending"` | Awaiting a decision |
| `DECIDED` | `"decided"` | Resolved |
| `WITHDRAWN` | `"withdrawn"` | No longer active |

### omp.policy.ApprovalSource

```python
class ApprovalSource(StrEnum)
```

Identifies the authority that resolved an approval.

| Member | Wire value | Meaning |
|---|---|---|
| `USER` | `"user"` | Local user |
| `EXTERNAL` | `"external"` | Registered external approver |
| `FORWARDED` | `"forwarded"` | Parent or forwarded authority |
| `CONFIG` | `"config"` | Configuration |
| `EXTENSION` | `"extension"` | Extension authority |
| `TIMEOUT` | `"timeout"` | Timeout resolution |
| `UNAVAILABLE` | `"unavailable"` | Unreachable route resolution |

### omp.policy.Tier

```python
class Tier(StrEnum)
```

Names a call target's default approval tier.

| Member | Wire value | Meaning |
|---|---|---|
| `READ` | `"read"` | Read-shaped operation |
| `WRITE` | `"write"` | State mutation |
| `EXEC` | `"exec"` | Code execution or network use |
| `PRIVILEGED` | `"privileged"` | Credentials, policy, or host access |

## Sandbox and approval data

### omp.policy.PathRule

```python
PathRule(path: str, recursive: bool = True, create: bool = False, delete: bool = False)
```

Describes one filesystem path rule.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `str` | required | Rule path |
| `recursive` | `bool` | `True` | Include descendants |
| `create` | `bool` | `False` | Permit creation under the path |
| `delete` | `bool` | `False` | Permit deletion under the path |

### omp.policy.FilesystemPolicy

```python
FilesystemPolicy(
    allow_read: tuple[PathRule, ...] = (),
    deny_read: tuple[PathRule, ...] = (),
    allow_write: tuple[PathRule, ...] = (),
    deny_write: tuple[PathRule, ...] = (),
    allow_exec: tuple[PathRule, ...] = (),
    deny_exec: tuple[PathRule, ...] = (),
    follow_symlinks: bool = False,
    tmpdir: str | None = None,
    read_default: RuleEffect = RuleEffect.DENY,
    write_default: RuleEffect = RuleEffect.DENY,
    exec_default: RuleEffect = RuleEffect.ALLOW,
)
```

Describes filesystem confinement rules.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `allow_read` | `tuple[PathRule, ...]` | `()` | Read allow rules |
| `deny_read` | `tuple[PathRule, ...]` | `()` | Read deny rules |
| `allow_write` | `tuple[PathRule, ...]` | `()` | Write allow rules |
| `deny_write` | `tuple[PathRule, ...]` | `()` | Write deny rules |
| `allow_exec` | `tuple[PathRule, ...]` | `()` | Execute allow rules |
| `deny_exec` | `tuple[PathRule, ...]` | `()` | Execute deny rules |
| `follow_symlinks` | `bool` | `False` | Whether rules follow symlinks |
| `tmpdir` | `str | None` | `None` | Private temporary directory |
| `read_default` | `RuleEffect` | `DENY` | Unmatched read result |
| `write_default` | `RuleEffect` | `DENY` | Unmatched write result |
| `exec_default` | `RuleEffect` | `ALLOW` | Unmatched execute result |

### omp.policy.DomainRule

```python
DomainRule(domain: str, ports: tuple[int, ...] = ())
```

Describes one network-domain rule.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `domain` | `str` | required | Domain pattern |
| `ports` | `tuple[int, ...]` | `()` | Restricted ports; empty defers to policy ports |

### omp.policy.NetworkPolicy

```python
NetworkPolicy(
    mode: NetworkMode = NetworkMode.PROXY,
    allow_domains: tuple[DomainRule, ...] = (),
    deny_domains: tuple[DomainRule, ...] = (),
    allow_ports: tuple[int, ...] = (80, 443),
    allow_localhost: bool = False,
    allow_unix_sockets: tuple[str, ...] = (),
    allow_mach_lookup: tuple[str, ...] = (),
    dns: DnsPolicy = DnsPolicy.PROXY_ONLY,
    inject_proxy_env: bool = True,
)
```

Describes network confinement rules.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `NetworkMode` | `PROXY` | Network mode |
| `allow_domains` | `tuple[DomainRule, ...]` | `()` | Allowed domains |
| `deny_domains` | `tuple[DomainRule, ...]` | `()` | Denied domains |
| `allow_ports` | `tuple[int, ...]` | `(80, 443)` | Allowed ports |
| `allow_localhost` | `bool` | `False` | Permit localhost |
| `allow_unix_sockets` | `tuple[str, ...]` | `()` | Allowed Unix sockets |
| `allow_mach_lookup` | `tuple[str, ...]` | `()` | Allowed macOS Mach services |
| `dns` | `DnsPolicy` | `PROXY_ONLY` | DNS behavior |
| `inject_proxy_env` | `bool` | `True` | Inject standard proxy variables |

### omp.policy.ExecPolicy

```python
ExecPolicy(
    allow: tuple[str, ...] = (),
    deny: tuple[str, ...] = (),
    default: RuleEffect = RuleEffect.ALLOW,
    allow_interpreters: bool = True,
    allow_setuid: bool = False,
    allow_ptrace: bool = False,
    allow_new_session: bool = False,
    max_children: int | None = None,
)
```

Describes executable and child-process confinement.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `allow` | `tuple[str, ...]` | `()` | Allowed executables |
| `deny` | `tuple[str, ...]` | `()` | Denied executables |
| `default` | `RuleEffect` | `ALLOW` | Unmatched executable result |
| `allow_interpreters` | `bool` | `True` | Permit inline interpreter payloads |
| `allow_setuid` | `bool` | `False` | Permit setuid behavior |
| `allow_ptrace` | `bool` | `False` | Permit tracing |
| `allow_new_session` | `bool` | `False` | Permit new process sessions |
| `max_children` | `int | None` | `None` | Child-process ceiling |

### omp.policy.ResourceBudget

```python
ResourceBudget(
    wall: Duration | None = None,
    cpu: Duration | None = None,
    memory_bytes: int | None = None,
    file_size_bytes: int | None = None,
    open_files: int | None = None,
    processes: int | None = None,
    disk_write_bytes: int | None = None,
    stdout_bytes: int | None = None,
)
```

Describes process resource ceilings. `None` leaves a field unspecified.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wall` | `Duration | None` | `None` | Wall-clock ceiling |
| `cpu` | `Duration | None` | `None` | CPU-time ceiling |
| `memory_bytes` | `int | None` | `None` | Memory ceiling |
| `file_size_bytes` | `int | None` | `None` | Per-file size ceiling |
| `open_files` | `int | None` | `None` | Open-descriptor ceiling |
| `processes` | `int | None` | `None` | Process ceiling |
| `disk_write_bytes` | `int | None` | `None` | Disk-write ceiling |
| `stdout_bytes` | `int | None` | `None` | Standard-output ceiling |

### omp.policy.SandboxProfile

```python
SandboxProfile(
    mode: SandboxMode = SandboxMode.ENFORCE,
    filesystem: FilesystemPolicy = FilesystemPolicy(),
    network: NetworkPolicy = NetworkPolicy(),
    exec: ExecPolicy = ExecPolicy(),
    resources: ResourceBudget = ResourceBudget(),
    label: str = "",
    ignore_violations: tuple[str, ...] = (),
    require: tuple[SandboxBackend, ...] = (),
)
```

Groups composable confinement policy.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `SandboxMode` | `ENFORCE` | Enforcement behavior |
| `filesystem` | `FilesystemPolicy` | `FilesystemPolicy()` | Filesystem rules |
| `network` | `NetworkPolicy` | `NetworkPolicy()` | Network rules |
| `exec` | `ExecPolicy` | `ExecPolicy()` | Execution rules |
| `resources` | `ResourceBudget` | `ResourceBudget()` | Resource ceilings |
| `label` | `str` | `""` | Audit label |
| `ignore_violations` | `tuple[str, ...]` | `()` | Violation-subject patterns to ignore |
| `require` | `tuple[SandboxBackend, ...]` | `()` | Required backends |

### omp.policy.SandboxRequest

```python
SandboxRequest(
    session_kind: SandboxSessionKind,
    cwd: EnvPath,
    roots: tuple[WorkspaceUri, ...],
    backends: tuple[SandboxBackend, ...],
    invocation_id: str | None,
    process_name: str | None,
)
```

Describes a request to establish a sandboxed session.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_kind` | `SandboxSessionKind` | required | Session class |
| `cwd` | `EnvPath` | required | Environment working directory |
| `roots` | `tuple[WorkspaceUri, ...]` | required | Workspace roots |
| `backends` | `tuple[SandboxBackend, ...]` | required | Available backends |
| `invocation_id` | `str | None` | required | Related invocation |
| `process_name` | `str | None` | required | Related named process |

### omp.policy.SandboxCapabilities

```python
SandboxCapabilities(
    backends: tuple[SandboxBackend, ...],
    landlock_abi: int | None,
    filesystem: bool,
    network: bool,
    domain_filtering: bool,
    resource_limits: bool,
    degraded: tuple[str, ...],
)
```

Describes sandbox facilities reported by the host.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `backends` | `tuple[SandboxBackend, ...]` | required | Available backends |
| `landlock_abi` | `int | None` | required | Landlock ABI, if present |
| `filesystem` | `bool` | required | Filesystem confinement support |
| `network` | `bool` | required | Network confinement support |
| `domain_filtering` | `bool` | required | Domain filter support |
| `resource_limits` | `bool` | required | Resource-limit support |
| `degraded` | `tuple[str, ...]` | required | Reported reductions |

### omp.policy.SandboxEnforcement

```python
SandboxEnforcement(
    filesystem: FilesystemGrade,
    network: NetworkGrade,
    process: ProcessGrade,
    backend: str,
    degraded_reasons: tuple[str, ...],
)
```

Reports confinement actually installed for a session.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `filesystem` | `FilesystemGrade` | required | Filesystem grade |
| `network` | `NetworkGrade` | required | Network grade |
| `process` | `ProcessGrade` | required | Process grade |
| `backend` | `str` | required | Installed backend description |
| `degraded_reasons` | `tuple[str, ...]` | required | Reasons for reduced grades |

### omp.policy.Violation

```python
Violation(
    kind: ViolationKind,
    subject: str,
    access: Access | None,
    profile: str,
    rule: str | None,
    backend: SandboxBackend,
    session_kind: SandboxSessionKind,
    invocation_id: str | None,
    command_index: int | None,
    pid: int | None,
    argv0: str | None,
    enforced: bool,
    count: int,
)
```

Describes an observed or enforced sandbox violation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ViolationKind` | required | Violation class |
| `subject` | `str` | required | Path, endpoint, or resource |
| `access` | `Access | None` | required | Filesystem access flags |
| `profile` | `str` | required | Profile label |
| `rule` | `str | None` | required | Matching rule |
| `backend` | `SandboxBackend` | required | Reporting backend |
| `session_kind` | `SandboxSessionKind` | required | Session class |
| `invocation_id` | `str | None` | required | Related invocation |
| `command_index` | `int | None` | required | Related Bash command |
| `pid` | `int | None` | required | Related process |
| `argv0` | `str | None` | required | Executable name |
| `enforced` | `bool` | required | Whether the effect was blocked |
| `count` | `int` | required | Coalesced occurrence count |

### omp.policy.Amend

```python
Amend(
    patch: SandboxProfile,
    scope: PolicyScope = PolicyScope.SESSION,
    reason: str = "",
    retry: bool = False,
    approval: ApprovalSpec | None = None,
)
```

Requests a scoped profile amendment.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `patch` | `SandboxProfile` | required | Profile contribution |
| `scope` | `PolicyScope` | `SESSION` | Amendment lifetime |
| `reason` | `str` | `""` | Audit explanation |
| `retry` | `bool` | `False` | Request retry after amendment |
| `approval` | `ApprovalSpec | None` | `None` | Approval needed for the patch |

### omp.policy.ApprovalDecision

```python
ApprovalDecision(
    approved: bool,
    scope: PolicyScope,
    source: ApprovalSource,
    decided_by: str | None,
    reason: str | None,
    audited: bool,
)
```

Records the durable resolution of an approval ticket.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `approved` | `bool` | required | Decision result |
| `scope` | `PolicyScope` | required | Granted or denied scope |
| `source` | `ApprovalSource` | required | Deciding authority |
| `decided_by` | `str | None` | required | Authority identity |
| `reason` | `str | None` | required | Explanation |
| `audited` | `bool` | required | Whether audited fail-open handling was used |

### omp.policy.ApprovalTicket

```python
ApprovalTicket(
    ticket_id: str,
    invocation_id: str | None,
    reasons: tuple[ApprovalSpec, ...],
    state: TicketState,
    decision: ApprovalDecision | None,
    created_at: float,
)
```

Exposes one durable aggregate approval request.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ticket_id` | `str` | required | Durable ticket identity |
| `invocation_id` | `str | None` | required | Related invocation |
| `reasons` | `tuple[ApprovalSpec, ...]` | required | Aggregated approval specifications |
| `state` | `TicketState` | required | Ticket lifecycle state |
| `decision` | `ApprovalDecision | None` | required | Resolution, if decided |
| `created_at` | `float` | required | Filing timestamp |

### omp.policy.RuleRef

```python
RuleRef(id: str)
```

Identifies a policy rule contributing to a denial.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | required | Rule identity |

### omp.policy.PolicyDenied

```python
PolicyDenied(reason: str, code: str, decision_id: str, rules: tuple[RuleRef, ...])
```

Carries a structured policy denial as an `OmpError`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `str` | required | Human-readable explanation |
| `code` | `str` | required | Machine-readable denial code |
| `decision_id` | `str` | required | Durable decision identity |
| `rules` | `tuple[RuleRef, ...]` | required | Rules that contributed |

The dataclass initializes the base exception with `reason`, so `str(error)` returns that explanation.

### omp.policy.ProfileHandle

```python
ProfileHandle(profile: SandboxProfile, _handle_id: str)
```

Represents one installed scoped profile contribution.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `profile` | `SandboxProfile` | required | Installed profile returned by the host |
| `_handle_id` | `str` | required | Private host handle |

#### ProfileHandle.revoke

```python
async def revoke(self) -> None
```

Revokes this installed contribution through policy authority.

## Host-backed operations

### omp.policy.parse

```python
async def parse(script: str, *, cwd: EnvPath | None = None) -> BashIR
```

Parses shell source with the host analyzer.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `script` | `str` | Shell source |
| `cwd` | `EnvPath | None` | Environment working directory |

**Returns**

A decoded `BashIR`. A script-level parse failure is represented by `parse_ok=False` and `parse_error`.

**Raises**

- `TypeError` — `script` is not a string or the host response cannot decode.
- `NotWiredError` — policy CONTROL is unavailable.
- `PolicyError` — the host disconnects during the request.

### omp.policy.match_paths

```python
async def match_paths(
    path: str,
    *patterns: str,
    cwd: EnvPath | None = None,
    access: Access | None = None,
) -> tuple[PathRef, ...]
```

Resolves and matches a raw path using host policy semantics.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `path` | `str` | Model- or caller-provided path text |
| `patterns` | `str` | Zero or more host match patterns |
| `cwd` | `EnvPath | None` | Environment working directory |
| `access` | `Access | None` | Intended filesystem access |

**Returns**

Matching decoded path references.

**Raises**

`TypeError` for invalid local arguments or an invalid host response; `NotWiredError` when CONTROL is absent; `PolicyError` on disconnection.

### omp.policy.capabilities

```python
async def capabilities() -> SandboxCapabilities
```

Returns sandbox facilities available on the host.

**Returns**

A decoded `SandboxCapabilities` record.

**Raises**

`NotWiredError` when CONTROL is absent, `PolicyError` on disconnection, or `TypeError` for an invalid response.

### omp.policy.effective_profile

```python
async def effective_profile(*, session: str | None = None) -> SandboxProfile
```

Returns the composed profile installed for a session.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `session` | `str | None` | Host session identity; `None` selects the current session |

**Returns**

A decoded `SandboxProfile`.

### omp.policy.enforcement

```python
async def enforcement(*, session: str | None = None) -> SandboxEnforcement
```

Returns the confinement receipt for a session.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `session` | `str | None` | Host session identity; `None` selects the current session |

**Returns**

A decoded `SandboxEnforcement`.

### omp.policy.install

```python
async def install(
    profile: SandboxProfile,
    *,
    scope: PolicyScope = PolicyScope.SESSION,
) -> ProfileHandle
```

Installs a scoped profile that can only narrow confinement.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `profile` | `SandboxProfile` | Contribution to install |
| `scope` | `PolicyScope` | Contribution lifetime |

**Returns**

A handle containing the host's installed profile.

**Raises**

- `TypeError` — local arguments or the host response are invalid.
- `NotWiredError` — policy CONTROL is unavailable.
- `PolicyError` — the host disconnects.
- `ProfileRejected`, `ProfileWidened`, or `EnforcementUnavailable` — when raised by policy authority.

```python
handle = await omp.policy.install(
    omp.SandboxProfile(network=omp.NetworkPolicy(mode=omp.NetworkMode.DENY))
)
try:
    await run_sensitive_work()
finally:
    await handle.revoke()
```

### omp.policy.amend

```python
async def amend(
    patch: SandboxProfile,
    *,
    scope: PolicyScope,
    reason: str,
    approval: ApprovalSpec | None = None,
) -> None
```

Applies a scoped profile amendment under policy authority.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `patch` | `SandboxProfile` | Profile contribution |
| `scope` | `PolicyScope` | Amendment lifetime |
| `reason` | `str` | Audit explanation |
| `approval` | `ApprovalSpec | None` | Approval required by the authority |

**Returns**

`None` after the host accepts the request.

**Raises**

`TypeError` for invalid local arguments, `NotWiredError` when CONTROL is absent, `PolicyError` on disconnection, or a policy exception returned by authority.

### omp.policy.approver

```python
def approver(
    name: str,
    *,
    kinds: Iterable[ApprovalKind] = (),
    timeout: Duration = APPROVAL_DEADLINE,
    unreachable: Unreachable = Unreachable.FAIL_CLOSED,
) -> Callable[[Callable[..., object]], Callable[..., object]]
```

Declares an idempotent external approver without host I/O.

The decorated handler must be an async callable. Registration records its name, accepted approval kinds, timeout, unreachable behavior, and function in the declaration registry.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `name` | `str` | Non-empty approver identity |
| `kinds` | `Iterable[ApprovalKind]` | Approval kinds accepted; empty means no filter |
| `timeout` | `Duration` | Response timeout |
| `unreachable` | `Unreachable` | Behavior when the route cannot answer |

**Returns**

A decorator that returns the original async handler.

**Raises**

`ValueError` for an empty name and `TypeError` for invalid kinds, timeout, unreachable behavior, or a non-async target.

```python
@omp.approver("security", kinds=(omp.ApprovalKind.PRIVILEGE,))
async def security(ticket: omp.ApprovalTicket, ctx: omp.Context):
    return await route_ticket(ticket)
```

### omp.policy.pending

```python
async def pending() -> tuple[ApprovalTicket, ...]
```

Returns pending approval tickets in filing order.

**Returns**

A tuple of decoded durable tickets.

### omp.policy.tier_of

```python
def tier_of(target: CallTarget) -> Tier
```

Returns the effective approval tier from Core's installed authority snapshot.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `target` | `CoreTool | DeviceCall | McpCall` | Logical call target |

**Returns**

The resolved `Tier`.

**Raises**

- `TypeError` — `target` is not a supported call target.
- `PolicyError` — no authority snapshot, no target tier, a disconnect, or an invalid tier result.

> **Warning** `tier_of()` fails closed when Core has not installed an authoritative snapshot; it does not guess from declarations.

### omp.policy.decide

```python
async def decide(ticket_id: str, decision: ApprovalDecision) -> None
```

Resolves a durable approval ticket.

Repeating the identical decision for an idempotently re-offered ticket is a no-op at Core.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `ticket_id` | `str` | Non-empty durable ticket identity |
| `decision` | `ApprovalDecision` | Resolution to record |

**Returns**

`None` after Core accepts the decision.

**Raises**

`ValueError` for an empty ticket id, `TypeError` for another decision type, `NotWiredError` when CONTROL is absent, or `PolicyError` on disconnection.

## Errors

### omp.policy.PolicyError

```python
class PolicyError(OmpError)
```

Base error for policy transport and authority-revision failures.

### omp.policy.ProfileRejected

```python
class ProfileRejected(PolicyError)
```

Reports a malformed profile or one that names a secret placeholder.

### omp.policy.ProfileWidened

```python
class ProfileWidened(PolicyError)
```

Reports a contribution that would loosen running confinement.

### omp.policy.EnforcementUnavailable

```python
class EnforcementUnavailable(PolicyError)
```

Reports that no available backend can satisfy required confinement.
