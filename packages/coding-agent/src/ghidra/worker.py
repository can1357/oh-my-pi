"""omp Ghidra worker: drives one PyGhidra program over an NDJSON socket protocol.

Launched as `worker.py --socket PATH` (Unix socket) or `worker.py --port-file PATH` (loopback TCP;
the bound port is written to PATH). The omp daemon connects, sends `{"token": $OMP_DISASM_WORKER_TOKEN}`
as its first line, then speaks:

Request:  {"id": int, "method": str, "params": dict}
Response: {"id", "ok": true, "result", "dirty"} | {"id", "ok": false, "error": {"type", "message"}}

A dropped connection does not close the program: the daemon reconnects after a restart. With no
connection for `_ORPHAN_S` the worker saves and exits.
"""

import _thread
import ast
import io
import json
import os
import queue
import re
import signal
import socket
import sys
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


def _listen():
    """Bind the protocol listener before the slow JVM start so the daemon can connect at once."""
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--socket":
        try:
            os.unlink(args[1])
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(args[1])
        sock.listen(4)
        return sock
    if len(args) == 2 and args[0] == "--port-file":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(4)
        tmp = args[1] + ".tmp"
        with open(tmp, "w") as f:
            f.write(str(sock.getsockname()[1]))
        os.replace(tmp, args[1])
        return sock
    raise SystemExit("usage: worker.py --socket PATH | --port-file PATH")


_TOKEN = os.environ.pop("OMP_DISASM_WORKER_TOKEN", "")
_listener = _listen()

# Set by SIGTERM: the main loop saves and exits once the running request (if any) finishes.
_terminate = False


def _on_sigterm(signum, frame):
    global _terminate
    _terminate = True


# SIGTERM must not kill us mid-request or mid-save: it only asks the main loop to save and exit
# at the next request boundary. -Xrs keeps the JVM from replacing this disposition when it starts.
signal.signal(signal.SIGTERM, _on_sigterm)

import jpype  # noqa: E402
import pyghidra  # noqa: E402
from pyghidra.launcher import HeadlessPyGhidraLauncher  # noqa: E402

PROJECT = None
PROGRAM = None
CONSUMER = None
FLAT = None
MONITOR = None
DECOMP = None
NS = {}

_EXEC_FILE = "<ghidra-exec>"
_OVERVIEW_ENTRY_LIMIT = 50
_JAVA_READY = False
_DATABASE_PATH = None


def _init_java():
    """Bind Java classes once, only after the launcher has started the JVM."""
    global _JAVA_READY, MONITOR
    global TaskMonitorAdapter, ProjectLocator, FlatProgramAPI, GhidraProgramUtilities
    global DecompInterface, SourceType, RefType, CommentType, DefinedStringIterator
    global StringDataInstance, FunctionSignatureParser, ApplyFunctionSignatureCmd
    global DataTypeParser, AllowedDataTypes, DataUtilities, ClearDataMode
    global DisassembleCommand, CreateFunctionCmd, AutoAnalysisManager
    if _JAVA_READY:
        return
    TaskMonitorAdapter = jpype.JClass("ghidra.util.task.TaskMonitorAdapter")
    ProjectLocator = jpype.JClass("ghidra.framework.model.ProjectLocator")
    FlatProgramAPI = jpype.JClass("ghidra.program.flatapi.FlatProgramAPI")
    GhidraProgramUtilities = jpype.JClass("ghidra.program.util.GhidraProgramUtilities")
    DecompInterface = jpype.JClass("ghidra.app.decompiler.DecompInterface")
    SourceType = jpype.JClass("ghidra.program.model.symbol.SourceType")
    RefType = jpype.JClass("ghidra.program.model.symbol.RefType")
    CommentType = jpype.JClass("ghidra.program.model.listing.CommentType")
    DefinedStringIterator = jpype.JClass("ghidra.program.util.DefinedStringIterator")
    StringDataInstance = jpype.JClass("ghidra.program.model.data.StringDataInstance")
    FunctionSignatureParser = jpype.JClass("ghidra.app.util.parser.FunctionSignatureParser")
    ApplyFunctionSignatureCmd = jpype.JClass("ghidra.app.cmd.function.ApplyFunctionSignatureCmd")
    DataTypeParser = jpype.JClass("ghidra.util.data.DataTypeParser")
    AllowedDataTypes = jpype.JClass("ghidra.util.data.DataTypeParser$AllowedDataTypes")
    DataUtilities = jpype.JClass("ghidra.program.model.data.DataUtilities")
    ClearDataMode = jpype.JClass("ghidra.program.model.data.DataUtilities$ClearDataMode")
    DisassembleCommand = jpype.JClass("ghidra.app.cmd.disassemble.DisassembleCommand")
    CreateFunctionCmd = jpype.JClass("ghidra.app.cmd.function.CreateFunctionCmd")
    AutoAnalysisManager = jpype.JClass("ghidra.app.plugin.core.analysis.AutoAnalysisManager")
    MONITOR = TaskMonitorAdapter(True)
    _JAVA_READY = True


