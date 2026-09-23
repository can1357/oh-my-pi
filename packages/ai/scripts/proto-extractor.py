#!/usr/bin/env python3
"""
Extracts protobuf definitions from bundled JavaScript.
Reconstructs .proto files with comments preserved.

Usage: python proto-extractor.py <bundled-js-file> <output-dir>
"""

import re
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

SCALAR_TYPES = {
    1: "double",
    2: "float",
    3: "int64",
    4: "uint64",
    5: "int32",
    6: "fixed64",
    7: "fixed32",
    8: "bool",
    9: "string",
    10: "group",
    11: "message",
    12: "bytes",
    13: "uint32",
    14: "enum",
    15: "sfixed32",
    16: "sfixed64",
    17: "sint32",
    18: "sint64",
}

WEBPACK_NOISE = [
    "__webpack_require__",
    "harmony export",
    "harmony import",
    "use strict",
    "WEBPACK_IMPORTED_MODULE",
    "binding",
]


@dataclass
class FieldDef:
    no: int
    name: str
    kind: str
    type_ref: str
    comment: str = ""
    opt: bool = False
    repeated: bool = False
    oneof: Optional[str] = None
    map_key: Optional[int] = None


@dataclass
class MessageDef:
    type_name: str
    fields: list[FieldDef] = field(default_factory=list)
    comment: str = ""


@dataclass
class EnumValueDef:
    name: str
    no: int
    comment: str = ""


@dataclass
class EnumDef:
    type_name: str
    values: list[EnumValueDef] = field(default_factory=list)
    comment: str = ""


@dataclass
class MethodDef:
    name: str
    input_type: str
    output_type: str
    kind: str
    comment: str = ""


@dataclass
class ServiceDef:
    type_name: str
    methods: list[MethodDef] = field(default_factory=list)
    comment: str = ""


@dataclass
class ProtoFile:
    path: str
    package: str
    syntax: str = "proto3"
    messages: list[MessageDef] = field(default_factory=list)
    enums: list[EnumDef] = field(default_factory=list)
    services: list[ServiceDef] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)


def is_webpack_noise(text: str) -> bool:
    """Check if text contains webpack bundler noise."""
    return any(noise in text for noise in WEBPACK_NOISE)


def extract_jsdoc_comment(text: str) -> str:
    """Extract clean comment from JSDoc block, filtering webpack noise."""
    if is_webpack_noise(text):
        return ""

    lines = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("*"):
            line = line[1:].strip()
        if line.startswith("/**") or line.endswith("*/"):
            continue
        if "@generated" in line:
            continue
        if is_webpack_noise(line):
            continue
        if line.startswith("case:") or "= { case:" in line:
            continue
        if line == "/" or line == "//" or len(line) <= 2:
            continue
        if line:
            lines.append(line)

    result = " ".join(lines)
    if is_webpack_noise(result):
        return ""
    if len(result) <= 2:
        return ""
    return result


def parse_type_reference(rest: str) -> str:
    """Parse the T: field to extract the type reference."""
    webpack_comment = re.search(r"T:\s*[^,]+/\*\s*\.?(\w+)\s*\*/", rest)
    if webpack_comment:
        return webpack_comment.group(1)

    type_match = re.search(r"T:\s*(\d+|[A-Za-z_][A-Za-z0-9_]*)", rest)
    if type_match:
        t = type_match.group(1)
        if t.isdigit():
            return SCALAR_TYPES.get(int(t), f"scalar_{t}")
        if is_webpack_noise(t) or t.startswith("_"):
            return "unknown"
        return t

    return "unknown"


def parse_field_list(fields_str: str, field_comments: dict[str, str]) -> list[FieldDef]:
    """Parse the fields array from newFieldList."""
    fields = []
    pattern = (
        r'\{\s*no:\s*(\d+)\s*,\s*name:\s*"([^"]+)"\s*,\s*kind:\s*"([^"]+)"([^}]*)\}'
    )

    for m in re.finditer(pattern, fields_str):
        no, name, kind, rest = int(m.group(1)), m.group(2), m.group(3), m.group(4)
        type_ref = parse_type_reference(rest)

        fields.append(
            FieldDef(
                no=no,
                name=name,
                kind=kind,
                type_ref=type_ref,
                comment=field_comments.get(name, ""),
                opt="opt: true" in rest,
                repeated="repeated: true" in rest,
                oneof=m2.group(1)
                if (m2 := re.search(r'oneof:\s*"([^"]+)"', rest))
                else None,
                map_key=int(m2.group(1))
                if (m2 := re.search(r"mapKey:\s*(\d+)", rest))
                else None,
            )
        )

    return fields


