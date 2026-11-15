#!/usr/bin/env python3
"""Recover Go symbols from an unmodified ELF64 little-endian x86-64 PIE.

Usage (Python 3.9+, standard library only):
  python recover-go.py --binary antigravity --out symbols.json
  python recover-go.py --binary antigravity --out oauth.json --filter 'oauth2'
  python recover-go.py --binary antigravity --out token.json --struct-rva c864288

This is an explicit version/layout-specific fallback, not GoReSym output. It
supports Go 1.26-1.28 buildinfo versions ONLY with the validated .go.module
layout below; the inspected specimen uses the custom go1.28-20261102-RC00
compiler. Other versions/layouts fail closed. No addresses from the specimen
are used as defaults. In particular, .text is NOT the Go text base.

All addresses are exact hexadecimal ELF RVAs (zero-based ET_DYN image).
Runtime VA = loadBias + RVA. Function ends are exclusive, from the next
functab entry, and may include alignment padding. Duplicate names are retained.
Optional GoReSym is run on the original only, with output and failures recorded;
it is never used to silently replace this recovery or to claim attestation.
No binary is executed, relocated on disk, patched, or copied by this script.
"""
import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile


class RecoveryError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise RecoveryError(message)


def bounded(start, size, limit, label):
    require(0 <= start <= limit and 0 <= size <= limit - start,
            f"{label}: out-of-bounds range {start:#x}+{size:#x} (limit {limit:#x})")


def uvarint(data, offset, limit):
    value = 0
    for index in range(10):
        bounded(offset, 1, limit, "uvarint")
        byte = data[offset]
        offset += 1
        require(index < 9 or byte <= 1, "uvarint overflows uint64")
        value |= (byte & 0x7f) << (7 * index)
        if not byte & 0x80:
            require(index == 0 or byte != 0, "noncanonical uvarint")
            return value, offset
    raise RecoveryError("unterminated uvarint")


