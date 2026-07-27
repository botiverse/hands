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
) -> bytes:
    data = bytearray(256)
    data[:6] = b"\x7fELF" + bytes((elf_class, 1))
    struct.pack_into("<H", data, 18, machine)
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<H", data, 54, 56)
    struct.pack_into("<H", data, 56, 1)
    offset = 0 if congruent else (congruence_offset or 4096)
    struct.pack_into(
        "<IIQQQQQQ",
        data,
        64,
        1,
        5,
        offset,
        0,
        0,
        128,
        128,
        alignment,
    )
    return bytes(data)


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
