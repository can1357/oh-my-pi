#!/usr/bin/env python3
"""OMP-owned JSON-RPC bridge for the user-installed Mnemosyne 4.x SDK.

The bridge intentionally keeps all SDK imports and synchronous calls in this
process.  Only ``emit`` writes protocol records to the original stdout; SDK
logging and tracebacks are redirected to stderr.
"""

import importlib.metadata
import json
import os
import sys
import traceback
from pathlib import Path

PROTOCOL_VERSION = 1
REQUIRED_METHODS = {
    "initialize", "capabilities", "status", "remember", "recall", "get",
    "update", "forget", "invalidate", "stats", "sleep", "clear", "shutdown",
}

_protocol_stdout = sys.stdout
sys.stdout = sys.stderr


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


def emit(payload):
    _protocol_stdout.write(json.dumps(payload, separators=(",", ":"), default=str) + "\n")
    _protocol_stdout.flush()


def as_dict(value):
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if hasattr(value, "__dict__"):
        return vars(value)
    return {"content": str(value)}


def call_sdk(method, *args, **kwargs):
    """Call an SDK method and turn unsupported signatures into useful errors."""
    try:
        return method(*args, **kwargs)
    except TypeError as error:
        raise RpcError(-32000, f"Mnemosyne SDK method does not support the requested arguments: {error}") from error