# ---------------------------------------------------------------------------
# Shared helpers (also preloaded into the exec namespace)
# ---------------------------------------------------------------------------


def _program():
    if PROGRAM is None:
        raise RuntimeError("no Ghidra program open")
    return PROGRAM


def _iter(iterator):
    while iterator.hasNext():
        yield iterator.next()


def _text(lines):
    return "\n".join(str(line).expandtabs(4) for line in lines)


def _hex(ea):
    return f"0x{ea:x}"


def _regex(pattern):
    return re.compile(pattern, re.IGNORECASE) if pattern else None


def _address(ea):
    # JPype otherwise selects the int overload and rejects 64-bit Mach-O addresses.
    return FLAT.toAddr(jpype.JLong(ea))


def resolve(t):
    """Resolve a symbol name, \"0x\" address string or int ea to an int ea."""
    program = _program()
    if isinstance(t, bool):
        raise TypeError(f"invalid target: {t!r}")
    if isinstance(t, int):
        ea = t
    elif isinstance(t, str):
        s = t.strip()
        if s[:2].lower() != "0x":
            table = program.getSymbolTable()
            for name in (s, "_" + s):
                for symbol in table.getGlobalSymbols(name):
                    return int(symbol.getAddress().getOffset())
            raise LookupError(f"unknown symbol or address: {s}")
        try:
            ea = int(s, 16)
        except ValueError:
            raise LookupError(f"unknown symbol or address: {s}") from None
    else:
        raise TypeError(f"invalid target: {t!r}")
    if not program.getMemory().contains(_address(ea)):
        raise LookupError(f"unknown symbol or address: {_hex(ea)}")
    return ea


def func(t):
    """The Ghidra function containing the target."""
    ea = resolve(t)
    f = _program().getFunctionManager().getFunctionContaining(_address(ea))
    if f is None:
        raise LookupError(f"no function at 0x{ea:x}")
    return f


def name_of(ea):
    """Name at int ea, or its hex address when unnamed."""
    symbol = _program().getSymbolTable().getPrimarySymbol(_address(ea))
    return str(symbol.getName()) if symbol is not None else _hex(ea)


def _func_name(address):
    f = _program().getFunctionManager().getFunctionContaining(address)
    return str(f.getName()) if f is not None else None


def _asm_lines(f):
    return [
        f"0x{int(ins.getAddress().getOffset()):x}  {ins}"
        for ins in _iter(_program().getListing().getInstructions(f.getBody(), True))
    ]


def asm(t):
    """Disassembly of the function containing the target."""
    return _text(_asm_lines(func(t)))


def pseudocode(t):
    """Ghidra pseudocode of the function; falls back to disassembly."""
    global DECOMP
    f = func(t)
    start = int(f.getEntryPoint().getOffset())
    end = int(f.getBody().getMaxAddress().getOffset()) + 1
    header = f"// {f.getName()} @ 0x{start:x}-0x{end:x}"
    try:
        if DECOMP is None:
            decomp = DecompInterface()
            try:
                if not decomp.openProgram(_program()):
                    message = str(decomp.getLastMessage())
                    decomp.dispose()
                    return _text([header, f"// decompiler unavailable: {message}; showing disassembly", *_asm_lines(f)])
            except BaseException:
                decomp.dispose()
                raise
            DECOMP = decomp
        result = DECOMP.decompileFunction(f, 60, MONITOR)
        if not result.decompileCompleted():
            return _text([
                header,
                f"// decompilation failed: {result.getErrorMessage()}; showing disassembly",
                *_asm_lines(f),
            ])
        return _text([header, *str(result.getDecompiledFunction().getC()).splitlines()])
    except Exception as e:
        return _text([header, f"// decompiler unavailable: {e}; showing disassembly", *_asm_lines(f)])