class ELF:
    def __init__(self, data):
        self.data = data
        header = self.unpack("16sHHIQQQIHHHHHH", 0)
        ident, elf_type, machine, version = header[:4]
        require(ident[:7] == b"\x7fELF\x02\x01\x01", "requires ELF64 little-endian version 1")
        require(elf_type == 3 and machine == 62 and version == 1,
                "requires x86-64 ET_DYN; other architectures/address bases unsupported")
        _, phoff, shoff, _, ehsize, phsize, phnum, shsize, shnum, shstrndx = header[4:]
        require(ehsize == 64 and phsize == 56 and shsize == 64, "unsupported ELF header sizes")
        require(0 < phnum < 0xffff and 0 < shstrndx < shnum < 0xff00,
                "missing or extended ELF header tables unsupported")
        bounded(phoff, phnum * phsize, len(data), "program headers")
        bounded(shoff, shnum * shsize, len(data), "section headers")
        self.loads = []
        for index in range(phnum):
            kind, flags, offset, address, _, filesz, memsz, _ = self.unpack("IIQQQQQQ", phoff + index * phsize)
            if kind == 1:
                bounded(offset, filesz, len(data), "PT_LOAD file range")
                bounded(address, memsz, 1 << 64, "PT_LOAD memory range")
                require(filesz <= memsz, "PT_LOAD filesz exceeds memsz")
                self.loads.append((address, offset, filesz, memsz, flags))
        require(self.loads and min(s[0] for s in self.loads) == 0,
                "requires zero-based ET_DYN load image for RVA semantics")
        raw_sections = [self.unpack("IIQQQQIIQQ", shoff + index * shsize) for index in range(shnum)]
        strings = raw_sections[shstrndx]
        bounded(strings[4], strings[5], len(data), "section name table")
        require(strings[1] == 3, "section names are not SHT_STRTAB")
        self.sections = []
        for raw in raw_sections:
            nameoff, kind, flags, address, offset, size, _, _, alignment, entsize = raw
            bounded(nameoff, 1, strings[5], "section name")
            name = self.cstring(strings[4] + nameoff, strings[4] + strings[5])
            bounded(address, size, 1 << 64, f"section {name}")
            if kind != 8:
                bounded(offset, size, len(data), f"section {name} file range")
            if flags & 2 and kind != 8 and size:
                require(self.file_offset(address, size) == offset, f"section {name} disagrees with PT_LOAD")
            self.sections.append(dict(name=name, kind=kind, flags=flags, rva=address,
                                      offset=offset, size=size, alignment=alignment, entsize=entsize))
        # Index relocation locations, not patched bytes. Preserve non-relative
        # records too, so a pointer cannot silently fall back to its on-disk zero.
        self.relocations = {}
        for section in self.sections:
            if section["kind"] in (9, 19) and section["flags"] & 2:
                raise RecoveryError("SHT_REL/SHT_RELR relocations unsupported; requires explicit RELA")
            if section["kind"] != 4 or not section["flags"] & 2:
                continue
            require(section["entsize"] == 24 and section["size"] % 24 == 0,
                    "invalid ELF64 RELA entry size")
            for offset in range(section["offset"], section["offset"] + section["size"], 24):
                target, _, _ = self.unpack("QQq", offset)
                require(target not in self.relocations, f"duplicate relocation at {target:#x}")
                self.relocations[target] = offset
        require(self.relocations, "no allocated RELA relocation records")

    def unpack(self, fmt, offset):
        bounded(offset, struct.calcsize("<" + fmt), len(self.data), "binary read")
        return struct.unpack_from("<" + fmt, self.data, offset)

    def file_offset(self, rva, size=1):
        bounded(rva, size, 1 << 64, "RVA")
        matches = [offset + rva - address for address, offset, filesz, _, _ in self.loads
                   if address <= rva and rva + size <= address + filesz]
        require(len(matches) == 1, f"RVA {rva:#x}+{size:#x} lacks unique file-backed PT_LOAD")
        return matches[0]

    def value(self, rva, fmt="Q"):
        return self.unpack(fmt, self.file_offset(rva, struct.calcsize("<" + fmt)))[0]

    def section(self, name):
        matches = [s for s in self.sections if s["name"] == name]
        require(len(matches) == 1, f"requires unique {name} section")
        section = matches[0]
        require(section["kind"] != 8 and section["flags"] & 2, f"{name} is not allocated file-backed data")
        return section

    def pointer(self, location, relative_required=False):
        raw = self.value(location)
        relocation = self.relocations.get(location)
        if relocation is None:
            require(not relative_required, f"missing R_X86_64_RELATIVE at {location:#x}")
            return raw, {"locationRva": hex(location), "rawValue": hex(raw), "source": "on-disk-pointer"}
        _, info, addend = self.unpack("QQq", relocation)
        require(info == 8, f"unsupported pointer relocation {info:#x} at {location:#x}")
        require(0 <= addend < 1 << 64, f"invalid relative addend at {location:#x}")
        return addend, {"locationRva": hex(location), "locationFileOffset": hex(self.file_offset(location, 8)),
                       "rawValue": hex(raw), "source": "R_X86_64_RELATIVE", "addendRva": hex(addend),
                       "relocationFileOffset": hex(relocation)}

    def executable(self, start, end):
        require(start < end, f"nonpositive function range {start:#x}..{end:#x}")
        self.file_offset(start, end - start)
        require(any(s["flags"] & 4 and s["rva"] <= start and end <= s["rva"] + s["size"]
                    for s in self.sections), f"range {start:#x}..{end:#x} not in executable section")
        require(any(flags & 1 and address <= start and end <= address + filesz
                    for address, _, filesz, _, flags in self.loads), "function not in executable PT_LOAD")

    def cstring(self, offset, limit):
        bounded(offset, 1, limit, "string")
        end = self.data.find(b"\0", offset, limit)
        require(end >= offset, f"unterminated string at file offset {offset:#x}")
        return self.data[offset:end].decode("utf-8", errors="strict")

    def buildinfo(self):
        section = self.section(".go.buildinfo")
        offset, limit = section["offset"], section["offset"] + section["size"]
        bounded(offset, 32, limit, "Go buildinfo header")
        require(self.data[offset:offset + 16] == b"\xff Go buildinf:\x08\x02",
                "requires little-endian 64-bit inline Go buildinfo")
        cursor = offset + 32
        strings = []
        for _ in range(2):
            length, cursor = uvarint(self.data, cursor, limit)
            bounded(cursor, length, limit, "Go buildinfo string")
            strings.append(self.data[cursor:cursor + length].decode("utf-8", errors="strict"))
            cursor += length
        version = strings[0]
        require(re.match(r"^go1\.(26|27|28)(?:\.|rc|beta|-|$)", version) is not None,
                f"unsupported Go version {version!r}; supports 1.26-1.28 with this module layout only")
        return {"version": version, "moduleInfo": strings[1], "rva": hex(section["rva"]),
                "fileOffset": hex(offset)}


