"""Host device for ``omp.vault`` (needs frozen omp at import)."""

from __future__ import annotations

from dataclasses import dataclass

import omp

from .query import VaultQuery, build_vault_url


@dataclass(frozen=True, slots=True)
class VaultArgs:
	"""Describe one native vault graph read."""

	vault: str
	op: str
	path: str = ""
	heading: str = ""
	tag: str = ""


@dataclass(frozen=True, slots=True)
class VaultResult(omp.Payload):
	"""Carry the host JSON document for one vault graph read."""

	url: str
	document: str


@dataclass(frozen=True, slots=True)
class VaultFault(omp.Fault):
	"""Report a vault query the host refused or could not build."""

	detail: str


@omp.device(
	"vault_query",
	family="vault",
	rev=1,
	summary="Read note metadata, one section, backlinks, tags, or the link map.",
	tier=omp.Tier.READ,
)
async def vault_query(args: VaultArgs, ctx: omp.Context) -> VaultResult | VaultFault:
	"""Read one ``vault://`` graph query through the environment host."""

	del ctx
	try:
		url = build_vault_url(
			VaultQuery(args.vault, args.op, args.path, args.heading, args.tag)
		)
	except ValueError as error:
		return VaultFault(str(error))
	try:
		document = await omp.urls.read(url)
	except (omp.UrlError, omp.HostDisconnected) as error:
		return VaultFault(str(error))
	if not isinstance(document, str):
		return VaultFault("vault host returned a non-text result")
	return VaultResult(url, document)
