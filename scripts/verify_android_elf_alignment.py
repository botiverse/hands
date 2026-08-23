#!/usr/bin/env python3
"""Verify 64-bit Android native libraries are safe for 16 KB page devices."""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


PT_LOAD = 1
ET_DYN = 3
MIN_PAGE_ALIGNMENT = 16 * 1024
REQUIRED_ABIS = ("arm64-v8a", "x86_64")
EXPECTED_MACHINES = {
    "arm64-v8a": 183,  # EM_AARCH64
    "x86_64": 62,  # EM_X86_64
}


@dataclass(frozen=True)
class LoadSegment:
    offset: int
    virtual_address: int
    file_size: int
    memory_size: int
    alignment: int


def load_segments(
    data: bytes, *, expected_machine: int | None = None
) -> list[LoadSegment]:
    if len(data) < 64 or data[:4] != b"\x7fELF":
        raise ValueError("not an ELF file")

    elf_class = data[4]
    byte_order = data[5]
    if byte_order != 1:
        raise ValueError(
            f"64-bit Android ELF must be little-endian, got byte order {byte_order}"
        )
    endian = "<"

    if elf_class != 2:
        raise ValueError(f"64-bit ABI entry must contain ELFCLASS64, got class {elf_class}")
    elf_type = struct.unpack_from(f"{endian}H", data, 16)[0]
    if elf_type != ET_DYN:
        raise ValueError(f"shared library must contain ET_DYN, got ELF type {elf_type}")
    machine = struct.unpack_from(f"{endian}H", data, 18)[0]
    if expected_machine is not None and machine != expected_machine:
        raise ValueError(
            f"ELF machine {machine} does not match expected machine {expected_machine}"
        )

    phoff_offset, phoff_format = 32, "Q"
    phentsize_offset, phnum_offset = 54, 56
    program_header_size = 56
    segment_format = f"{endian}IIQQQQQQ"

    phoff = struct.unpack_from(f"{endian}{phoff_format}", data, phoff_offset)[0]
    phentsize = struct.unpack_from(f"{endian}H", data, phentsize_offset)[0]
    phnum = struct.unpack_from(f"{endian}H", data, phnum_offset)[0]
    if phentsize < program_header_size:
        raise ValueError(f"invalid ELF program-header size: {phentsize}")

    segments: list[LoadSegment] = []
    for index in range(phnum):
        start = phoff + index * phentsize
        end = start + program_header_size
        if end > len(data):
            raise ValueError("ELF program headers exceed file bounds")
        fields = struct.unpack_from(segment_format, data, start)
        if fields[0] != PT_LOAD:
            continue
        offset, virtual_address = fields[2], fields[3]
        file_size, memory_size, alignment = fields[5], fields[6], fields[7]
        segments.append(
            LoadSegment(
                offset=offset,
                virtual_address=virtual_address,
                file_size=file_size,
                memory_size=memory_size,
                alignment=alignment,
            )
        )

    if not segments:
        raise ValueError("ELF file contains no PT_LOAD segments")
    return segments


def verify_archive(archive_path: Path) -> dict[str, object]:
    results: dict[str, object] = {}
    seen_abis: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
        duplicate_names = sorted(
            name
            for name, count in Counter(
                entry.filename for entry in archive.infolist()
            ).items()
            if count > 1
        )
        if duplicate_names:
            raise ValueError(
                f"archive contains duplicate members: {', '.join(duplicate_names)}"
            )

        entries = sorted(
            (entry for entry in archive.infolist() if archive_abi(entry.filename)),
            key=lambda entry: entry.filename,
        )
        if not entries:
            raise ValueError("archive contains no required 64-bit Android libraries")

        for entry in entries:
            abi = archive_abi(entry.filename)
            if abi is None:
                raise ValueError(f"internal ABI resolution failure: {entry.filename}")
            seen_abis.add(abi)
            elf_data = archive.read(entry)
            segments = load_segments(
                elf_data,
                expected_machine=EXPECTED_MACHINES[abi],
            )
            for segment in segments:
                if segment.file_size > segment.memory_size:
                    raise ValueError(
                        f"{entry.filename} PT_LOAD file size {segment.file_size} "
                        f"exceeds memory size {segment.memory_size}"
                    )
                if segment.offset > len(elf_data) or (
                    segment.offset + segment.file_size > len(elf_data)
                ):
                    raise ValueError(
                        f"{entry.filename} PT_LOAD file range "
                        f"[{segment.offset}, {segment.offset + segment.file_size}) "
                        f"exceeds file bounds {len(elf_data)}"
                    )
                if segment.alignment == 0 or (
                    segment.alignment & (segment.alignment - 1)
                ) != 0:
                    raise ValueError(
                        f"{entry.filename} PT_LOAD alignment "
                        f"0x{segment.alignment:x} is not a power of two"
                    )
                if segment.alignment < MIN_PAGE_ALIGNMENT:
                    raise ValueError(
                        f"{entry.filename} PT_LOAD alignment "
                        f"0x{segment.alignment:x} is below 0x{MIN_PAGE_ALIGNMENT:x}"
                    )
                if (
                    segment.offset % segment.alignment
                    != segment.virtual_address % segment.alignment
                ):
                    raise ValueError(
                        f"{entry.filename} PT_LOAD offset/vaddr are not congruent "
                        f"for p_align=0x{segment.alignment:x}"
                    )
            results[entry.filename] = {
                "load_segments": len(segments),
                "min_alignment": min(segment.alignment for segment in segments),
            }

    missing_abis = sorted(set(REQUIRED_ABIS) - seen_abis)
    if missing_abis:
        raise ValueError(f"archive is missing required ABIs: {', '.join(missing_abis)}")
    return {
        "archive": str(archive_path),
        "minimum_page_alignment": MIN_PAGE_ALIGNMENT,
        "libraries": results,
    }


def archive_abi(filename: str) -> str | None:
    parts = filename.split("/")
    if (
        len(parts) == 3
        and parts[0] in {"jni", "lib"}
        and parts[1] in REQUIRED_ABIS
        and parts[2].endswith(".so")
    ):
        return parts[1]
    if len(parts) == 2 and parts[0] in REQUIRED_ABIS and parts[1].endswith(".so"):
        return parts[0]
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = verify_archive(args.archive)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"Android 16 KB ELF verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
