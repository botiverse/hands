#!/usr/bin/env python3
"""Verify 64-bit Android native libraries are safe for 16 KB page devices."""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path


PT_LOAD = 1
MIN_PAGE_ALIGNMENT = 16 * 1024
REQUIRED_ABIS = ("arm64-v8a", "x86_64")


@dataclass(frozen=True)
class LoadSegment:
    offset: int
    virtual_address: int
    alignment: int


def load_segments(data: bytes) -> list[LoadSegment]:
    if len(data) < 64 or data[:4] != b"\x7fELF":
        raise ValueError("not an ELF file")

    elf_class = data[4]
    byte_order = data[5]
    endian = "<" if byte_order == 1 else ">" if byte_order == 2 else None
    if endian is None:
        raise ValueError(f"unsupported ELF byte order: {byte_order}")

    if elf_class == 1:
        phoff_offset, phoff_format = 28, "I"
        phentsize_offset, phnum_offset = 42, 44
        program_header_size = 32
        segment_format = f"{endian}IIIIIIII"
    elif elf_class == 2:
        phoff_offset, phoff_format = 32, "Q"
        phentsize_offset, phnum_offset = 54, 56
        program_header_size = 56
        segment_format = f"{endian}IIQQQQQQ"
    else:
        raise ValueError(f"unsupported ELF class: {elf_class}")

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
        if elf_class == 1:
            offset, virtual_address, alignment = fields[1], fields[2], fields[7]
        else:
            offset, virtual_address, alignment = fields[2], fields[3], fields[7]
        segments.append(LoadSegment(offset, virtual_address, alignment))

    if not segments:
        raise ValueError("ELF file contains no PT_LOAD segments")
    return segments


def verify_archive(archive_path: Path) -> dict[str, object]:
    results: dict[str, object] = {}
    seen_abis: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
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
            segments = load_segments(archive.read(entry))
            for segment in segments:
                if segment.alignment < MIN_PAGE_ALIGNMENT:
                    raise ValueError(
                        f"{entry.filename} PT_LOAD alignment "
                        f"0x{segment.alignment:x} is below 0x{MIN_PAGE_ALIGNMENT:x}"
                    )
                if (
                    segment.offset % MIN_PAGE_ALIGNMENT
                    != segment.virtual_address % MIN_PAGE_ALIGNMENT
                ):
                    raise ValueError(
                        f"{entry.filename} PT_LOAD offset/vaddr are not congruent "
                        "for 16 KB pages"
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
