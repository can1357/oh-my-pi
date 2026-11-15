#!/usr/bin/env python3
"""Measure a Git tree and model S3 receipt capacity; never capture native inputs."""

import argparse
import json
import subprocess


KIB = 1024
MIB = KIB * KIB
PER_BLOB_BYTES = 8 * MIB
JOURNAL_PAYLOAD_BYTES = MIB
AUXILIARY_BLOBS = 3
RECORD_ENVELOPE_BYTES = 4 * KIB
JOURNAL_ENVELOPE_BYTES = 4 * KIB


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("revision", help="Git commit whose tracked tree to inventory")
    args = parser.parse_args()
    revision = subprocess.check_output(
        ["git", "rev-parse", "--verify", args.revision + "^{commit}"], text=True
    ).strip()
    command = ["git", "ls-tree", "-r", "-l", "-z", revision]
    inventory = subprocess.check_output(command)
    sizes = []
    excluded_modes = {}
    for item in inventory.split(b"\0"):
        if not item:
            continue
        metadata, _path = item.split(b"\t", 1)
        mode, kind, _object, size = metadata.split()
        if mode in (b"100644", b"100755") and kind == b"blob":
            sizes.append(int(size))
        else:
            key = mode.decode("ascii")
            excluded_modes[key] = excluded_modes.get(key, 0) + 1

    # Every regular path is conservatively treated as distinct content. Three
    # auxiliary refs stand for a manifest, snapshot and one raw leaf artifact.
    # Their lengths use the per-blob ceiling, not invented measured lengths.
    modeled_sizes = sizes + [PER_BLOB_BYTES] * AUXILIARY_BLOBS
    refs = [
        {"h": format(index, "064x"), "n": size}
        for index, size in enumerate(modeled_sizes, 1)
    ]
    closure_bytes = len(json.dumps(refs, separators=(",", ":")).encode("utf-8"))
    record_bytes = closure_bytes + RECORD_ENVELOPE_BYTES
    journal_bytes = 2 * record_bytes + JOURNAL_ENVELOPE_BYTES
    modeled_retained_bytes = sum(modeled_sizes)
    comparisons = {}
    for name, blob_count, total_bytes, receipt_bytes in [
        ("original", 4096, 64 * MIB, 256 * KIB),
        ("revised", 8192, 256 * MIB, 480 * KIB),
    ]:
        checks = {
            "blob_count": len(refs) <= blob_count,
            "aggregate_bytes": modeled_retained_bytes <= total_bytes,
            "individual_bytes": max(modeled_sizes, default=0) <= PER_BLOB_BYTES,
            "record_bytes": record_bytes <= receipt_bytes,
            "journal_payload_bytes": journal_bytes <= JOURNAL_PAYLOAD_BYTES,
        }
        comparisons[name] = {
            "limits": {
                "max_blobs": blob_count,
                "max_total_bytes": total_bytes,
                "max_blob_bytes": PER_BLOB_BYTES,
                "max_record_bytes": receipt_bytes,
                "journal_payload_bytes": JOURNAL_PAYLOAD_BYTES,
            },
            "model_checks": checks,
            "model_fits": all(checks.values()),
        }

    result = {
        "revision": revision,
        "inventory_command": command,
        "measured_git_inventory": {
            "regular_files": len(sizes),
            "logical_bytes": sum(sizes),
            "largest_blob_bytes": max(sizes, default=0),
            "excluded_modes": excluded_modes,
        },
        "serialization_model": {
            "assume_every_regular_file_distinct": True,
            "synthetic_hashes": "ordinal 64-hex placeholders; not content identities",
            "auxiliary_refs": AUXILIARY_BLOBS,
            "auxiliary_size_bytes_each": PER_BLOB_BYTES,
            "record_envelope_bytes_estimate": RECORD_ENVELOPE_BYTES,
            "journal_envelope_bytes_estimate": JOURNAL_ENVELOPE_BYTES,
            "closure_refs": len(refs),
            "closure_json_bytes": closure_bytes,
            "record_bytes_estimate": record_bytes,
            "journal_payload_bytes_estimate": journal_bytes,
            "retained_bytes_upper_bound_under_model": modeled_retained_bytes,
        },
        "comparisons": comparisons,
        "limitations": [
            "Git committed inventory only; not working-tree or native capture output",
            "No content deduplication measured; all regular paths modeled as distinct",
            "Auxiliary lengths and envelope sizes are model assumptions, not measurements",
            "No security-filter, supplemental-input, publication, retention or performance proof",
        ],
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