def _xrefs_to(ea):
    return (
        ref for ref in _iter(_program().getReferenceManager().getReferencesTo(_address(ea)))
        if ref.getReferenceType() != RefType.FALL_THROUGH
    )


def _xrefs_from(t):
    ea = resolve(t)
    program = _program()
    address = _address(ea)
    f = program.getFunctionManager().getFunctionAt(address)
    sources = (
        (ins.getAddress() for ins in _iter(program.getListing().getInstructions(f.getBody(), True)))
        if f is not None else (address,)
    )
    for source in sources:
        for ref in program.getReferenceManager().getReferencesFrom(source):
            if ref.getReferenceType() != RefType.FALL_THROUGH:
                yield ref


def xrefs_to(t):
    """Cross-references to the target: [{\"from\", \"type\", \"func\"}]."""
    return [
        {"from": int(ref.getFromAddress().getOffset()), "type": str(ref.getReferenceType()),
         "func": _func_name(ref.getFromAddress())}
        for ref in _xrefs_to(resolve(t))
    ]


def xrefs_from(t):
    """Cross-references from the target (whole body for a function start): [{\"to\", \"type\", \"func\"}]."""
    return [
        {"to": int(ref.getToAddress().getOffset()), "type": str(ref.getReferenceType()),
         "func": _func_name(ref.getToAddress())}
        for ref in _xrefs_from(t)
    ]


def _unique(names):
    return list(dict.fromkeys(name for name in names if name))


def callers(t):
    """Unique names of functions calling or jumping to the target."""
    return _unique(
        _func_name(ref.getFromAddress()) for ref in _xrefs_to(resolve(t))
        if ref.getReferenceType().isCall() or ref.getReferenceType().isJump()
    )


def callees(t):
    """Unique names of functions called from the function body."""
    return _unique(str(f.getName()) for f in func(t).getCalledFunctions(MONITOR))


def _funcs():
    return _iter(_program().getFunctionManager().getFunctions(True))


def functions(pattern=None):
    """[(ea, name)] of all functions, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for f in _funcs():
        name = str(f.getName())
        if rx is None or rx.search(name):
            out.append((int(f.getEntryPoint().getOffset()), name))
    return out


def strings(pattern=None):
    """[(ea, text)] of all defined strings, optionally filtered by case-insensitive regex."""
    rx = _regex(pattern)
    out = []
    for data in _iter(DefinedStringIterator.forProgram(_program())):
        value = StringDataInstance.getStringDataInstance(data).getStringValue()
        if value is None:
            continue
        text = str(value)
        if rx is None or rx.search(text):
            out.append((int(data.getAddress().getOffset()), text))
    return out


def imports(pattern=None):
    """[(ea or None, library, name)] of all imports, regex-filtered on \"library!name\"."""
    rx = _regex(pattern)
    out = []
    program = _program()
    manager = program.getExternalManager()
    refs = program.getReferenceManager()
    for library in manager.getExternalLibraryNames():
        for location in _iter(manager.getExternalLocations(library)):
            name = str(location.getLabel())
            lib = str(library)
            if rx is not None and not rx.search(f"{lib}!{name}"):
                continue
            ea = None
            for ref in _iter(refs.getReferencesTo(location.getExternalSpaceAddress())):
                ea = int(ref.getFromAddress().getOffset())
                break
            out.append((ea, lib, name))
    return out


def read_bytes(t, size):
    """Raw bytes at the target."""
    return bytes(b & 0xFF for b in FLAT.getBytes(_address(resolve(t)), int(size)))


def hexdump(t, size=64):
    """Classic 16-bytes-per-line hex dump at the target."""
    ea = resolve(t)
    data = read_bytes(ea, size)
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off:off + 16]
        hexpart = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"0x{ea + off:x}  {hexpart:<47}  |{ascii_part}|")
    return _text(lines)


