#!/usr/bin/env python3
"""Extract CCPA protobuf descriptors from the validated Go ELF (protobuf==7.36.2).

Runs after recover-go.py. Instruction patterns are specific to the inspected
amd64 compiler output; incomplete dependency closure is an error, not a fallback.
The binary is never modified. Output includes the source hash and accessor RVAs.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import sys

from google.protobuf import descriptor_pb2
from google.protobuf.message import DecodeError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--symbols", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    data = Path(args.binary).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    symbols = json.loads(Path(args.symbols).read_text(encoding="utf-8"))
    if symbols["sourceSha256"] != digest:
        raise ValueError("symbol-map SHA256 does not match binary")
    spec = importlib.util.spec_from_file_location("agy_recover_go", Path(__file__).with_name("recover-go.py"))
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    elf = recovery.ELF(data)
    descriptors = {}
    evidence = {}
    pattern = re.compile(rb"\x48\x8d[\x05\x0d\x15](.{4})\x48\xf7[\xd8\xd9\xda]", re.DOTALL)
    comparison = re.compile(rb"(?:\x48\x81[\xf8\xf9\xfa]|\x48\x3d)(.{4})", re.DOTALL)
    for function in symbols["functions"]:
        if not function["name"].endswith(("_proto_init", "_rawDescGZIP.func1")):
            continue
        start = int(function["startRva"], 16)
        offset = elf.file_offset(start, function["size"])
        code = data[offset:offset + function["size"]]
        for match in pattern.finditer(code):
            rva = start + match.start() + 7 + struct.unpack("<i", match.group(1))[0]
            bound = comparison.search(code[match.end():match.end() + 24])
            if bound is None:
                continue
            length = struct.unpack("<I", bound.group(1))[0]
            if not 10 <= length <= 10_000_000:
                continue
            try:
                position = elf.file_offset(rva, length)
                raw = data[position:position + length]
                descriptor = descriptor_pb2.FileDescriptorProto.FromString(raw)
            except (recovery.RecoveryError, DecodeError):
                continue
            if not descriptor.name.endswith(".proto"):
                continue
            if descriptor.name in descriptors and descriptors[descriptor.name] != descriptor:
                raise ValueError(f"conflicting descriptors for {descriptor.name}")
            descriptors[descriptor.name] = descriptor
            evidence[descriptor.name] = {"name": descriptor.name, "rva": hex(rva), "length": length,
                                         "accessorRva": hex(start), "sha256": hashlib.sha256(raw).hexdigest()}
    required = set()

    def include(name):
        if name in required:
            return
        if name not in descriptors:
            raise ValueError(f"missing descriptor dependency: {name}")
        required.add(name)
        for dependency in descriptors[name].dependency:
            include(dependency)

    root = "google/internal/cloud/code/v1internal/prediction_service.proto"
    include(root)
    # Request type closure, not API annotation closure: Google's proto1
    # MessageSet/custom extensions are unrelated to request JSON and rejected by
    # the public runtime. Preserve every reachable wire field and enum exactly.
    types = {}
    owners = {}

    def index_messages(messages, prefix, file_name):
        for message in messages:
            full = prefix + "." + message.name
            types[full] = message
            owners[full] = file_name
            for enum in message.enum_type:
                types[full + "." + enum.name] = enum
                owners[full + "." + enum.name] = file_name
            index_messages(message.nested_type, full, file_name)

    for name in required:
        file = descriptors[name]
        prefix = "." + file.package
        index_messages(file.message_type, prefix, name)
        for enum in file.enum_type:
            types[prefix + "." + enum.name] = enum
            owners[prefix + "." + enum.name] = name
    reachable = set()

    def visit(name):
        if name in reachable:
            return
        if name not in types:
            raise ValueError(f"missing request type: {name}")
        reachable.add(name)
        value = types[name]
        if isinstance(value, descriptor_pb2.DescriptorProto):
            for field in value.field:
                if field.type_name:
                    visit(field.type_name)

    visit(".google.internal.cloud.code.v1internal.GenerateContentRequest")

    def copy_messages(messages, prefix, output):
        for original in messages:
            full = prefix + "." + original.name
            if not any(name == full or name.startswith(full + ".") for name in reachable):
                continue
            message = output.add()
            message.CopyFrom(original)
            message.ClearField("nested_type")
            message.ClearField("enum_type")
            message.ClearField("extension")
            message.DiscardUnknownFields()
            if full not in reachable:
                message.ClearField("field")
                message.ClearField("oneof_decl")
            copy_messages(original.nested_type, full, message.nested_type)
            for enum in original.enum_type:
                if full + "." + enum.name in reachable:
                    message.enum_type.add().CopyFrom(enum)

    required = {owners[name] for name in reachable}
    result = descriptor_pb2.FileDescriptorSet()
    for name in sorted(required):
        original = descriptors[name]
        file = result.file.add()
        file.name = name
        file.package = original.package
        file.syntax = original.syntax
        if original.HasField("edition"):
            file.edition = original.edition
        prefix = "." + file.package
        copy_messages(original.message_type, prefix, file.message_type)
        for enum in original.enum_type:
            if prefix + "." + enum.name in reachable:
                file.enum_type.add().CopyFrom(enum)
        dependencies = set()
        for full in reachable:
            if owners[full] != name or not isinstance(types[full], descriptor_pb2.DescriptorProto):
                continue
            for field in types[full].field:
                if field.type_name and owners[field.type_name] != name:
                    dependencies.add(owners[field.type_name])
        file.dependency.extend(sorted(dependencies))
        file.DiscardUnknownFields()
    encoded = result.SerializeToString(deterministic=True)
    Path(args.out).write_bytes(encoded)
    manifest = {"schemaVersion": 1, "binarySha256": digest, "descriptorSetSha256": hashlib.sha256(encoded).hexdigest(),
                "root": root, "message": "google.internal.cloud.code.v1internal.GenerateContentRequest",
                "projection": "GenerateContentRequest reachable message/enum closure; API services, annotations and unused extension declarations omitted",
                "files": [evidence[name] for name in sorted(required)]}
    Path(args.manifest).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"files": len(required), "bytes": len(encoded), "sha256": manifest["descriptorSetSha256"]}))


if __name__ == "__main__":
    main()