def extract_field_comments(class_body: str) -> dict[str, str]:
    """Extract field comments from class property declarations."""
    comments = {}
    pattern = r"/\*\*([\s\S]*?)@generated from field:[^*]*\*/\s*\n?\s*(\w+)"

    for m in re.finditer(pattern, class_body):
        comment_text = extract_jsdoc_comment(m.group(1))
        field_name_camel = m.group(2)
        field_name_snake = (
            re.sub(r"([A-Z])", r"_\1", field_name_camel).lower().lstrip("_")
        )
        if comment_text and not is_webpack_noise(comment_text):
            comments[field_name_snake] = comment_text

    return comments


def find_file_for_pos(
    file_ranges: dict[str, list[tuple[int, int]]], pos: int
) -> str | None:
    """Find which file a position belongs to."""
    for fp, segments in file_ranges.items():
        for start, end in segments:
            if start <= pos < end:
                return fp
    return None


def extract_messages(
    content: str, file_ranges: dict[str, list[tuple[int, int]]]
) -> dict[str, list[MessageDef]]:
    """Extract all message definitions grouped by file."""
    messages_by_file: dict[str, list[MessageDef]] = {}
    seen_types: set[str] = set()

    pattern = re.compile(
        r"/\*\*([\s\S]*?)@generated from message ([^\s*]+)[\s\S]*?\*/"
        r"[\s\S]*?class (\w+) extends [^{]+\{"
        r"([\s\S]*?)"
        r'static typeName\s*=\s*"([^"]+)"'
        r"[\s\S]*?"
        r"static fields\s*=\s*[^(]+\(\(\)\s*=>\s*\[([\s\S]*?)\]\)",
        re.MULTILINE,
    )

    for m in pattern.finditer(content):
        comment_block, _, class_name, class_body, type_name, fields_str = m.groups()
        pos = m.start()

        if type_name in seen_types:
            continue
        seen_types.add(type_name)

        file_path = find_file_for_pos(file_ranges, pos)
        if not file_path:
            continue

        comment = extract_jsdoc_comment(comment_block)
        field_comments = extract_field_comments(class_body)
        fields = parse_field_list(fields_str, field_comments)

        msg = MessageDef(type_name=type_name, fields=fields, comment=comment)
        messages_by_file.setdefault(file_path, []).append(msg)

    return messages_by_file


def extract_enums(
    content: str, file_ranges: dict[str, list[tuple[int, int]]]
) -> dict[str, list[EnumDef]]:
    """Extract all enum definitions grouped by file."""
    enums_by_file: dict[str, list[EnumDef]] = {}
    seen_types: set[str] = set()

    enum_block_pattern = re.compile(
        r"/\*\*([\s\S]*?)@generated from enum ([^\s*]+)[\s\S]*?\*/"
        r"[\s\S]*?"
        r'setEnumType\([^,]+,\s*"([^"]+)",\s*\[([\s\S]*?)\]\)',
        re.MULTILINE,
    )

    for m in enum_block_pattern.finditer(content):
        comment_block, _, type_name, values_str = m.groups()
        pos = m.start()

        if type_name in seen_types:
            continue
        seen_types.add(type_name)

        file_path = find_file_for_pos(file_ranges, pos)
        if not file_path:
            continue

        comment = extract_jsdoc_comment(comment_block)

        values = []
        value_pattern = r'\{\s*no:\s*(\d+)\s*,\s*name:\s*"([^"]+)"\s*\}'
        for vm in re.finditer(value_pattern, values_str):
            values.append(EnumValueDef(no=int(vm.group(1)), name=vm.group(2)))

        enum = EnumDef(type_name=type_name, values=values, comment=comment)
        enums_by_file.setdefault(file_path, []).append(enum)

    return enums_by_file


def resolve_webpack_type(ref: str) -> str:
    """Resolve a webpack type reference like 'agent_service_pb/* AgentClientMessage */.KS'."""
    webpack_comment = re.search(r"/\*\s*(\w+)\s*\*/", ref)
    if webpack_comment:
        return webpack_comment.group(1)
    parts = ref.replace(",", "").strip().split(".")
    return parts[-1] if parts else ref