def rename(t, name):
    """Rename the target; returns {\"ea\", \"old\", \"new\"}."""
    ea = resolve(t)
    program = _program()
    address = _address(ea)
    table = program.getSymbolTable()
    symbol = table.getPrimarySymbol(address)
    old = str(symbol.getName()) if symbol is not None else ""
    with pyghidra.transaction(program, "omp rename"):
        f = program.getFunctionManager().getFunctionAt(address)
        if f is not None:
            f.setName(name, SourceType.USER_DEFINED)
        elif symbol is not None:
            symbol.setName(name, SourceType.USER_DEFINED)
        else:
            table.createLabel(address, name, SourceType.USER_DEFINED)
    return {"ea": _hex(ea), "old": old, "new": name_of(ea)}


def comment(t, text, repeatable=False):
    """Set an address comment, and the function comment at a function start."""
    ea = resolve(t)
    program = _program()
    address = _address(ea)
    with pyghidra.transaction(program, "omp comment"):
        kind = CommentType.REPEATABLE if repeatable else CommentType.EOL
        program.getListing().setComment(address, kind, text)
        f = program.getFunctionManager().getFunctionAt(address)
        if f is not None:
            if repeatable:
                f.setRepeatableComment(text)
            else:
                f.setComment(text)
    return {"ea": _hex(ea)}


def set_type(t, decl):
    """Apply a C function prototype at an entry point, or a data type expression elsewhere."""
    ea = resolve(t)
    program = _program()
    address = _address(ea)
    dtm = program.getDataTypeManager()
    declaration = decl.rstrip("; ")
    with pyghidra.transaction(program, "omp set_type"):
        f = program.getFunctionManager().getFunctionAt(address)
        if f is not None:
            signature = FunctionSignatureParser(dtm, None).parse(f.getSignature(), declaration)
            cmd = ApplyFunctionSignatureCmd(address, signature, SourceType.USER_DEFINED)
            if not cmd.applyTo(program):
                raise ValueError(str(cmd.getStatusMsg()))
            applied = str(f.getSignature())
        else:
            data_type = DataTypeParser(dtm, dtm, None, AllowedDataTypes.FIXED_LENGTH).parse(declaration)
            DataUtilities.createData(program, address, data_type, -1, ClearDataMode.CLEAR_ALL_CONFLICT_DATA)
            applied = str(data_type.getDisplayName())
    return {"ea": _hex(ea), "type": applied}


def make_function(t):
    """Disassemble and create a function at the target; returns {\"ea\", \"name\"}."""
    ea = resolve(t)
    program = _program()
    address = _address(ea)
    with pyghidra.transaction(program, "omp make_function"):
        if program.getListing().getInstructionAt(address) is None:
            cmd = DisassembleCommand(address, None, True)
            if not cmd.applyTo(program):
                raise ValueError(str(cmd.getStatusMsg()))
        cmd = CreateFunctionCmd(address)
        if not cmd.applyTo(program):
            raise ValueError(str(cmd.getStatusMsg()))
        AutoAnalysisManager.getAnalysisManager(program).startAnalysis(MONITOR, False)
    return {"ea": _hex(ea), "name": str(func(ea).getName())}


def help_ghidra():
    """One line per preloaded helper and the available program objects."""
    return "\n".join([
        "program/currentProgram: Ghidra Program; project, flat, monitor, pyghidra, jpype",
        *(f"{h.__name__}{_signature(h)}: {h.__doc__}" for h in _HELPERS),
    ])


def _signature(fn):
    code = fn.__code__
    names = code.co_varnames[:code.co_argcount]
    defaults = fn.__defaults__ or ()
    first_default = len(names) - len(defaults)
    parts = [n if i < first_default else f"{n}={defaults[i - first_default]!r}" for i, n in enumerate(names)]
    return f"({', '.join(parts)})"


_HELPERS = (
    resolve, func, pseudocode, asm, xrefs_to, xrefs_from, callers, callees,
    functions, strings, imports, name_of, hexdump, read_bytes, rename, comment,
    set_type, make_function, help_ghidra,
)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _entries():
    return _iter(_program().getSymbolTable().getExternalEntryPointIterator())


