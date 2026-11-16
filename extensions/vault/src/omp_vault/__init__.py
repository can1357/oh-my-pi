"""Vault graph queries over the host ``vault://`` resolver."""

from __future__ import annotations

from .query import VaultQuery, build_vault_url

__all__ = ["VaultQuery", "build_vault_url"]