def recover(elf, pattern):
    buildinfo = elf.buildinfo()
    module = elf.section(".go.module")
    require(module["size"] == 0x238, "unsupported .go.module size; expected this 0x238-byte layout")
    base = module["rva"]
    pc, pc_evidence = elf.pointer(base, True)
    rodata = elf.section(".lrodata")
    require(rodata["rva"] <= pc and pc + 72 <= rodata["rva"] + rodata["size"],
            "module pcHeader is outside .lrodata")
    header = elf.file_offset(pc, 72)
    require(elf.data[header:header + 8] == b"\xf1\xff\xff\xff\0\0\x01\x08",
            "unsupported pcHeader magic/padding/minLC/ptrSize")
    nfunc, nfiles, disk_text, names, cutab, files, pctab, pclntab = elf.unpack("8Q", header + 8)
    relative_limit = rodata["rva"] + rodata["size"] - pc
    require(0 < nfunc <= relative_limit // 8 and 0 < nfiles <= relative_limit,
            "invalid pcHeader function/file counts")
    require(72 <= names < cutab < files < pctab < pclntab < relative_limit,
            "invalid pcHeader subtable ordering/bounds")
    text, text_evidence = elf.pointer(base + 0xb0, True)
    minpc, minpc_evidence = elf.pointer(base + 0xa0, True)
    maxpc, maxpc_evidence = elf.pointer(base + 0xa8, True)
    etext, _ = elf.pointer(base + 0xb8, True)
    require(text == minpc and text < maxpc <= etext, "module text/minpc/maxpc/etext mismatch")
    resolved_text, header_text_evidence = elf.pointer(pc + 24)
    require(resolved_text in (0, text), "pcHeader textStart disagrees with relocated module text")
    evidence = []
    # All five slices independently tie the version-specific module offsets to
    # pcHeader offsets. No text-address guessing if any cross-check fails.
    for field, relative, length, stride in (
            (0x08, names, cutab - names, 1), (0x20, cutab, files - cutab, 4),
            (0x38, files, pctab - files, 1), (0x50, pctab, pclntab - pctab, 1),
            (0x68, pclntab, None, 1)):
        pointer, source = elf.pointer(base + field, True)
        size, capacity = elf.value(base + field + 8), elf.value(base + field + 16)
        require(pointer == pc + relative and 0 < size <= capacity,
                f"module slice at +{field:#x} disagrees with pcHeader")
        # Linker alignment may pad the pcHeader subtable spans.
        require(length is None or capacity * stride <= length,
                "module slice overlaps next pcHeader subtable")
        elf.file_offset(pointer, capacity * stride)
        require(pointer + capacity * stride <= rodata["rva"] + rodata["size"],
                "module slice outside .lrodata")
        evidence.append({"moduleOffset": hex(field), "length": size, "capacity": capacity,
                         "elementSize": stride, **source})
    table_rva = pc + pclntab
    table_size = elf.value(base + 0x70)
    require(nfunc * 8 + 4 <= table_size, "functab exceeds pclntable slice")
    ftab, ftab_evidence = elf.pointer(base + 0x80, True)
    require(ftab == table_rva and elf.value(base + 0x88) == nfunc + 1
            and elf.value(base + 0x90) == nfunc + 1, "module functab slice count/pointer mismatch")
    table = elf.file_offset(table_rva, table_size)
    name_start = elf.file_offset(pc + names)
    name_limit = name_start + elf.value(base + 0x10)
    bounded(name_start, name_limit - name_start, len(elf.data), "funcnametab")
    require(elf.unpack("I", table)[0] == 0, "functab first entry disagrees with relocated minpc")
    end_offset = elf.unpack("I", table + nfunc * 8)[0]
    require(text + end_offset == maxpc, "functab sentinel disagrees with relocated maxpc")
    functions = []
    for index in range(nfunc):
        entry, metadata = elf.unpack("II", table + index * 8)
        next_entry = elf.unpack("I", table + (index + 1) * 8)[0]
        require(metadata >= nfunc * 8 + 4 and metadata % 4 == 0,
                f"function {index}: metadata overlaps functab or is unaligned")
        bounded(metadata, 44, table_size, f"function {index} metadata")
        metadata_entry, name_offset = elf.unpack("Ii", table + metadata)
        require(metadata_entry == entry, f"function {index}: metadata entryOff mismatch")
        require(0 <= name_offset < name_limit - name_start, f"function {index}: invalid nameOff")
        name = elf.cstring(name_start + name_offset, name_limit)
        require(name != "", f"function {index}: empty name")
        start, end = text + entry, text + next_entry
        elf.executable(start, end)
        require(minpc <= start < end <= maxpc, f"function {index}: outside module PC bounds")
        if pattern is None or pattern.search(name):
            functions.append({"index": index, "name": name, "startRva": hex(start), "endRva": hex(end),
                              "startFileOffset": hex(elf.file_offset(start)), "size": end - start,
                              "entryOff": hex(entry), "metadataRva": hex(table_rva + metadata),
                              "metadataFileOffset": hex(table + metadata), "nameOff": name_offset})
    return {"buildinfo": buildinfo, "method": "version-specific-relocation-resolved-pclntab",
            "layout": "Go1.26-1.28/ELF64-x86-64/.go.module-0x238/pcHeader-0xfffffff1",
            "support": "Structural layout validation, not a claim of general support for every compiler in these releases",
            "pcHeaderRva": hex(pc), "pcHeaderFileOffset": hex(header), "moduleRva": hex(base),
            "pcHeaderEvidence": pc_evidence, "pcHeaderTextStartOnDisk": hex(disk_text),
            "pcHeaderTextStartEvidence": header_text_evidence,
            "textBaseRva": hex(text), "textBaseEvidence": text_evidence, "minpcEvidence": minpc_evidence,
            "maxpcEvidence": maxpc_evidence, "moduleSliceEvidence": evidence, "functabEvidence": ftab_evidence,
            "functionCount": nfunc, "emittedFunctionCount": len(functions), "fileCount": nfiles,
            "functions": functions}