def _view_overview():
    program = _program()
    blocks = list(program.getMemory().getBlocks())
    entries = list(_entries())
    funcs = list(_funcs())
    base = int(program.getImageBase().getOffset())
    entry = int(entries[0].getOffset()) if entries else base
    lines = [
        f"{program.getName()} — {program.getExecutableFormat()}, {program.getLanguage().getProcessor()} {program.getDefaultPointerSize() * 8}-bit",
        f"base 0x{base:x} entry 0x{entry:x} range 0x{int(program.getMinAddress().getOffset()):x}-0x{int(program.getMaxAddress().getOffset()) + 1:x}",
        f"md5 {program.getExecutableMD5()} sha256 {program.getExecutableSHA256()}",
        f"segments ({len(blocks)}):",
    ]
    for block in blocks:
        perm = "".join(c if enabled else "-" for c, enabled in (
            ("r", block.isRead()), ("w", block.isWrite()), ("x", block.isExecute()),
        ))
        lines.append(f"  {block.getName()} 0x{int(block.getStart().getOffset()):x}-0x{int(block.getEnd().getOffset()) + 1:x} {perm} ")
    lines.append(f"entry points ({len(entries)}):")
    for address in entries[:_OVERVIEW_ENTRY_LIMIT]:
        ea = int(address.getOffset())
        lines.append(f"  0x{ea:x} {name_of(ea)}")
    if len(entries) > _OVERVIEW_ENTRY_LIMIT:
        lines.append(f"  … {len(entries) - _OVERVIEW_ENTRY_LIMIT} more (:exports)")
    lines.append(f"counts: {len(funcs)} functions, {len(imports())} imports, {len(entries)} exports, {len(strings())} strings")
    lines.append(f"functions ({len(funcs)}):")
    for f in funcs:
        lines.append(f"  0x{int(f.getEntryPoint().getOffset()):x}  {int(f.getBody().getNumAddresses()):>6}  {f.getName()}")
    return _text(lines)


def _view_imports():
    return _text(f"{_hex(ea) if ea is not None else '-'}  {lib}!{name}" for ea, lib, name in imports())


def _view_exports():
    return _text(f"0x{int(address.getOffset()):x}  {name_of(int(address.getOffset()))}" for address in _entries())


def _view_strings():
    return _text(f"0x{ea:x}  {json.dumps(s, ensure_ascii=False)}" for ea, s in strings())


def _view_xrefs(target):
    ea = resolve(target)
    refs = xrefs_to(ea)
    lines = [f"xrefs to {name_of(ea)} (0x{ea:x}): {len(refs)}"]
    for ref in refs:
        lines.append(f"0x{ref['from']:x}  {ref['type']}  in {ref['func'] or '-'}")
    return _text(lines)


_TARGET_VIEWS = {"pseudocode": pseudocode, "asm": asm, "xrefs": _view_xrefs}
_PLAIN_VIEWS = {
    "overview": _view_overview,
    "imports": _view_imports,
    "exports": _view_exports,
    "strings": _view_strings,
}


# ---------------------------------------------------------------------------
# RPC methods
# ---------------------------------------------------------------------------


def _has_objc_metadata(program):
    return any(str(block.getName()).startswith("__objc_") for block in program.getMemory().getBlocks())


def _seed_objc_types(program):
    """Cache-extracted images may lack the typedefs required by the message analyzer."""
    Objc2Constants = jpype.JClass("ghidra.app.util.bin.format.objc.objc2.Objc2Constants")
    PointerDataType = jpype.JClass("ghidra.program.model.data.PointerDataType")
    TypedefDataType = jpype.JClass("ghidra.program.model.data.TypedefDataType")
    VoidDataType = jpype.JClass("ghidra.program.model.data.VoidDataType")
    CharDataType = jpype.JClass("ghidra.program.model.data.CharDataType")
    DataTypeConflictHandler = jpype.JClass("ghidra.program.model.data.DataTypeConflictHandler")
    types = program.getDataTypeManager()
    category = Objc2Constants.CATEGORY_PATH
    added = False
    with pyghidra.transaction(program, "omp: Objective-C types"):
        for name, base in (("ID", VoidDataType.dataType), ("SEL", CharDataType.dataType)):
            if types.getDataType(category, name) is None:
                pointer = PointerDataType(base, program.getDefaultPointerSize())
                types.addDataType(TypedefDataType(category, name, pointer), DataTypeConflictHandler.DEFAULT_HANDLER)
                added = True
    return added


