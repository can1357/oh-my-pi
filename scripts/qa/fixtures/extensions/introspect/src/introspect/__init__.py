import importlib
import json

import omp

from ._qa_params import PARAMS


@omp.tool(kind="hard")
async def hello(name: str = "world") -> str:
	report = {}
	for symbol in PARAMS["symbols"]:
		module, _, attr = symbol.rpartition(".")
		try:
			owner = importlib.import_module(module)
		except ImportError:
			report[symbol] = "missing-module"
			continue
		report[symbol] = "ok" if hasattr(owner, attr) else "missing-attr"
	return json.dumps(report)
