"""Build ``vault://`` graph URLs. The host owns the scan."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote, urlencode

_OPS = frozenset({"info", "section", "backlinks", "tag", "map"})
_NOTE_OPS = frozenset({"info", "section", "backlinks", "map"})


@dataclass(frozen=True, slots=True)
class VaultQuery:
	"""Name one native vault graph read."""

	vault: str
	op: str
	path: str = ""
	heading: str = ""
	tag: str = ""


def build_vault_url(query: VaultQuery) -> str:
	"""Return the ``vault://`` URL the environment host resolves."""

	vault = query.vault.strip()
	op = query.op.strip()
	path = query.path.strip().strip("/")
	if not vault or any(char in vault for char in "/\\:?#"):
		raise ValueError("vault name is empty or contains a reserved character")
	if op not in _OPS:
		raise ValueError(f"unknown vault query {op!r}")
	if op in _NOTE_OPS and not path.endswith(".md"):
		raise ValueError(f"vault query {op!r} requires a .md note path")
	if op == "section" and not query.heading.strip():
		raise ValueError("section query requires a heading")
	if op == "tag" and not query.tag.strip():
		raise ValueError("tag query requires a tag")
	params: dict[str, str] = {"op": op}
	if op == "section":
		params["heading"] = query.heading.strip()
	if op == "tag":
		params["tag"] = query.tag.strip()
	encoded_path = quote(path, safe="/")
	prefix = f"vault://{quote(vault, safe='')}{('/' + encoded_path) if encoded_path else ''}"
	return f"{prefix}?{urlencode(params)}"