def _repair_objc_retain(program):
    """The arm64 retain fixups incorrectly preserve x0 instead of returning xN."""
    output = program.getRegister("x0")
    if output is None:
        return
    PointerDataType = jpype.JClass("ghidra.program.model.data.PointerDataType")
    VoidDataType = jpype.JClass("ghidra.program.model.data.VoidDataType")
    ParameterImpl = jpype.JClass("ghidra.program.model.listing.ParameterImpl")
    ReturnParameterImpl = jpype.JClass("ghidra.program.model.listing.ReturnParameterImpl")
    VariableStorage = jpype.JClass("ghidra.program.model.listing.VariableStorage")
    FunctionUpdateType = jpype.JClass("ghidra.program.model.listing.Function$FunctionUpdateType")
    List = jpype.JClass("java.util.List")
    pointer = PointerDataType(VoidDataType.dataType, program.getDefaultPointerSize())
    with pyghidra.transaction(program, "omp: Objective-C retain registers"):
        for function in _iter(program.getFunctionManager().getFunctions(True)):
            match = re.fullmatch(r"_objc_retain_x([0-9]+)", str(function.getName()))
            if (match is None or function.getCallFixup() is None or
                    function.getSignatureSource() == SourceType.USER_DEFINED):
                continue
            input_register = program.getRegister("x" + match.group(1))
            if input_register is None:
                continue
            function.setCallFixup(None)
            parameter = ParameterImpl("object", pointer, VariableStorage(program, input_register), program)
            result = ReturnParameterImpl(pointer, VariableStorage(program, output), program)
            function.updateFunction("default", result, List.of(parameter),
                                    FunctionUpdateType.CUSTOM_STORAGE, True, SourceType.ANALYSIS)


def _rpc_open(params):
    global PROJECT, PROGRAM, CONSUMER, FLAT, _DATABASE_PATH
    if PROJECT is not None:
        raise RuntimeError("a project is already open in this worker")
    launcher = HeadlessPyGhidraLauncher(install_dir=Path(os.environ["GHIDRA_INSTALL_DIR"]))
    launcher.add_vmargs("-Xrs")
    launcher.start()
    _init_java()
    binary = os.path.abspath(params["binary"])
    directory = os.path.dirname(binary)
    project_directory = params["project"]
    name = os.path.basename(binary)
    # The omp daemon already holds its OS database lock, so only stale project locks
    # can remain here (e.g. after a worker crash).
    lock_path = str(ProjectLocator(project_directory, "omp").getProjectLockFile())
    for stale in (lock_path, lock_path + "~"):
        try:
            os.unlink(stale)
        except FileNotFoundError:
            pass
    PROJECT = pyghidra.open_project(project_directory, "omp", create=True)
    if PROJECT.getProjectData().getFile("/" + name) is None:
        with pyghidra.program_loader().project(PROJECT).source(binary).projectFolderPath("/").name(name).load() as results:
            results.save(MONITOR)
    PROGRAM, CONSUMER = pyghidra.consume_program(PROJECT, "/" + name)
    _DATABASE_PATH = os.path.join(directory, "omp.gpr")
    with pyghidra.transaction(PROGRAM, "omp: analysis"):
        macho = str(PROGRAM.getExecutableFormat()) == "Mac OS X Mach-O"
        seeded = _seed_objc_types(PROGRAM) if macho and _has_objc_metadata(PROGRAM) else False
        # Revisit old databases whose message analyzer skipped the missing types.
        if not GhidraProgramUtilities.isAnalyzed(PROGRAM) or seeded:
            pyghidra.analyze(PROGRAM, MONITOR)
            # PyGhidra cancels the supplied monitor on successful analysis completion.
            MONITOR.clearCancelled()
        if macho:
            _repair_objc_retain(PROGRAM)
    if PROGRAM.isChanged():
        PROGRAM.save("omp: analysis", MONITOR)
    FLAT = FlatProgramAPI(PROGRAM)
    NS.clear()
    NS.update({
        "__name__": "__ghidra_exec__", "__builtins__": __builtins__,
        "program": PROGRAM, "currentProgram": PROGRAM, "project": PROJECT,
        "flat": FLAT, "monitor": MONITOR, "pyghidra": pyghidra, "jpype": jpype,
    })
    NS.update({h.__name__: h for h in _HELPERS})
    return _open_info()


def _open_info():
    return {
        "idb": _DATABASE_PATH,
        "module": str(PROGRAM.getName()),
        "format": str(PROGRAM.getExecutableFormat()),
        "arch": str(PROGRAM.getLanguage().getProcessor()),
        "bitness": PROGRAM.getDefaultPointerSize() * 8,
    }