def go_name(elf, rva):
    offset = elf.file_offset(rva)
    # Bound variable-length metadata to its allocated, file-backed section.
    sections = [s for s in elf.sections if s["flags"] & 2 and s["kind"] != 8
                and s["rva"] <= rva < s["rva"] + s["size"]]
    require(len(sections) == 1, f"name at {rva:#x} lacks unique allocated section")
    limit = sections[0]["offset"] + sections[0]["size"]
    flags = elf.data[offset]
    require(flags & ~15 == 0, f"unsupported Go name flags {flags:#x}")
    cursor = offset + 1
    length, cursor = uvarint(elf.data, cursor, limit)
    bounded(cursor, length, limit, "Go name")
    name = elf.data[cursor:cursor + length].decode("utf-8", errors="strict")
    cursor += length
    tag = None
    if flags & 2:
        length, cursor = uvarint(elf.data, cursor, limit)
        bounded(cursor, length, limit, "Go tag")
        tag = elf.data[cursor:cursor + length].decode("utf-8", errors="strict")
        cursor += length
    package_offset = None
    if flags & 4:
        bounded(cursor, 4, limit, "Go name package offset")
        package_offset = elf.unpack("i", cursor)[0]
        cursor += 4
    return {"nameRva": hex(rva), "flags": flags, "name": name, "tag": tag,
            "exported": bool(flags & 1), "embedded": bool(flags & 8),
            "packageNameOffset": package_offset, "encodedSize": cursor - offset}


def common_type(elf, rva):
    require(rva != 0 and rva % 8 == 0, f"invalid type pointer {rva:#x}")
    offset = elf.file_offset(rva, 48)
    size, ptrbytes, _, tflag, align, fieldalign, kind = elf.unpack("QQIBBBB", offset)
    require(0 < kind & 31 <= 26 and not kind & 0xc0, f"unsupported type kind at {rva:#x}")
    require(ptrbytes <= size and align in (1, 2, 4, 8) and fieldalign in (1, 2, 4, 8),
            f"invalid common type layout at {rva:#x}")
    return {"rva": hex(rva), "size": size, "pointerBytes": ptrbytes, "tflag": tflag,
            "align": align, "fieldAlign": fieldalign, "kind": kind & 31}