def extract_services(
    content: str, file_ranges: dict[str, list[tuple[int, int]]]
) -> dict[str, list[ServiceDef]]:
    """Extract all service definitions grouped by file."""
    services_by_file: dict[str, list[ServiceDef]] = {}
    seen_types: set[str] = set()

    service_pattern = re.compile(
        r"/\*\*([^*]|\*[^/])*@generated from service ([^\s*]+)([^*]|\*[^/])*\*/"
        r"\s*(?:const|var)\s+\w+\s*=\s*\{"
        r'[^}]*typeName:\s*"([^"]+)"'
        r"[^}]*methods:\s*\{([\s\S]*?)\}\s*\}",
        re.MULTILINE,
    )

    for m in service_pattern.finditer(content):
        groups = m.groups()
        type_name = groups[3]  # typeName
        methods_str = groups[4]  # methods content
        pos = m.start()

        if type_name in seen_types:
            continue
        seen_types.add(type_name)

        file_path = find_file_for_pos(file_ranges, pos)
        if not file_path:
            continue

        # Extract comment from the match text before @generated
        full_match = m.group(0)
        comment_end = full_match.find("@generated")
        comment_text = full_match[3:comment_end] if comment_end > 0 else ""
        comment = extract_jsdoc_comment(comment_text)

        methods = []
        method_pattern = re.compile(
            r"/\*\*([\s\S]*?)@generated from rpc [^\s*]+\.(\w+)[\s\S]*?\*/"
            r"\s*\w+:\s*\{"
            r'[^}]*name:\s*"([^"]+)"'
            r"[^}]*I:\s*([^,]+),"
            r"[^}]*O:\s*([^,]+),"
            r"[^}]*kind:\s*[^.]+\.(\w+)",
            re.MULTILINE,
        )

        for mm in method_pattern.finditer(methods_str):
            method_comment, _, name, input_ref, output_ref, kind = mm.groups()

            methods.append(
                MethodDef(
                    name=name,
                    input_type=resolve_webpack_type(input_ref),
                    output_type=resolve_webpack_type(output_ref),
                    kind=kind,
                    comment=extract_jsdoc_comment(method_comment),
                )
            )

        svc = ServiceDef(type_name=type_name, methods=methods, comment=comment)
        services_by_file.setdefault(file_path, []).append(svc)

    return services_by_file


def find_file_ranges(content: str) -> dict[str, tuple[int, int]]:
    """Find the byte ranges for each proto file in the bundle.

    A file may appear multiple times (e.g., messages in _pb.js and services in _connect.js).
    We collect all ranges and merge them so all occurrences are captured.
    """
    file_pattern = re.compile(
        r"// @generated from file ([^\s]+) \(package ([^,]+), syntax (\w+)\)"
    )

    matches = list(file_pattern.finditer(content))

    file_segments: dict[str, list[tuple[int, int]]] = {}

    for i, m in enumerate(matches):
        file_path = m.group(1)
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)

        if file_path not in file_segments:
            file_segments[file_path] = []
        file_segments[file_path].append((start, end))

    ranges = {}
    for file_path, segments in file_segments.items():
        ranges[file_path] = segments

    return ranges


def field_to_proto(f: FieldDef, indent: str = "   ") -> str:
    """Convert a field definition to proto3 syntax."""
    lines = []

    if f.comment:
        lines.append(f"{indent}// {f.comment}")

    if f.kind == "map":
        key_type = SCALAR_TYPES.get(f.map_key, "string") if f.map_key else "string"
        lines.append(f"{indent}map<{key_type}, {f.type_ref}> {f.name} = {f.no};")
    else:
        prefix = ""
        if f.opt:
            prefix = "optional "
        elif f.repeated:
            prefix = "repeated "
        lines.append(f"{indent}{prefix}{f.type_ref} {f.name} = {f.no};")

    return "\n".join(lines)


def get_simple_name(type_name: str) -> str:
    """Get a unique message name from a fully qualified type name.

    Handles nested types like 'agent.v1.Outer.Inner' by converting to 'Outer_Inner'.
    """
    parts = type_name.split(".")
    # Skip the package prefix (e.g., 'agent.v1')
    if len(parts) > 2:
        return "_".join(parts[2:])
    return parts[-1]


def message_to_proto(msg: MessageDef, indent: str = "") -> str:
    """Convert a message definition to proto3 syntax."""
    lines = []
    name = get_simple_name(msg.type_name)

    if msg.comment:
        lines.append(f"{indent}// {msg.comment}")

    lines.append(f"{indent}message {name} {{")

    oneof_groups: dict[str, list[FieldDef]] = {}
    regular_fields: list[FieldDef] = []

    for f in msg.fields:
        if f.oneof:
            oneof_groups.setdefault(f.oneof, []).append(f)
        else:
            regular_fields.append(f)

    for f in regular_fields:
        lines.append(field_to_proto(f, indent + "   "))

    for oneof_name, fields in oneof_groups.items():
        lines.append(f"{indent}   oneof {oneof_name} {{")
        for f in fields:
            if f.comment:
                lines.append(f"{indent}      // {f.comment}")
            lines.append(f"{indent}      {f.type_ref} {f.name} = {f.no};")
        lines.append(f"{indent}   }}")

    lines.append(f"{indent}}}")
    return "\n".join(lines)


