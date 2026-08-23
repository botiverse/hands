#!/usr/bin/env python3

from __future__ import annotations

import struct
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

from verify_android_elf_alignment import verify_archive


def elf64(
    *,
    alignment: int,
    machine: int,
    congruent: bool = True,
    elf_class: int = 2,
    congruence_offset: int | None = None,
    byte_order: int = 1,
    elf_type: int = 3,
    file_size: int = 128,
    memory_size: int = 128,
    materialize_segment: bool = True,
    truncate_to: int | None = None,
) -> bytes:
    offset = 0 if congruent else (congruence_offset or 4096)
    data_size = max(256, offset + file_size) if materialize_segment else 256
    data = bytearray(data_size)
    data[:6] = b"\x7fELF" + bytes((elf_class, byte_order))
    struct.pack_into("<H", data, 16, elf_type)
    struct.pack_into("<H", data, 18, machine)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<H", data, 54, 56)
    struct.pack_into("<H", data, 56, 1)
    struct.pack_into(
        "<IIQQQQQQ",
        data,
        64,
        1,
        5,
        offset,
        0,
        0,
        file_size,
        memory_size,
        alignment,
    )
    encoded = bytes(data)
    return encoded if truncate_to is None else encoded[:truncate_to]


class VerifyAndroidElfAlignmentTest(unittest.TestCase):
    def create_archive(
        self,
        root: Path,
        *,
        alignment: int,
        congruent: bool = True,
        include_x86_64: bool = True,
        symbols_layout: bool = False,
    ) -> Path:
        archive_path = root / "sdk.aar"
        with zipfile.ZipFile(archive_path, "w") as archive:
            prefix = "" if symbols_layout else "jni/"
            archive.writestr(
                f"{prefix}arm64-v8a/libhandscrash.so",
                elf64(
                    alignment=alignment,
                    machine=183,
                    congruent=congruent,
                ),
            )
            if include_x86_64:
                archive.writestr(
                    f"{prefix}x86_64/libhandscrash.so",
                    elf64(
                        alignment=alignment,
                        machine=62,
                        congruent=congruent,
                    ),
                )
        return archive_path

    def test_accepts_16kb_load_segments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = verify_archive(
                self.create_archive(Path(directory), alignment=16 * 1024)
            )
            self.assertEqual(2, len(report["libraries"]))

    def test_rejects_4kb_load_segments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "below 0x4000"):
                verify_archive(self.create_archive(Path(directory), alignment=4096))

    def test_accepts_native_symbols_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = verify_archive(
                self.create_archive(
                    Path(directory), alignment=16 * 1024, symbols_layout=True
                )
            )
            self.assertEqual(2, len(report["libraries"]))

    def test_rejects_noncongruent_load_segments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "not congruent"):
                verify_archive(
                    self.create_archive(
                        Path(directory), alignment=16 * 1024, congruent=False
                    )
                )

    def test_requires_both_64bit_abis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "missing required ABIs: x86_64"):
                verify_archive(
                    self.create_archive(
                        Path(directory),
                        alignment=16 * 1024,
                        include_x86_64=False,
                    )
                )

    def test_rejects_elfclass32_in_64bit_abi(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=183, elf_class=1),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "must contain ELFCLASS64"):
                verify_archive(archive_path)

    def test_rejects_wrong_machine_for_abi(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "does not match expected"):
                verify_archive(archive_path)

    def test_rejects_big_endian_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=16 * 1024,
                        machine=183,
                        byte_order=2,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "must be little-endian"):
                verify_archive(archive_path)

    def test_rejects_et_rel_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=183, elf_type=1),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "must contain ET_DYN"):
                verify_archive(archive_path)

    def test_rejects_segment_file_size_above_memory_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=16 * 1024,
                        machine=183,
                        file_size=256,
                        memory_size=128,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "exceeds memory size"):
                verify_archive(archive_path)

    def test_rejects_segment_range_past_file_end(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=16 * 1024,
                        machine=183,
                        file_size=4096,
                        memory_size=4096,
                        materialize_segment=False,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "exceeds file bounds"):
                verify_archive(archive_path)

    def test_rejects_zero_length_segment_offset_past_file_end(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=16 * 1024,
                        machine=183,
                        congruent=False,
                        congruence_offset=16 * 1024,
                        file_size=0,
                        memory_size=0,
                        materialize_segment=False,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "exceeds file bounds"):
                verify_archive(archive_path)

    def test_rejects_truncated_library_with_intact_program_headers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=16 * 1024,
                        machine=183,
                        file_size=8192,
                        memory_size=8192,
                        truncate_to=1024,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=16 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "exceeds file bounds"):
                verify_archive(archive_path)

    def test_rejects_non_power_of_two_alignment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "not a power of two"):
                verify_archive(
                    self.create_archive(Path(directory), alignment=24 * 1024)
                )

    def test_checks_congruence_against_segment_alignment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "sdk.aar"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "jni/arm64-v8a/libhandscrash.so",
                    elf64(
                        alignment=64 * 1024,
                        machine=183,
                        congruent=False,
                        congruence_offset=16 * 1024,
                    ),
                )
                archive.writestr(
                    "jni/x86_64/libhandscrash.so",
                    elf64(alignment=64 * 1024, machine=62),
                )
            with self.assertRaisesRegex(ValueError, "p_align=0x10000"):
                verify_archive(archive_path)

    def test_rejects_duplicate_archive_member(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = self.create_archive(
                Path(directory), alignment=16 * 1024
            )
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive_path, "a") as archive:
                    archive.writestr(
                        "jni/arm64-v8a/libhandscrash.so",
                        elf64(alignment=16 * 1024, machine=183),
                    )
            with self.assertRaisesRegex(ValueError, "duplicate members"):
                verify_archive(archive_path)

    def test_rejects_duplicate_non_elf_archive_member(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = self.create_archive(
                Path(directory), alignment=16 * 1024
            )
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive_path, "a") as archive:
                    archive.writestr("AndroidManifest.xml", b"first")
                    archive.writestr("AndroidManifest.xml", b"second")
            with self.assertRaisesRegex(ValueError, "AndroidManifest.xml"):
                verify_archive(archive_path)


if __name__ == "__main__":
    unittest.main()
