# `omp.diagnostics`

Use `omp.diagnostics` when your extension needs to branch on deployment diagnostic codes without parsing display text. These enums are wire-stable values and do not contact the host.

```python
from omp.diagnostics import FailureCode

if diagnostic.code == FailureCode.REVOKED:
    print("The selected package has been revoked")
```

## Reference

### `omp.diagnostics.FailureCode`

```python
class FailureCode(StrEnum)
```

Names deployment failures that prevent the requested resolution or load.

| Member | Wire value | Meaning |
|---|---|---|
| `UNSAT` | `"E-UNSAT"` | Dependency requirements cannot be satisfied. [inference] |
| `FROZEN_CONFLICT` | `"E-FROZEN-CONFLICT"` | Resolution conflicts with a frozen selection. [inference] |
| `LOCK_PYTHON` | `"E-LOCK-PYTHON"` | The lock's Python requirement is incompatible. [inference] |
| `REVOKED` | `"E-REVOKED"` | A selected package or build is revoked. [inference] |
| `ABI_EXPORT` | `"E-ABI-EXPORT"` | Required ABI exports are incompatible or unavailable. [inference] |
| `REPLACE_SCOPE` | `"E-REPLACE-SCOPE"` | A replacement is invalid for the requested scope. [inference] |
| `TRUSTED_LOAD` | `"E-TRUSTED-LOAD"` | A trusted load requirement was not met. [inference] |
| `SETTING_SECRET` | `"E-SETTING-SECRET"` | A setting improperly exposes or references a secret. [inference] |

### `omp.diagnostics.WarningCode`

```python
class WarningCode(StrEnum)
```

Names deployment conditions that preserve a usable result but warrant attention.

| Member | Wire value | Meaning |
|---|---|---|
| `YANKED` | `"W-YANKED"` | The selected release is yanked. [inference] |
| `SITE_OVERRIDE` | `"W-SITE-OVERRIDE"` | A site-level override affected selection. [inference] |
| `API_SKEW` | `"W-API-SKEW"` | API versions differ across participating components. [inference] |
| `FOREIGN_ROOT` | `"W-FOREIGN-ROOT"` | Resolution uses a root owned outside the expected environment. [inference] |
| `REPLACE_DENIED` | `"W-REPLACE-DENIED"` | A requested replacement was denied while resolution remained usable. [inference] |
| `POOL_COUNT` | `"W-POOL-COUNT"` | The resolved host-pool count is notable. [inference] |

### `omp.diagnostics.DiagnosticCode`

```python
class DiagnosticCode(StrEnum)
```

Provides one enum for decoding an untyped diagnostic frame. Use `FailureCode` or `WarningCode` when the severity is already known.

| Member | Wire value | Severity |
|---|---|---|
| `UNSAT` | `"E-UNSAT"` | Failure |
| `FROZEN_CONFLICT` | `"E-FROZEN-CONFLICT"` | Failure |
| `LOCK_PYTHON` | `"E-LOCK-PYTHON"` | Failure |
| `REVOKED` | `"E-REVOKED"` | Failure |
| `ABI_EXPORT` | `"E-ABI-EXPORT"` | Failure |
| `REPLACE_SCOPE` | `"E-REPLACE-SCOPE"` | Failure |
| `TRUSTED_LOAD` | `"E-TRUSTED-LOAD"` | Failure |
| `SETTING_SECRET` | `"E-SETTING-SECRET"` | Failure |
| `YANKED` | `"W-YANKED"` | Warning |
| `SITE_OVERRIDE` | `"W-SITE-OVERRIDE"` | Warning |
| `API_SKEW` | `"W-API-SKEW"` | Warning |
| `FOREIGN_ROOT` | `"W-FOREIGN-ROOT"` | Warning |
| `REPLACE_DENIED` | `"W-REPLACE-DENIED"` | Warning |
| `POOL_COUNT` | `"W-POOL-COUNT"` | Warning |
