"""Stand-in for the `binaryninja` package, for tests of the worker that need no install.

It implements what `src/binja/worker.py` touches to start, open a database, run `exec`, save and
close: nothing is analyzed. A database is a text file that starts with `MARKER`; every save appends
a line, so a test reads the file to see what was saved. The view records its undo calls in
`bv.undo_log` and its analysis updates in `bv.updates`.
"""

MARKER = "omp-binaryninja-stub\n"


class _Names:
    """Stands in for an enum: every member is a distinct string."""

    def __init__(self, kind):
        self._kind = kind

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return f"{self._kind}.{name}"


BranchType = _Names("BranchType")
SectionSemantics = _Names("SectionSemantics")
SymbolBinding = _Names("SymbolBinding")
SymbolType = _Names("SymbolType")
TypeClass = _Names("TypeClass")


class Symbol:
    def __init__(self, kind, address, name):
        self.type = kind
        self.address = address
        self.name = name


class _Arch:
    name = "stub"


class _File:
    def __init__(self, path, has_database):
        self.filename = path
        self.original_filename = path
        self.has_database = has_database
        self.modified = False
        self.analysis_changed = False
        self.closed = False

    def close(self):
        self.closed = True


class BinaryView:
    view_type = "Stub"
    address_size = 8
    arch = _Arch()

    def __init__(self, path, has_database):
        self.file = _File(path, has_database)
        self.undo_log = []
        self.updates = 0
        self._spans = 0
        self._waiting = []

    def update_analysis(self):
        self.updates += 1
        waiting, self._waiting = self._waiting, []
        for callback in waiting:
            callback()

    def create_database(self, path):
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(MARKER)
        return True

    def save_auto_snapshot(self):
        with open(self.file.filename, "a", encoding="utf-8", newline="\n") as f:
            f.write("saved\n")
        self.file.modified = False
        self.file.analysis_changed = False
        return True

    def begin_undo_actions(self):
        self._spans += 1
        self.undo_log.append(("begin", self._spans))
        return self._spans

    def commit_undo_actions(self, span):
        self.undo_log.append(("commit", span))

    def revert_undo_actions(self, span):
        self.undo_log.append(("revert", span))


class AnalysisCompletionEvent:
    """Fires at the view's next `update_analysis()`, as the real one does for an idle view."""

    def __init__(self, view, callback):
        view._waiting.append(callback)


def load(path, update_analysis=True):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            has_database = f.read(len(MARKER)) == MARKER
    except OSError:
        return None
    return BinaryView(path, has_database)
