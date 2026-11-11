"""真实 build/check 入口的离线回归场景，由 cargo test 调用。"""
import hashlib
import importlib.util
import json
import pathlib
import plistlib
import shutil
import struct
import subprocess
import sys
import unittest
from unittest import mock

SCRIPT = pathlib.Path(sys.argv.pop(1))
ROOT = pathlib.Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location("claude_build_copy", SCRIPT)
build_copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_copy)
OLD_LANGS = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]'


def integrity(data, block_size=16):
    return {"algorithm": "SHA256", "hash": hashlib.sha256(data).hexdigest(),
            "blockSize": block_size,
            "blocks": [hashlib.sha256(data[i:i + block_size]).hexdigest()
                       for i in range(0, len(data), block_size)] or [hashlib.sha256(b"").hexdigest()]}


def pack(files):
    header = {"files": {}}
    offset = 0
    for name, data in files.items():
        node = header
        parts = name.split("/")
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(offset), "integrity": integrity(data)}
        offset += len(data)
    raw = json.dumps(header, separators=(",", ":")).encode()
    pad = (-len(raw)) % 4
    return struct.pack("<IIII", 4, len(raw) + pad + 8, len(raw) + pad + 4, len(raw)) + raw + b"\0" * pad + b"".join(files.values())


def unpack(path):
    data = path.read_bytes()
    _, header_size, _, json_size = struct.unpack("<IIII", data[:16])
    raw = data[16:16 + json_size]
    header = json.loads(raw)
    files = {}
    def walk(node, prefix=""):
        for name, child in node["files"].items():
            name = prefix + name
            if "files" in child:
                walk(child, name + "/")
            else:
                start = 8 + header_size + int(child["offset"])
                blob = data[start:start + child["size"]]
                if "integrity" in child:
                    assert child["integrity"] == integrity(blob, child["integrity"]["blockSize"]), name
                files[name] = blob
    walk(header)
    return files, hashlib.sha256(raw).hexdigest()


# Electron 44 的摘要槽位于专用 Mach-O section；槽外同标记用于防止全局误写。
DIGEST_SENTINEL = b"AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"


def dictionary_digest(info):
    entries = info["ElectronAsarIntegrity"]
    text = "".join(name + entries[name]["algorithm"] + entries[name]["hash"]
                   for name in sorted(entries))
    return hashlib.sha256(text.encode("utf-8")).digest()


def sealed_framework(info, used=1, version=1, universal=False):
    slot = DIGEST_SENTINEL + bytes([used, version]) + dictionary_digest(info)
    def thin(cpu):
        header = struct.pack("<IiiIIIII", 0xfeedfacf, cpu, 0, 6, 1, 152, 0, 0)
        segment = struct.pack("<II16sQQQQiiII", 0x19, 152, b"__DATA_CONST", 0, 4096, 0, 512, 3, 3, 1, 0)
        section = struct.pack("<16s16sQQIIIIIIII", b"__asar_integrity", b"__DATA_CONST",
                              0, len(slot), 256, 0, 0, 0, 0, 0, 0, 0)
        return (header + segment + section).ljust(256, b"\0") + slot + b" decoy " + slot + build_copy.WIRE + bytes([1, 9]) + b"010011011"
    arm = thin(0x100000c)
    if not universal:
        return arm, [256]
    intel = thin(0x1000007)
    header = struct.pack(">II", 0xcafebabe, 2)
    header += struct.pack(">IIIII", 0x100000c, 0, 4096, len(arm), 12)
    header += struct.pack(">IIIII", 0x1000007, 0, 8192, len(intel), 12)
    return header.ljust(4096, b"\0") + arm.ljust(4096, b"\0") + intel, [4096 + 256, 8192 + 256]


class ArchiveBuildTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / self._testMethodName
        self.root.mkdir()
        self.source = self.root / "Claude.app"
        self.copy = self.root / "Enhanced.app"
        self.resources = self.source / "Contents/Resources"
        self.resources.mkdir(parents=True)
        (self.resources / "app.asar").write_bytes(b"official application archive must remain unchanged")
        framework = self.source / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
        framework.parent.mkdir(parents=True)
        framework.write_bytes(b"fake binary " + build_copy.WIRE + bytes([1, 9]) + b"010011011")
        self.files = {"index.html": b"<html><head></head><body></body></html>",
                      "assets/locale.js": ("const languages=" + OLD_LANGS + ";").encode(),
                      "assets/binary.dat": bytes(range(256)),
                      "i18n/en-US.json": b'{"hello":"Hello"}'}
        self.info = {"CFBundleVersion": "4.4212.0", "ElectronAsarIntegrity": {
            "Resources/app.asar": {"algorithm": "SHA256", "hash": "original-app-hash"}}}
        self.real_subprocess_run = subprocess.run

    def seed(self, archive=True):
        if archive:
            path = self.resources / "ion-dist.asar"
            path.write_bytes(pack(self.files))
            self.info["ElectronAsarIntegrity"]["Resources/ion-dist.asar"] = {
                "algorithm": "SHA256", "hash": unpack(path)[1]}
        else:
            for name, data in self.files.items():
                path = self.resources / "ion-dist" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        self.write_info()

    def write_info(self):
        with (self.source / "Contents/Info.plist").open("wb") as handle:
            plistlib.dump(self.info, handle)

    def run_command(self, args):
        if args[0] in ("/bin/cp", "/usr/bin/ditto"):
            shutil.copytree(self.source, self.copy)
        return subprocess.CompletedProcess(args, 0, "", "")

    def subprocess_run(self, args, **kwargs):
        if args[0] == "/usr/bin/codesign":
            return subprocess.CompletedProcess(args, 0, "", "")
        return self.real_subprocess_run(args, **kwargs)

    def build(self):
        with mock.patch.object(build_copy, "run", self.run_command), \
             mock.patch.object(build_copy, "ensure_signing_identity"), \
             mock.patch.object(build_copy, "COMPUTER_USE", False), \
             mock.patch.object(build_copy.subprocess, "run", self.subprocess_run):
            build_copy.build(self.source, self.copy)
            build_copy.check(self.source, self.copy)

    def test_archive_build_installs_catalogs_without_changing_official_app(self):
        self.seed()
        before = {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        self.build()
        files, digest = unpack(self.copy / "Contents/Resources/ion-dist.asar")
        for name in ("zh-Hans.json", "dynamic/zh-Hans.json", "zh-Hans.overrides.json"):
            self.assertEqual(files["i18n/" + name], (SCRIPT.parent / "catalogs" / name).read_bytes())
        self.assertIn(b'"zh-Hans"', files["assets/locale.js"])
        self.assertIn(b"zh-Hans:1.1.1", files["index.html"])
        self.assertEqual(files["assets/binary.dat"], self.files["assets/binary.dat"])
        self.assertEqual((self.copy / "Contents/Resources/app.asar").read_bytes(), before[pathlib.Path("Contents/Resources/app.asar")])
        with (self.copy / "Contents/Info.plist").open("rb") as handle:
            copied_info = plistlib.load(handle)
        self.assertEqual(copied_info["ElectronAsarIntegrity"]["Resources/ion-dist.asar"]["hash"], digest)
        self.assertEqual(copied_info["ElectronAsarIntegrity"]["Resources/app.asar"], self.info["ElectronAsarIntegrity"]["Resources/app.asar"])
        self.assertEqual(build_copy.fuses(self.copy)[0][2], b"010111011")
        self.assertFalse((self.copy / "Contents/Resources/ion-dist").exists())
        self.assertEqual(before, {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob("*") if p.is_file()})

    def test_legacy_directory_still_builds_and_checks(self):
        self.seed(archive=False)
        self.build()
        ion = self.copy / "Contents/Resources/ion-dist"
        self.assertIn("zh-Hans:", (ion / "index.html").read_text())
        self.assertEqual((ion / "assets/binary.dat").read_bytes(), self.files["assets/binary.dat"])
        self.assertFalse((self.copy / "Contents/Resources/ion-dist.asar").exists())

    def test_archive_takes_precedence_over_stale_directory(self):
        self.seed()
        old = self.resources / "ion-dist"
        old.mkdir()
        (old / "index.html").write_text("stale directory")
        self.build()
        self.assertIn(b"zh-Hans:", unpack(self.copy / "Contents/Resources/ion-dist.asar")[0]["index.html"])
        self.assertEqual((self.copy / "Contents/Resources/ion-dist/index.html").read_text(), "stale directory")

    def test_corrupt_archive_fails_before_copying(self):
        self.seed()
        (self.resources / "ion-dist.asar").write_bytes(b"broken archive")
        with self.assertRaisesRegex(RuntimeError, "归档"):
            self.build()
        self.assertFalse(self.copy.exists())

    def test_missing_interface_retains_clear_error(self):
        self.write_info()
        with self.assertRaisesRegex(RuntimeError, "本地界面"):
            self.build()
        self.assertFalse(self.copy.exists())

    def test_check_rejects_mismatched_archive_header_hash(self):
        self.seed()
        self.build()
        path = self.copy / "Contents/Info.plist"
        with path.open("rb") as handle:
            info = plistlib.load(handle)
        info["ElectronAsarIntegrity"]["Resources/ion-dist.asar"]["hash"] = "0" * 64
        with path.open("wb") as handle:
            plistlib.dump(info, handle)
        with mock.patch.object(build_copy.subprocess, "run", self.subprocess_run):
            with self.assertRaisesRegex(RuntimeError, "归档.*校验|校验.*归档"):
                build_copy.check(self.source, self.copy)

    def test_check_rejects_modified_packed_file(self):
        self.seed()
        self.build()
        archive = self.copy / "Contents/Resources/ion-dist.asar"
        data = bytearray(archive.read_bytes())
        _, header_size, _, json_size = struct.unpack("<IIII", data[:16])
        header = json.loads(data[16:16 + json_size])
        entry = header["files"]["i18n"]["files"]["zh-Hans.json"]
        data[8 + header_size + int(entry["offset"])] ^= 1
        archive.write_bytes(data)
        with mock.patch.object(build_copy.subprocess, "run", self.subprocess_run):
            with self.assertRaisesRegex(RuntimeError, "归档文件校验失败"):
                build_copy.check(self.source, self.copy)

    def assert_sealed_build(self, universal=False, used=1, version=1):
        self.seed()
        binary = self.source / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
        original, slots = sealed_framework(self.info, used, version, universal)
        binary.write_bytes(original)
        self.build()
        info = plistlib.loads((self.copy / "Contents/Info.plist").read_bytes())
        expected = bytearray(original)
        if used:
            for slot in slots:
                expected[slot + 34:slot + 66] = dictionary_digest(info)
        offset = 0
        while (offset := expected.find(build_copy.WIRE, offset)) >= 0:
            offset += len(build_copy.WIRE)
            expected[offset + 2 + 3] = ord("1")
        copied_binary = self.copy / binary.relative_to(self.source)
        self.assertEqual(copied_binary.read_bytes(), bytes(expected))
        self.assertEqual(binary.read_bytes(), original)
        return copied_binary, slots

    def test_archive_updates_embedded_dictionary_digest(self):
        self.assert_sealed_build()

    def test_archive_updates_every_universal_slice_and_preserves_decoys(self):
        self.assert_sealed_build(universal=True)

    def test_unused_digest_remains_unused(self):
        self.assert_sealed_build(used=0, version=99)

    def test_unknown_active_digest_version_fails_clearly(self):
        self.seed()
        binary = self.source / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
        original, _ = sealed_framework(self.info, version=2)
        binary.write_bytes(original)
        with self.assertRaisesRegex(RuntimeError, "摘要.*格式"):
            self.build()
        self.assertEqual(binary.read_bytes(), original)

    def test_out_of_bounds_digest_section_is_rejected(self):
        self.seed()
        binary = self.source / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
        original, _ = sealed_framework(self.info)
        broken = bytearray(original)
        struct.pack_into("<I", broken, 32 + 72 + 48, 0xffffffff)
        binary.write_bytes(broken)
        with self.assertRaisesRegex(RuntimeError, "摘要.*格式"):
            self.build()

    def test_check_rejects_stale_embedded_dictionary_digest(self):
        binary, slots = self.assert_sealed_build()
        data = bytearray(binary.read_bytes())
        data[slots[0] + 34] ^= 1
        binary.write_bytes(data)
        with mock.patch.object(build_copy.subprocess, "run", self.subprocess_run):
            with self.assertRaisesRegex(RuntimeError, "摘要.*校验"):
                build_copy.check(self.source, self.copy)

    def test_unknown_locale_format_does_not_touch_source(self):
        self.files["assets/locale.js"] = b"const unsupported = true;"
        self.seed()
        archive = self.resources / "ion-dist.asar"
        before = archive.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "语言协商格式已变化"):
            self.build()
        self.assertEqual(archive.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