class MnemosyneWorker:
    def __init__(self):
        self.context = None
        self.manager = None
        self.memories = {}
        self.sdk_version = None
        self.python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        self.Mnemosyne = None

    def initialize(self, params):
        context = params.get("context") if isinstance(params, dict) else None
        self._validate_context(context)
        if self.context is not None:
            if context != self.context:
                raise RpcError(-32010, "immutable initialization context mismatch")
            return {"protocol": PROTOCOL_VERSION}
        if sys.version_info < (3, 10):
            raise RpcError(-32000, f"Mnemosyne OSS requires Python 3.10+, found {self.python_version}")
        try:
            # The parent process points MNEMOSYNE_DATA_DIR at a fresh temporary
            # runtime-config directory.  Never point it at the shared store.
            runtime_config = Path(os.environ["MNEMOSYNE_DATA_DIR"])
            runtime_config.mkdir(parents=True, exist_ok=True)
            import mnemosyne
            from mnemosyne.core.banks import BankManager
            from mnemosyne.core.memory import Mnemosyne
        except KeyError as error:
            raise RpcError(-32000, "MNEMOSYNE_DATA_DIR was not configured for the private worker runtime") from error
        except Exception as error:
            raise RpcError(-32000, f"Cannot import mnemosyne-memory 4.x: {error}") from error
        try:
            version = importlib.metadata.version("mnemosyne-memory")
        except importlib.metadata.PackageNotFoundError:
            version = getattr(mnemosyne, "__version__", "unknown")
        if not str(version).startswith("4."):
            raise RpcError(-32000, f"Mnemosyne OSS requires SDK major 4, found {version}")
        try:
            manager = BankManager(Path(context["store_data_dir"]))
        except Exception as error:
            raise RpcError(-32000, f"Cannot open Mnemosyne store data directory: {error}") from error
        self.context = dict(context)
        self.context["recall_banks"] = list(context["recall_banks"])
        self.context["shared_banks"] = list(context["shared_banks"])
        self.sdk_version = str(version)
        self.manager = manager
        self.Mnemosyne = Mnemosyne
        return {"protocol": PROTOCOL_VERSION}

    @staticmethod
    def _validate_context(context):
        if not isinstance(context, dict):
            raise RpcError(-32602, "initialize requires an immutable context")
        required = {
            "session_id", "cwd", "store_data_dir", "retain_bank", "recall_banks",
            "shared_banks", "ownership", "author_id", "author_type", "channel_id",
            "embedding_mode", "consolidation_mode", "auto_migrate",
        }
        missing = sorted(required - set(context))
        if missing:
            raise RpcError(-32602, f"initialize context is missing: {', '.join(missing)}")
        for key in ("session_id", "cwd", "store_data_dir", "retain_bank", "author_id", "author_type", "channel_id"):
            if not isinstance(context[key], str) or not context[key]:
                raise RpcError(-32602, f"initialize context field {key} must be a non-empty string")
        if context["author_id"] != "omp" or context["author_type"] != "agent":
            raise RpcError(-32602, "initialize context author must be omp/agent")
        if context["ownership"] not in ("shared", "omp"):
            raise RpcError(-32602, "initialize context ownership must be shared or omp")
        if context["embedding_mode"] not in ("local", "lexical"):
            raise RpcError(-32602, "initialize context embedding_mode must be local or lexical")
        if context["consolidation_mode"] not in ("local", "heuristic"):
            raise RpcError(-32602, "initialize context consolidation_mode must be local or heuristic")
        if not isinstance(context["auto_migrate"], bool):
            raise RpcError(-32602, "initialize context auto_migrate must be boolean")
        banks = context["recall_banks"]
        shared = context["shared_banks"]
        if not isinstance(banks, list) or not banks or any(not isinstance(bank, str) for bank in banks):
            raise RpcError(-32602, "initialize context recall_banks must be a non-empty list")
        if not isinstance(shared, list) or any(not isinstance(bank, str) for bank in shared):
            raise RpcError(-32602, "initialize context shared_banks must be a list")
        all_banks = set(banks) | {context["retain_bank"]} | set(shared)
        for bank in all_banks:
            if not bank or bank in (".", "..") or Path(bank).name != bank:
                raise RpcError(-32602, f"initialize context contains an invalid bank name: {bank!r}")

    def capabilities(self):
        return {
            "protocol": PROTOCOL_VERSION,
            "sdk_version": self.sdk_version,
            "python_version": self.python_version,
            "operations": sorted(REQUIRED_METHODS),
            "embedding_mode": self.context["embedding_mode"],
            "consolidation_mode": self.context["consolidation_mode"],
            "clear_mode": "bank-manager" if self.manager is not None and callable(getattr(self.manager, "delete_bank", None)) else "unsupported",
        }

    def _allowed_bank(self, bank):
        return bank in set(self.context["recall_banks"]) or bank == self.context["retain_bank"]

    def memory(self, bank):
        if not self._allowed_bank(bank):
            raise RpcError(-32010, f"bank {bank} is outside immutable bank scope")
        if bank not in self.memories:
            db_path = self._bank_path(bank)
            try:
                self.memories[bank] = self.Mnemosyne(
                    db_path=db_path,
                    bank=bank,
                    session_id=self.context["session_id"],
                    author_id=self.context["author_id"],
                    author_type=self.context["author_type"],
                    channel_id=self.context["channel_id"],
                )
            except TypeError as error:
                raise RpcError(-32000, f"Mnemosyne SDK constructor is incompatible with 4.x: {error}") from error
            except Exception as error:
                raise RpcError(-32000, f"Cannot open Mnemosyne bank {bank}: {error}") from error
        return self.memories[bank]

    def _bank_path(self, bank):
        data_dir = Path(self.context["store_data_dir"])
        if bank == "default":
            return data_dir / "mnemosyne.db"
        return data_dir / "banks" / bank / "mnemosyne.db"

    def _stats(self, memory):
        stats_method = getattr(memory, "stats", None)
        if not callable(stats_method):
            stats_method = getattr(memory, "get_stats", None)
        if not callable(stats_method):
            raise RpcError(-32000, "Mnemosyne SDK does not expose stats/get_stats")
        return as_dict(call_sdk(stats_method))

    def status(self):
        banks = []
        for bank in self.context["recall_banks"]:
            database = self._bank_path(bank)
            try:
                stats = self._stats(self.memory(bank))
                banks.append({
                    "bank": bank,
                    "database": str(database),
                    "health": "ok",
                    "working_count": stats.get("working_count", stats.get("working_memories")),
                    "episodic_count": stats.get("episodic_count", stats.get("episodic_memories")),
                    "triple_count": stats.get("triple_count", stats.get("triples")),
                })
            except RpcError:
                raise
            except Exception as error:
                banks.append({"bank": bank, "database": str(database), "health": "error", "error": str(error)})
        return {
            "banks": banks,
            "sdk_version": self.sdk_version,
            "python_version": self.python_version,
            "embedding_mode": self.context["embedding_mode"],
            "consolidation_mode": self.context["consolidation_mode"],
        }

    def remember(self, params):
        content = params.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RpcError(-32602, "remember requires non-empty content")
        bank = self.context["retain_bank"]
        memory = self.memory(bank)
        options = params.get("options") if isinstance(params.get("options"), dict) else {}
        result = call_sdk(memory.remember, content, **options)
        result_data = as_dict(result)
        memory_id = result_data.get("id") or result_data.get("memory_id") or (result if isinstance(result, str) else None)
        if not memory_id:
            raise RpcError(-32000, "Mnemosyne did not return a memory id; acknowledged remember is unsafe")
        return {"id": str(memory_id), "bank": bank}

    def _recall(self, memory, query, limit):
        method = getattr(memory, "recall", None)
        if not callable(method):
            raise RpcError(-32000, "Mnemosyne SDK does not expose recall")
        try:
            return call_sdk(method, query, top_k=limit)
        except RpcError as error:
            # 4.x uses top_k. Older point releases used limit; retain a narrow
            # compatibility fallback only for an unsupported-keyword failure.
            if "unexpected keyword" not in str(error).lower() and "top_k" not in str(error).lower():
                raise
            return call_sdk(method, query, limit=limit)

    def recall(self, params):
        query = params.get("query")
        if not isinstance(query, str):
            raise RpcError(-32602, "recall requires query")
        limit = params.get("limit", 8)
        if not isinstance(limit, int) or limit < 1:
            raise RpcError(-32602, "recall limit must be a positive integer")
        items = []
        for bank in self.context["recall_banks"]:
            results = self._recall(self.memory(bank), query, limit)
            if isinstance(results, dict):
                results = results.get("results") or results.get("memories") or []
            for result in results or []:
                data = as_dict(result)
                content = data.get("content") or data.get("text")
                memory_id = data.get("id") or data.get("memory_id")
                if isinstance(content, str) and memory_id is not None:
                    items.append({
                        "id": str(memory_id), "content": content, "source": data.get("source"),
                        "timestamp": data.get("timestamp") or data.get("created_at"),
                        "score": data.get("score"), "bank": bank,
                    })
        return {"items": items}

    def _get_from_memory(self, memory, memory_id):
        getter = getattr(memory, "get", None)
        if not callable(getter):
            getter = getattr(memory, "get_memory", None)
        if not callable(getter):
            raise RpcError(-32000, "Mnemosyne SDK does not expose get/get_memory for exact reads")
        return call_sdk(getter, memory_id)

    def get(self, params):
        memory_id = params.get("id")
        if not isinstance(memory_id, str) or not memory_id:
            raise RpcError(-32602, "get requires id")
        matches = []
        for bank in self.context["recall_banks"]:
            row = self._get_from_memory(self.memory(bank), memory_id)
            if row:
                data = as_dict(row)
                matches.append((bank, data))
        if len(matches) > 1:
            raise RpcError(-32000, f"memory id {memory_id} is ambiguous across recall banks")
        if not matches:
            return {"status": "not_found", "id": memory_id}
        bank, data = matches[0]
        return {
            "status": "found", "record": {
                "id": str(data.get("id") or memory_id), "content": str(data.get("content") or ""),
                "source": data.get("source"), "timestamp": data.get("timestamp") or data.get("created_at"),
                "importance": data.get("importance"), "metadata": data.get("metadata"),
                "bank": bank, "store": data.get("store") or data.get("memory_store"),
                "editable": bool(data.get("editable", True)),
            },
        }

    def mutate(self, operation, params):
        memory_id = params.get("id")
        if not isinstance(memory_id, str) or not memory_id:
            raise RpcError(-32602, f"{operation} requires id")
        found = self.get({"id": memory_id})
        if found.get("status") != "found":
            return {"status": "not_found", "id": memory_id}
        record = found["record"]
        if not record.get("editable"):
            return {"status": "not_editable", "id": memory_id, "bank": record.get("bank"), "store": record.get("store")}
        memory = self.memory(record["bank"])
        method = getattr(memory, operation, None)
        if not callable(method):
            raise RpcError(-32000, f"Mnemosyne SDK does not support {operation}")
        if operation == "update":
            kwargs = {}
            if "content" in params:
                kwargs["content"] = params["content"]
            if "importance" in params:
                kwargs["importance"] = params["importance"]
            if "metadata" in params:
                kwargs["metadata"] = params["metadata"]
            result = call_sdk(method, memory_id, **kwargs)
            status = "updated" if result is not False else "not_found"
        elif operation == "forget":
            result = call_sdk(method, memory_id)
            status = "deleted" if result is not False else "not_found"
        else:
            kwargs = {}
            if "replacement_id" in params:
                kwargs["replacement_id"] = params["replacement_id"]
            result = call_sdk(method, memory_id, **kwargs)
            status = "invalidated" if result is not False else "not_found"
        return {"status": status, "id": memory_id, "bank": record.get("bank"), "store": record.get("store")}

    def sleep(self, params):
        memory = self.memory(self.context["retain_bank"])
        sleeper = getattr(memory, "sleep", None)
        if not callable(sleeper):
            raise RpcError(-32000, "Mnemosyne SDK does not support sleep")
        payload = params if isinstance(params, dict) else {}
        kwargs = {}
        if "dry_run" in payload:
            kwargs["dry_run"] = payload["dry_run"]
        if "force" in payload:
            kwargs["force"] = payload["force"]
        return as_dict(call_sdk(sleeper, **kwargs))

    def clear(self):
        bank = self.context["retain_bank"]
        if self.context["ownership"] != "omp" or bank == "default" or bank in self.context["shared_banks"]:
            raise RpcError(
                -32020,
                "Mnemosyne OSS clear refused: the active bank is shared; configure a non-default bank with mnemosyne-oss.ownership=omp before clearing.",
            )
        delete_bank = getattr(self.manager, "delete_bank", None)
        if not callable(delete_bank):
            raise RpcError(-32021, "Mnemosyne SDK does not support BankManager.delete_bank")
        self.close()
        try:
            call_sdk(delete_bank, bank, force=False)
        except RpcError:
            raise
        except Exception as error:
            raise RpcError(-32000, f"Mnemosyne bank clear failed: {error}") from error
        return {"bank": bank, "deleted": True}

    def close(self):
        for memory in self.memories.values():
            closer = getattr(memory, "close", None)
            if callable(closer):
                try:
                    closer()
                except Exception:
                    traceback.print_exc(file=sys.stderr)
        self.memories = {}

    def dispatch(self, method, params):
        if method == "initialize":
            return self.initialize(params)
        if self.context is None:
            raise RpcError(-32010, "worker must be initialized first")
        if method == "capabilities":
            return self.capabilities()
        if method in ("status", "stats"):
            return self.status()
        if method == "remember":
            return self.remember(params)
        if method == "recall":
            return self.recall(params)
        if method == "get":
            return self.get(params)
        if method == "update":
            return self.mutate("update", params)
        if method == "forget":
            return self.mutate("forget", params)
        if method == "invalidate":
            return self.mutate("invalidate", params)
        if method == "sleep":
            return self.sleep(params)
        if method == "clear":
            return self.clear()
        if method == "shutdown":
            self.close()
            return {"shutdown": True}
        raise RpcError(-32601, f"method not found: {method}")


def main():
    worker = MnemosyneWorker()
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RpcError(-32600, "invalid JSON-RPC request")
            # Cancellation is a notification. Synchronous SDK calls cannot be
            # interrupted here; the supervisor sends it before terminating us.
            if request.get("method") == "$/cancelRequest":
                continue
            request_id = request.get("id")
            if request.get("jsonrpc") != "2.0" or not isinstance(request_id, str):
                raise RpcError(-32600, "invalid JSON-RPC request")
            result = worker.dispatch(request.get("method"), request.get("params") or {})
            emit({"jsonrpc": "2.0", "id": request_id, "result": result})
            if request.get("method") == "shutdown":
                return
        except RpcError as error:
            emit({"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else "", "error": {"code": error.code, "message": str(error), "data": error.data}})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else "", "error": {"code": -32000, "message": str(error)}})


if __name__ == "__main__":
    main()