def _rpc_status(params):
    # Queued behind any running request, so a reconnecting daemon sees the finished open.
    if PROGRAM is None:
        return {"open": False}
    return {"open": True, **_open_info()}


def _rpc_view(params):
    _program()
    kind = params.get("kind") or "overview"
    if kind in _PLAIN_VIEWS:
        return {"text": _PLAIN_VIEWS[kind]()}
    if kind in _TARGET_VIEWS:
        target = params.get("target")
        if target is None or (isinstance(target, str) and not target.strip()):
            raise ValueError(f"view {kind} needs a target")
        return {"text": _TARGET_VIEWS[kind](target)}
    raise ValueError(f"unknown view: {kind}")


def _rpc_exec(params):
    program = _program()
    code = params.get("code") or ""
    buf = io.StringIO()
    value = None
    error = None
    tid = None
    try:
        tid = program.startTransaction("omp exec")
        tree = ast.parse(code, _EXEC_FILE, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with redirect_stdout(buf), redirect_stderr(buf):
            if tree.body:
                exec(compile(tree, _EXEC_FILE, "exec"), NS)
            if last is not None:
                result = eval(compile(last, _EXEC_FILE, "eval"), NS)
                if result is not None:
                    value = repr(result)
    except KeyboardInterrupt:
        error = "KeyboardInterrupt: interrupted (timeout or cancel)"
    except BaseException:
        error = traceback.format_exc()
    finally:
        if tid is not None:
            program.endTransaction(tid, error is None)
    return {"output": buf.getvalue(), "value": value, "error": error}


def _rpc_rename(params):
    return rename(params["target"], params["name"])


def _rpc_comment(params):
    return comment(params["target"], params["text"], params.get("repeatable", False))


def _rpc_set_type(params):
    return set_type(params["target"], params["decl"])


def _rpc_make_function(params):
    return make_function(params["target"])


def _rpc_save(params):
    _program().save("omp", MONITOR)
    return {"idb": _DATABASE_PATH}


_METHODS = {
    "open": _rpc_open,
    "view": _rpc_view,
    "exec": _rpc_exec,
    "rename": _rpc_rename,
    "comment": _rpc_comment,
    "set_type": _rpc_set_type,
    "make_function": _rpc_make_function,
    "save": _rpc_save,
    "status": _rpc_status,
}


# ---------------------------------------------------------------------------
# Protocol loop
# ---------------------------------------------------------------------------


def _error(e):
    message = "interrupted" if isinstance(e, KeyboardInterrupt) else str(e) or type(e).__name__
    return {"type": type(e).__name__, "message": message}


def _send(frame):
    data = (json.dumps(frame, ensure_ascii=False, default=str) + "\n").encode("utf-8")
    with _conn_lock:
        conn = _conn
        if conn is None:
            # The daemon is gone; after it reconnects it asks `status` instead.
            return
        if _WINDOWS:
            _sendall(conn, data)
            return
        # Defer SIGINT while writing so a late interrupt cannot truncate a frame.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
        try:
            _sendall(conn, data)
        finally:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})


def _sendall(conn, data):
    try:
        conn.sendall(data)
    except OSError:
        traceback.print_exc()


_WINDOWS = sys.platform == "win32"
_INTERRUPT_ABSORB_S = 0.5
# How long the worker keeps its program open with no daemon connected before it saves and exits.
_ORPHAN_S = 600.0
_requests = queue.Queue()
_running_lock = threading.Lock()
_running_id = None
_interrupt_pending = False
_conn_lock = threading.Lock()
_conn = None
_disconnected_at = time.monotonic()


def _accept_connections():
    """Serve one daemon connection at a time; a new connection replaces the previous one."""
    while True:
        try:
            conn, _ = _listener.accept()
        except OSError:
            traceback.print_exc()
            return
        threading.Thread(target=_read_requests, args=(conn,), name="omp-ghidra-conn", daemon=True).start()


