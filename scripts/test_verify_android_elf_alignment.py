#!/usr/bin/env python3

from __future__ import annotations

import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

from verify_android_elf_alignment import verify_archive


def elf64(*, alignment: int, congruent: bool = True) -> bytes:
    data = bytearray(256)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<H", data, 54, 56)
    struct.pack_into("<H", data, 56, 1)
    offset = 0 if congruent else 4096
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
                elf64(alignment=alignment, congruent=congruent),
            )
            if include_x86_64:
                archive.writestr(
                    f"{prefix}x86_64/libhandscrash.so",
                    elf64(alignment=alignment, congruent=congruent),
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


if __name__ == "__main__":
    unittest.main()