def enum_to_proto(enum: EnumDef, indent: str = "") -> str:
    """Convert an enum definition to proto3 syntax."""
    lines = []
    name = get_simple_name(enum.type_name)

    if enum.comment:
        lines.append(f"{indent}// {enum.comment}")

    lines.append(f"{indent}enum {name} {{")
    for v in enum.values:
        if v.comment:
            lines.append(f"{indent}   // {v.comment}")
        lines.append(f"{indent}   {v.name} = {v.no};")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def service_to_proto(svc: ServiceDef, indent: str = "") -> str:
    """Convert a service definition to proto3 syntax."""
    lines = []
    name = get_simple_name(svc.type_name)

    if svc.comment:
        lines.append(f"{indent}// {svc.comment}")

    lines.append(f"{indent}service {name} {{")

    for m in svc.methods:
        if m.comment:
            lines.append(f"{indent}   // {m.comment}")

        stream_in = "stream " if m.kind in ("ClientStreaming", "BiDiStreaming") else ""
        stream_out = "stream " if m.kind in ("ServerStreaming", "BiDiStreaming") else ""

        lines.append(
            f"{indent}   rpc {m.name}({stream_in}{m.input_type}) returns ({stream_out}{m.output_type});"
        )

    lines.append(f"{indent}}}")
    return "\n".join(lines)


def generate_proto_file(proto: ProtoFile) -> str:
    """Generate complete proto file content."""
    lines = [
        f'syntax = "{proto.syntax}";',
        "",
        f"package {proto.package};",
        "",
    ]

    for enum in proto.enums:
        lines.append(enum_to_proto(enum))
        lines.append("")

    for msg in proto.messages:
        lines.append(message_to_proto(msg))
        lines.append("")

    for svc in proto.services:
        lines.append(service_to_proto(svc))
        lines.append("")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 3:
        print("Usage: python proto-extractor.py <bundled-js-file> <output-file>")
        print("")
        print("Options:")
        print("  --filter=<pkg>   Only extract types from package (e.g., agent.v1)")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = Path(sys.argv[2])

    filter_pkg = None
    for arg in sys.argv[3:]:
        if arg.startswith("--filter="):
            filter_pkg = arg.split("=")[1]

    print(f"Reading {input_file}...", file=sys.stderr)
    with open(input_file, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    print(f"File size: {len(content) / 1024 / 1024:.2f} MB", file=sys.stderr)

    print("Finding file boundaries...", file=sys.stderr)
    file_ranges = find_file_ranges(content)
    print(f"Found {len(file_ranges)} proto files", file=sys.stderr)

    print("Extracting messages...", file=sys.stderr)
    messages_by_file = extract_messages(content, file_ranges)

    print("Extracting enums...", file=sys.stderr)
    enums_by_file = extract_enums(content, file_ranges)

    print("Extracting services...", file=sys.stderr)
    services_by_file = extract_services(content, file_ranges)

    file_pattern = re.compile(
        r"// @generated from file ([^\s]+) \(package ([^,]+), syntax (\w+)\)"
    )

    # Collect all messages, enums, services into one consolidated proto
    all_messages: dict[str, MessageDef] = {}
    all_enums: dict[str, EnumDef] = {}
    all_services: dict[str, ServiceDef] = {}
    seen_files: set[str] = set()
    package = None

    for m in file_pattern.finditer(content):
        file_path, pkg, syntax = m.groups()
        if filter_pkg and not pkg.startswith(filter_pkg):
            continue
        if file_path in seen_files:
            continue
        seen_files.add(file_path)
        if package is None:
            package = pkg
        for msg in messages_by_file.get(file_path, []):
            if msg.type_name not in all_messages:
                all_messages[msg.type_name] = msg
        for enum in enums_by_file.get(file_path, []):
            if enum.type_name not in all_enums:
                all_enums[enum.type_name] = enum
        for svc in services_by_file.get(file_path, []):
            if svc.type_name not in all_services:
                all_services[svc.type_name] = svc

    if package is None:
        print("No matching proto files found", file=sys.stderr)
        sys.exit(1)

    # Create consolidated proto file
    consolidated = ProtoFile(
        path=str(output_file),
        package=package,
        syntax="proto3",
        messages=list(all_messages.values()),
        enums=list(all_enums.values()),
        services=list(all_services.values()),
    )

    output_file.parent.mkdir(parents=True, exist_ok=True)
    proto_content = generate_proto_file(consolidated)
    output_file.write_text(proto_content)

    print(
        f"\nTotal: {len(all_messages)} messages, {len(all_enums)} enums, {len(all_services)} services",
        file=sys.stderr,
    )
    print(f"Output written to: {output_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