def _read_requests(conn):
    global _interrupt_pending, _conn, _disconnected_at
    authenticated = False
    try:
        for line in conn.makefile("r", encoding="utf-8", newline="\n"):
            try:
                frame = json.loads(line)
            except ValueError:
                frame = None
            if not authenticated:
                if not isinstance(frame, dict) or frame.get("token") != _TOKEN:
                    break
                authenticated = True
                with _conn_lock:
                    previous, _conn = _conn, conn
                if previous is not None:
                    try:
                        previous.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                continue
            if isinstance(frame, dict) and "interrupt" in frame:
                with _running_lock:
                    if not _interrupt_pending and _running_id is not None and _running_id == frame["interrupt"]:
                        _interrupt_pending = True
                        try:
                            if MONITOR is not None:
                                MONITOR.cancel()
                        except Exception:
                            traceback.print_exc()
                        finally:
                            _thread.interrupt_main()
                continue
            _requests.put(line)
    except OSError:
        pass
    with _conn_lock:
        if _conn is conn:
            _conn = None
            _disconnected_at = time.monotonic()
    conn.close()


def _run(req_id, handler, params):
    """Run a request and absorb any scheduled interrupt before writing its response."""
    global _running_id, _interrupt_pending
    ok, value, started, finished, delivered = False, None, False, False, False
    while True:
        try:
            if not started:
                started = True
                if MONITOR is not None:
                    MONITOR.clearCancelled()
                with _running_lock:
                    _running_id = req_id
            if not finished:
                finished = True
                try:
                    value, ok = handler(params), True
                except (KeyboardInterrupt, SystemExit):
                    raise
                except Exception as e:
                    value = e
            with _running_lock:
                _running_id = None
                pending = _interrupt_pending and not delivered
                _interrupt_pending = False
            deadline = time.monotonic() + _INTERRUPT_ABSORB_S if pending else 0
            while time.monotonic() < deadline:
                pass
            return ok, value
        except KeyboardInterrupt as e:
            delivered = True
            if not ok:
                value = e


def _close(save):
    global PROJECT, PROGRAM, CONSUMER, FLAT, DECOMP
    try:
        try:
            if PROGRAM is not None and save and PROGRAM.isChanged():
                PROGRAM.save("omp", MONITOR)
        finally:
            try:
                if PROGRAM is not None:
                    PROGRAM.release(CONSUMER)
            finally:
                try:
                    if DECOMP is not None:
                        DECOMP.dispose()
                finally:
                    if PROJECT is not None:
                        PROJECT.close()
    finally:
        PROJECT = PROGRAM = CONSUMER = FLAT = DECOMP = None
        NS.clear()


def _close_and_exit(save):
    code = 0
    try:
        if MONITOR is not None:
            MONITOR.clearCancelled()
        _close(save)
    except Exception:
        traceback.print_exc()
        code = 1
    sys.exit(code)


def _handle(line):
    req_id = None
    try:
        req = json.loads(line)
        if not isinstance(req, dict):
            raise ValueError("request must be a JSON object")
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        if method == "close":
            save = bool(params.get("save"))
            try:
                if MONITOR is not None:
                    MONITOR.clearCancelled()
                _close(save)
            except Exception as e:
                _send({"id": req_id, "ok": False, "error": _error(e)})
                traceback.print_exc()
                sys.exit(1)
            _send({"id": req_id, "ok": True, "result": {"closed": True, "saved": save}, "dirty": False})
            sys.exit(0)
        handler = _METHODS.get(method)
        if handler is None:
            raise ValueError(f"unknown method: {method}")
    except SystemExit:
        raise
    except BaseException as e:
        _send({"id": req_id, "ok": False, "error": _error(e)})
        return
    ok, result = _run(req_id, handler, params)
    if ok:
        _send({"id": req_id, "ok": True, "result": result,
               "dirty": bool(PROGRAM.isChanged()) if PROGRAM is not None else False})
    else:
        _send({"id": req_id, "ok": False, "error": _error(result)})


def main():
    # Ghidra uses monitor cancellation plus a frame-triggered Python interrupt on
    # every platform: POSIX signals alone cannot cancel JVM analysis/decompilation.
    threading.Thread(target=_accept_connections, name="omp-ghidra-accept", daemon=True).start()
    while not _terminate:
        try:
            try:
                line = _requests.get(timeout=1)
            except queue.Empty:
                with _conn_lock:
                    orphaned = _conn is None and time.monotonic() - _disconnected_at > _ORPHAN_S
                if orphaned:
                    break
                continue
            if line.strip():
                _handle(line)
        except KeyboardInterrupt:
            continue
    _close_and_exit(True)


if __name__ == "__main__":
    main()