def decode_struct(elf, rva):
    result = common_type(elf, rva)
    require(result["kind"] == 25, f"type at {rva:#x} is not a Go struct")
    elf.file_offset(rva, 80)
    fields, fields_evidence = elf.pointer(rva + 56)
    count, capacity = elf.value(rva + 64), elf.value(rva + 72)
    require(count == capacity, "unsupported struct field slice length/capacity mismatch")
    require(count <= len(elf.data) // 24, "struct field count exceeds file bounds")
    if count:
        require(fields != 0 and fields % 8 == 0, "invalid struct field slice pointer")
        elf.file_offset(fields, count * 24)
    package, package_evidence = elf.pointer(rva + 48)
    result.update({"layout": "commonType=48; fields=+56/+64/+72; fieldStride=24",
                   "fieldsPointerEvidence": fields_evidence, "fieldCount": count,
                   "packagePathEvidence": package_evidence,
                   "packagePath": go_name(elf, package) if package else None, "fields": []})
    previous = 0
    for index in range(count):
        slot = fields + index * 24
        name, name_evidence = elf.pointer(slot)
        type_rva, type_evidence = elf.pointer(slot + 8)
        offset = elf.value(slot + 16)
        require(name != 0, f"field {index}: null name pointer")
        field_type = common_type(elf, type_rva)
        require(previous <= offset <= result["size"] and field_type["size"] <= result["size"] - offset,
                f"field {index}: offset/size outside struct or unordered")
        require(offset % field_type["fieldAlign"] == 0, f"field {index}: misaligned offset")
        previous = offset
        result["fields"].append({"index": index, "metadataRva": hex(slot), "offset": offset,
                                 **go_name(elf, name), "type": field_type,
                                 "namePointerEvidence": name_evidence, "typePointerEvidence": type_evidence})
    return result


def run_goresym(executable, binary):
    command = [executable, str(binary)]
    record = {"status": "not-run", "command": command, "input": "original-unmodified"}
    try:
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
        stdout, stderr = completed.stdout, completed.stderr
        record.update(returnCode=completed.returncode, status="failed" if completed.returncode else "completed")
        # A zero exit code is not, by itself, evidence that pclntab was found.
        if completed.returncode == 0:
            try:
                parsed = json.loads(stdout)
                functions = parsed.get("UserFunctions") if isinstance(parsed, dict) else None
                record["status"] = "symbols-reported" if isinstance(functions, list) and functions else "no-user-functions-reported"
            except (ValueError, UnicodeError):
                record["status"] = "invalid-json-output"
    except subprocess.TimeoutExpired as error:
        stdout, stderr = error.stdout or b"", error.stderr or b""
        record.update(status="timeout", error=str(error))
    except OSError as error:
        stdout, stderr = b"", b""
        record.update(status="launch-failed", error=str(error))
    record.update(stdout=stdout.decode("utf-8", errors="replace"), stderr=stderr.decode("utf-8", errors="replace"),
                  stdoutSha256=hashlib.sha256(stdout).hexdigest(), stderrSha256=hashlib.sha256(stderr).hexdigest())
    if record["status"] != "symbols-reported":
        print(f"GoReSym outcome: {record['status']}; retained in JSON, using explicit layout recovery", file=sys.stderr)
    return record


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2, ensure_ascii=True)
            output.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--filter", help="Python regex applied to names after validating every function")
    parser.add_argument("--struct-rva", action="append", default=[], help="hex RVA of a Go struct type; repeatable")
    parser.add_argument("--goresym", help="optional GoReSym executable; run on original, record stdout/stderr/outcome")
    args = parser.parse_args()
    try:
        binary, destination = args.binary.resolve(strict=True), args.out.resolve()
        require(binary != destination and (not destination.exists() or not os.path.samefile(binary, destination)),
                "output must not overwrite the original binary")
        pattern = re.compile(args.filter) if args.filter is not None else None
        struct_rvas = [int(value, 16) for value in args.struct_rva]
        require(all(0 <= rva < 1 << 64 for rva in struct_rvas), "struct RVAs must be unsigned uint64 hex")
        with binary.open("rb") as source:
            require(os.fstat(source.fileno()).st_size > 0, "empty binary")
            with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
                digest = hashlib.sha256(data).hexdigest()
                goresym = run_goresym(args.goresym, binary) if args.goresym else {"status": "not-requested"}
                record = {"schemaVersion": 1, "binary": str(binary), "sourceSha256": digest,
                          "binarySize": len(data), "originalModified": False,
                          "addressConvention": "hex ELF RVA; runtime VA = loadBias + RVA; ends exclusive",
                          "filter": args.filter, "goresym": goresym,
                          "provenance": {"kind": "static-recovery", "attestation": "not-observed",
                                         "patchedCopyCreated": False}}
                try:
                    elf = ELF(data)
                    record.update(recover(elf, pattern))
                    record["structs"] = [decode_struct(elf, rva) for rva in struct_rvas]
                    require(hashlib.sha256(data).hexdigest() == digest, "original changed during recovery")
                    record["status"] = "recovered"
                except (RecoveryError, UnicodeError, struct.error) as error:
                    record.update(status="failed", error=str(error))
                    atomic_json(destination, record)
                    raise RecoveryError(str(error)) from error
        atomic_json(destination, record)
        return 0
    except (RecoveryError, OSError, ValueError, re.error) as error:
        print(f"recover-go: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
