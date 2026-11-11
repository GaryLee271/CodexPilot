#!/usr/bin/env python3
"""在宿主指定的全新暂存目录构建副本；不删除旧副本，不写官方包或用户档案。"""
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shutil
import struct
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
WIRE = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
# 由 Codex Pilot 的「Computer Use」开关注入；关闭时 app.asar 与官方逐字节一致。
COMPUTER_USE = os.environ.get("CODEX_PLUS_CLAUDE_COMPUTER_USE", "0") == "1"
PROGRESS_FILE = os.environ.get("CODEX_PLUS_CLAUDE_PROGRESS")


def report(percent, message):
    """把阶段进度写给宿主（Codex Pilot 读它画进度条）；单独运行脚本时静默跳过。"""
    if not PROGRESS_FILE:
        return
    try:
        pathlib.Path(PROGRESS_FILE).write_text(
            json.dumps({"percent": percent, "message": message}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[:500] or "命令执行失败")
    return result


def fuses(app):
    root = app.parent if app.is_file() else app
    candidates = []
    if os.name != "nt":
        candidates.append(root / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework")
    candidates.extend([root, root / "Claude.exe", root / "resources/electron.exe"])
    candidates.extend(p for p in root.rglob("*.exe") if p.is_file())
    found = []
    for binary in candidates:
        if not binary.is_file():
            continue
        data = binary.read_bytes()
        # 新版 Electron 里这段标记可能出现多次（例如多架构拼接），
        # 逐个校验：后面紧跟版本号、且 flag 全是 '0'/'1' 的才是真 fuse。
        offset = 0
        while True:
            index = data.find(WIRE, offset)
            if index < 0:
                break
            offset = index + len(WIRE)
            start = index + len(WIRE)
            version = data[start + 1]
            flags = data[start + 2:start + 2 + version]
            if 0 < version <= 16 and all(c in b"01" for c in flags):
                found.append((binary, start + 2, flags))
        if found:
            return found
    raise RuntimeError("Electron fuse 格式已变化，无法安全汉化此版本")


def root_for(app):
    return app.parent if app.is_file() else app


ASAR_DIGEST_WIRE = b"AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"


def asar_digest_slots(data):
    """只定位 Mach-O 专用 section，不改字符串常量中的同名标记。"""
    def invalid():
        raise RuntimeError("Electron ASAR 完整性摘要槽格式已变化，无法安全构建副本")

    def unpack(fmt, offset, end):
        if offset < 0 or offset + struct.calcsize(fmt) > end:
            invalid()
        return struct.unpack_from(fmt, data, offset)

    slices = [(0, len(data))]
    fat_formats = {b"\xca\xfe\xba\xbe": (">", False), b"\xbe\xba\xfe\xca": ("<", False),
                   b"\xca\xfe\xba\xbf": (">", True), b"\xbf\xba\xfe\xca": ("<", True)}
    if data[:4] in fat_formats:
        endian, wide = fat_formats[data[:4]]
        count, = unpack(endian + "I", 4, len(data))
        fmt = endian + ("IIQQII" if wide else "IIIII")
        stride = struct.calcsize(fmt)
        if count == 0 or 8 + count * stride > len(data):
            invalid()
        slices = []
        for index in range(count):
            fields = unpack(fmt, 8 + index * stride, len(data))
            start, size = fields[2:4]
            if start < 8 + count * stride or size < 4 or start + size > len(data):
                invalid()
            slices.append((start, size))

    slots = []
    for start, size in slices:
        end = start + size
        magic = data[start:start + 4]
        if magic not in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"):
            # 旧版没有该 section；带有新标记但无法解析的格式则明确拒绝。
            if ASAR_DIGEST_WIRE in data[start:end]:
                invalid()
            continue
        endian = "<" if magic == b"\xcf\xfa\xed\xfe" else ">"
        commands, command_bytes = unpack(endian + "II", start + 16, end)
        offset = start + 32
        command_end = offset + command_bytes
        if command_end > end or commands > command_bytes // 8:
            invalid()
        for _ in range(commands):
            command, length = unpack(endian + "II", offset, command_end)
            if length < 8 or offset + length > command_end:
                invalid()
            if command == 0x19:  # LC_SEGMENT_64
                if length < 72:
                    invalid()
                sections, = unpack(endian + "I", offset + 64, offset + length)
                if 72 + sections * 80 > length:
                    invalid()
                for index in range(sections):
                    section = offset + 72 + index * 80
                    name, segment = unpack("16s16s", section, offset + length)
                    if name.rstrip(b"\0") != b"__asar_integrity" or segment.rstrip(b"\0") != b"__DATA_CONST":
                        continue
                    length_in_file, = unpack(endian + "Q", section + 40, offset + length)
                    file_offset, = unpack(endian + "I", section + 48, offset + length)
                    slot = start + file_offset
                    if length_in_file < 66 or file_offset + length_in_file > size:
                        invalid()
                    if data[slot:slot + 32] != ASAR_DIGEST_WIRE:
                        invalid()
                    used, version = data[slot + 32:slot + 34]
                    if used == 0:  # Electron 对未启用的槽不校验版本，也不需要更新。
                        continue
                    if used != 1 or version != 1:
                        invalid()
                    slots.append(slot + 34)
            offset += length
    return slots


def sync_asar_integrity_digest(app, verify=False):
    binary = app / "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
    if not binary.is_file():
        return
    data = binary.read_bytes()
    slots = asar_digest_slots(data)
    if not slots:
        return
    with (app / "Contents/Info.plist").open("rb") as handle:
        entries = plistlib.load(handle).get("ElectronAsarIntegrity", {})
    digest = hashlib.sha256()
    # 官方资源路径均为 ASCII，与 Foundation 的 NSLiteralSearch 和 Packager 排序一致。
    if not entries or any(not isinstance(name, str) or not name.isascii() for name in entries):
        raise RuntimeError("Electron ASAR 完整性摘要字典格式不受支持")
    for name in sorted(entries):
        entry = entries[name]
        if not isinstance(entry, dict) or any(not isinstance(entry.get(key), str) for key in ("algorithm", "hash")):
            raise RuntimeError("Electron ASAR 完整性摘要字典格式不受支持")
        for value in (name, entry["algorithm"], entry["hash"]):
            digest.update(value.encode("utf-8"))
    expected = digest.digest()
    if verify:
        if any(data[offset:offset + 32] != expected for offset in slots):
            raise RuntimeError("Electron ASAR 完整性摘要校验失败，请重新制作增强版")
    else:
        # 全部架构和版本先验证完，再只更新副本中的摘要，之后仍走原有重签流程。
        with binary.open("r+b") as handle:
            for offset in slots:
                handle.seek(offset)
                handle.write(expected)


def ion_for(app):
    root = root_for(app)
    dirs = [root / "Contents/Resources", root / "resources", root]
    # 发布版明确优先加载归档；即使遗留旧目录，也必须修改真正会被加载的资源。
    for directory in dirs:
        archive = directory / "ion-dist.asar"
        if archive.is_file():
            return archive
    return next((directory / "ion-dist" for directory in dirs
                 if (directory / "ion-dist").is_dir()), dirs[0] / "ion-dist")


def file_integrity(data, block_size=4 * 1024 * 1024):
    if not isinstance(block_size, int) or block_size <= 0:
        raise RuntimeError("界面归档的分块校验格式已变化")
    return {
        "algorithm": "SHA256", "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": block_size,
        "blocks": [hashlib.sha256(data[i:i + block_size]).hexdigest()
                   for i in range(0, len(data), block_size)] or [hashlib.sha256(b"").hexdigest()],
    }


class IonUI:
    """目录和 ASAR 共用的界面访问层；只写调用方传入的暂存副本。"""

    def __init__(self, app):
        self.app = app
        self.path = ion_for(app)
        self.archive = self.path.is_file()
        self.changes = {}
        if not self.archive:
            return
        try:
            self.data = self.path.read_bytes()
            magic, header_size, pickle_size, json_size = struct.unpack("<IIII", self.data[:16])
            self.start = 8 + header_size
            if (magic != 4 or header_size != pickle_size + 4 or header_size % 4
                    or json_size > header_size - 8 or self.start > len(self.data)):
                raise ValueError("invalid header")
            self.raw_header = self.data[16:16 + json_size]
            self.header = json.loads(self.raw_header)
            self.entries = dict((name.lstrip("/"), meta)
                                for name, meta in _walk_asar(self.header))
            for name, meta in self.entries.items():
                self._parts(name)
                if "link" in meta or meta.get("unpacked"):
                    continue
                offset, size = int(meta["offset"]), meta["size"]
                if offset < 0 or not isinstance(size, int) or size < 0 or self.start + offset + size > len(self.data):
                    raise ValueError("invalid entry bounds")
        except (ValueError, TypeError, KeyError, AttributeError, struct.error) as error:
            raise RuntimeError("Claude 本地界面归档格式无效或已变化") from error

    @staticmethod
    def _parts(name):
        parts = name.split("/")
        if any(part in ("", ".", "..") or "\\" in part or ":" in part for part in parts):
            raise RuntimeError("界面归档包含不支持的资源路径")
        return parts

    def exists(self, name):
        return name in self.entries if self.archive else (self.path / name).is_file()

    def read(self, name):
        self._parts(name)
        if not self.archive:
            return (self.path / name).read_bytes()
        if name in self.changes:
            return self.changes[name]
        meta = self.entries[name]
        if "link" in meta or meta.get("unpacked"):
            raise RuntimeError("界面归档中的目标资源为链接或外置文件，暂不支持修改")
        offset = self.start + int(meta["offset"])
        return self.data[offset:offset + meta["size"]]

    def write(self, name, data):
        parts = self._parts(name)
        if not self.archive:
            target = self.path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            return
        node = self.header
        for part in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        meta = node["files"].setdefault(parts[-1], {})
        if "link" in meta or meta.get("unpacked") or "files" in meta:
            raise RuntimeError("界面归档中的目标资源格式不受支持")
        previous = meta.get("integrity", {})
        if previous.get("algorithm", "SHA256") != "SHA256":
            raise RuntimeError("界面归档的校验算法已变化")
        meta["integrity"] = file_integrity(data, previous.get("blockSize", 4 * 1024 * 1024))
        self.entries[name] = meta
        self.changes[name] = data

    def paths(self, prefix, suffix):
        if self.archive:
            return [name for name in self.entries if name.startswith(prefix + "/") and name.endswith(suffix)]
        return [path.relative_to(self.path).as_posix() for path in (self.path / prefix).rglob("*" + suffix)]

    def save(self):
        if not self.archive:
            return
        offset = 0
        blobs = []
        for name, meta in self.entries.items():
            if "link" in meta or meta.get("unpacked"):
                continue  # 非目标条目原样保留，外置文件也由应用复制流程保留。
            blob = self.read(name)
            meta["size"], meta["offset"] = len(blob), str(offset)
            offset += len(blob)
            blobs.append(blob)
        raw = json.dumps(self.header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        pad = (-len(raw)) % 4
        with self.path.open("wb") as handle:
            handle.write(struct.pack("<IIII", 4, len(raw) + pad + 8, len(raw) + pad + 4, len(raw)))
            handle.write(raw + b"\0" * pad)
            for blob in blobs:
                handle.write(blob)
        # macOS 从应用 plist 取得归档头哈希；更新后继续保留 Electron 完整性 fuse。
        plist = self.app / "Contents/Info.plist"
        if plist.is_file():
            with plist.open("rb") as handle:
                info = plistlib.load(handle)
            key = self.path.relative_to(self.app / "Contents").as_posix()
            info.setdefault("ElectronAsarIntegrity", {})[key] = {
                "algorithm": "SHA256", "hash": hashlib.sha256(raw).hexdigest(),
            }
            with plist.open("wb") as handle:
                plistlib.dump(info, handle)
            sync_asar_integrity_digest(self.app)

    def validate(self):
        if not self.archive:
            return
        plist = self.app / "Contents/Info.plist"
        if plist.is_file():
            with plist.open("rb") as handle:
                info = plistlib.load(handle)
            key = self.path.relative_to(self.app / "Contents").as_posix()
            expected = info.get("ElectronAsarIntegrity", {}).get(key, {})
            if expected != {"algorithm": "SHA256", "hash": hashlib.sha256(self.raw_header).hexdigest()}:
                raise RuntimeError("本地界面归档头校验失败，请重新制作增强版")
        for name, meta in self.entries.items():
            expected = meta.get("integrity")
            if expected and not meta.get("unpacked") and "link" not in meta:
                if expected != file_integrity(self.read(name), expected.get("blockSize")):
                    raise RuntimeError("本地界面归档文件校验失败：" + name)


def app_asar(root):
    candidates = [root / "Contents/Resources/app.asar", root / "resources/app.asar"]
    return next((path for path in candidates if path.is_file()), None)



CU_MARKER = "Contents/Resources/.cu-patched"


def cu_marker(app):
    return root_for(app) / CU_MARKER


def _walk_asar(node, prefix=""):
    for name, child in node.get("files", {}).items():
        path = prefix + "/" + name
        if "files" in child:
            yield from _walk_asar(child, path)
        else:
            yield path, child


def _match_paren(data, open_idx):
    depth = 0
    quote = None
    i = open_idx
    while i < len(data):
        ch = data[i:i + 1]
        if quote:
            if ch == b"\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in (b'"', b"'", b"`"):
            quote = ch
        elif ch == b"(":
            depth += 1
        elif ch == b")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _config_id_name(src):
    m = re.search(rb'([A-Za-z_$][\w$]*)\s*=\s*"1291166712"', src)
    return m.group(1) if m else None


def _force_field(src, field, const):
    pattern = re.compile(rb'\b[A-Za-z_$][\w$]*\(\s*' + re.escape(const) + rb'\s*,\s*"' + field.encode() + rb'"\s*,')
    hits = 0
    for _ in range(8):
        m = pattern.search(src)
        if not m:
            break
        open_idx = src.index(b"(", m.start())
        end = _match_paren(src, open_idx)
        if end < 0:
            break
        src = src[:m.start()] + b"!0" + src[end + 1:]
        hits += 1
    return src, hits


def _patch_cu_source(src):
    hits = []
    # 只认同一个文件里同时出现 CU 配置 id 的 chunk：别的文件里的 "chicagoEnabled"
    # 可能是属性调用（obj.x("chicagoEnabled")），替换成 !0 会制造语法错误。
    if b"1291166712" not in src:
        return src, hits
    src, n = re.subn(rb'\b[A-Za-z_$][\w$]*\(\s*"chicagoEnabled"\s*\)', b"!0", src)
    if n:
        hits.append("chicagoEnabled x%d" % n)
    const = _config_id_name(src)
    if const:
        for field in ("enabled", "appScopedEnabled"):
            src, n = _force_field(src, field, const)
            if n:
                hits.append("%s x%d" % (field, n))
    return src, hits


def patch_asar(copy):
    """在副本的 app.asar 里改写 Computer Use 门禁（原始安装包不动）。"""
    asar = app_asar(root_for(copy))
    if not asar or not asar.is_file():
        raise RuntimeError("副本缺少 app.asar")
    data = asar.read_bytes()
    _, hdr_size, _, json_str_size = struct.unpack("<IIII", data[:16])
    header = json.loads(data[16:16 + json_str_size].decode())
    start = 8 + hdr_size

    entries = []
    for path, meta in _walk_asar(header):
        if not meta.get("unpacked"):
            entries.append((path, meta))

    changed = []
    blobs = {}
    offset = 0
    for path, meta in entries:
        off = start + int(meta["offset"])
        size = int(meta["size"])
        blob = data[off:off + size]
        if path.endswith(".js") and size < 12_000_000:
            patched, hits = _patch_cu_source(blob)
            if hits:
                blob = patched
                changed.append("%s (%s)" % (path.rsplit("/", 1)[-1], ", ".join(hits)))
        meta.pop("integrity", None)
        meta["size"] = len(blob)
        meta["offset"] = str(offset)
        offset += len(blob)
        blobs[path] = blob

    if not changed:
        raise RuntimeError("没有找到可改写的 Computer Use 门禁，版本可能已变化")

    text = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode()
    pad = (-len(text)) % 4
    json_size = len(text) + pad + 4
    hdr_size = json_size + 4
    out = bytearray(struct.pack("<IIII", 4, hdr_size, json_size, len(text)))
    out += text + b"\0" * pad
    for path, _ in entries:
        out += blobs[path]
    asar.write_bytes(bytes(out))

    marker = cu_marker(copy)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"patched": changed}, ensure_ascii=False, indent=2))
    print("已改写 asar 里的 Computer Use 门禁：" + "; ".join(changed), flush=True)


def check(source, copy):
    _, _, flags = fuses(copy)[0]
    if flags[3] != ord("1"):
        raise RuntimeError("副本未启用启动注入")
    # 先比版本：官方更新后 app.asar 必然不一致，这时直接说「请重新准备副本」，
    # 比让后面的 cmp 抛出笼统的「命令执行失败」有用得多。
    if os.name != "nt":
        source_plist = source / "Contents/Info.plist"
        copy_plist = copy / "Contents/Info.plist"
        if source_plist.is_file() and copy_plist.is_file():
            with source_plist.open("rb") as f:
                source_info = plistlib.load(f)
            with copy_plist.open("rb") as f:
                copy_info = plistlib.load(f)
            if source_info.get("CFBundleVersion") != copy_info.get("CFBundleVersion"):
                raise RuntimeError("官方应用已更新，请重新制作增强版")
        verify = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(copy)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        verify_text = (verify.stderr or "") + (verify.stdout or "")
        # 固定自签证书没有受信任根，verify 会报 CSSMERR_TP_NOT_TRUSTED；
        # 签名本身有效，这种情况不放行的话每次构建都会被自己的证书挡下来。
        if verify.returncode != 0 and "CSSMERR_TP_NOT_TRUSTED" not in verify_text:
            raise RuntimeError("副本签名校验失败：" + verify_text.strip()[:300])
    source_asar, copy_asar = app_asar(root_for(source)), app_asar(root_for(copy))
    if COMPUTER_USE and cu_marker(copy).is_file():
        # CU 增强副本按设计会改 asar（并关掉 asar 完整性 fuse），这里只校验产物能解析。
        if copy_asar and not copy_asar.is_file():
            raise RuntimeError("CU 增强副本缺少 app.asar")
    elif source_asar and copy_asar:
        if os.name == "nt":
            if source_asar.read_bytes() != copy_asar.read_bytes():
                raise RuntimeError("app.asar 已被改动")
        else:
            result = subprocess.run(
                ["/usr/bin/cmp", "-s", str(source_asar), str(copy_asar)],
                capture_output=True,
                text=True,
                timeout=180,
            )
            if result.returncode:
                raise RuntimeError("app.asar 与官方不一致，请重新准备副本")
    ion = IonUI(copy)
    for name in ("zh-Hans.json", "dynamic/zh-Hans.json", "zh-Hans.overrides.json"):
        if not ion.exists("i18n/" + name):
            raise RuntimeError("中文词表缺失")
    if "zh-Hans:" not in ion.read("index.html").decode("utf-8"):
        raise RuntimeError("本地界面未注册中文词表")
    ion.validate()
    sync_asar_integrity_digest(copy, verify=True)
    print("副本签名、注入开关、中文词表与 app.asar 一致性检查通过", flush=True)



SIGN_IDENTITY_NAME = "Claude Enhanced Local"


def _has_identity():
    r = subprocess.run(
        ["/usr/bin/security", "find-identity", "-p", "codesigning"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return SIGN_IDENTITY_NAME in ((r.stdout or "") + (r.stderr or ""))


def ensure_signing_identity():
    """每台电脑各自生成一张同名自签证书。

    有了固定证书，TCC 按「证书 + identifier」认副本，重签不会掉授权；
    ad-hoc 签名的 csreq 带 cdhash，每次构建都得重新授权。
    """
    if os.name == "nt":
        return
    if os.environ.get("CODEX_PLUS_CLAUDE_SIGN_IDENTITY") or _has_identity():
        return
    home = pathlib.Path(os.path.expanduser("~"))
    target = home / ".codex-session-delete" / "claude-localization" / "signing"
    target.mkdir(parents=True, exist_ok=True)
    key = target / "claude-enhanced.key"
    crt = target / "claude-enhanced.crt"
    p12 = target / "claude-enhanced.p12"
    if not p12.exists():
        print("生成本机代码签名证书（仅本机使用）…", flush=True)
        run([
            "/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(crt), "-days", "3650", "-nodes",
            "-subj", f"/CN={SIGN_IDENTITY_NAME}",
            "-addext", "keyUsage=critical,digitalSignature",
            "-addext", "extendedKeyUsage=critical,codeSigning",
            "-addext", "basicConstraints=critical,CA:false",
        ])
        run([
            "/usr/bin/openssl", "pkcs12", "-export",
            "-inkey", str(key), "-in", str(crt), "-out", str(p12),
            "-passout", "pass:claude",
        ])
    run([
        "/usr/bin/security", "import", str(p12),
        "-k", str(home / "Library/Keychains/login.keychain-db"),
        "-P", "claude", "-T", "/usr/bin/codesign",
    ])
    print("证书已导入钥匙串：" + SIGN_IDENTITY_NAME, flush=True)


def build(source, copy):
    if copy.exists() or copy.is_symlink() or source.resolve() == copy.resolve():
        raise RuntimeError("构建目标必须是新的暂存目录")
    if not IonUI(source).exists("index.html"):
        raise RuntimeError("此版本缺少 ion-dist / ion-dist.asar 本地界面，暂不支持此版本汉化")
    if os.name != "nt":
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(source)])
    copy.parent.mkdir(parents=True, exist_ok=True)
    report(5, "克隆官方应用")
    print("克隆官方应用到暂存副本…", flush=True)
    if os.name == "nt":
        source_root, copy_root = root_for(source), root_for(copy)
        if copy_root.exists():
            raise RuntimeError("构建目标必须是新的暂存目录")
        shutil.copytree(source_root, copy_root)
    else:
        try:
            run(["/bin/cp", "-Rc", str(source), str(copy)])
        except RuntimeError:
            # ditto 可补全非 APFS 上的部分复制；不删除任何现有目录。
            run(["/usr/bin/ditto", str(source), str(copy)])
    fuse_sites = fuses(copy)
    flags = fuse_sites[0][2]
    if flags[3] not in (ord("0"), ord("1")):
        raise RuntimeError("此版本禁用了 Electron inspect fuse，无法汉化")
    if COMPUTER_USE and flags[4] not in (ord("0"), ord("1")):
        raise RuntimeError("此版本缺少 asar 完整性 fuse，无法做 CU 增强")
    # universal binary 每个架构各带一份 fuse，全部改掉，避免只改到不生效的那份。
    for binary, offset, _flags in fuse_sites:
        with binary.open("r+b") as f:
            f.seek(offset + 3)
            f.write(b"1")   # EnableNodeCliInspectArguments：启动注入需要
            if COMPUTER_USE:
                f.seek(offset + 4)
                f.write(b"0")   # EnableEmbeddedAsarIntegrityValidation：要改 asar 就必须关掉校验

    ion = IonUI(copy)
    for rel in ("zh-Hans.json", "dynamic/zh-Hans.json", "zh-Hans.overrides.json"):
        ion.write("i18n/" + rel, (HERE / "catalogs" / rel).read_bytes())

    # 白名单是本地 UI 的语言协商约束；官方更新后找不到时明确报不兼容。
    old = '["en-US","de-DE","fr-FR","ko-KR","ja-JP","es-419","es-ES","it-IT","hi-IN","pt-BR","id-ID"]'
    new = old[:-1] + ',"zh-Hans"]'
    matches = 0
    for name in ion.paths("assets", ".js"):
        text = ion.read(name).decode("utf-8")
        if old in text:
            ion.write(name, text.replace(old, new).encode("utf-8"))
            matches += 1
        elif new in text:
            matches += 1
    if not matches:
        raise RuntimeError("本地界面的语言协商格式已变化，旧副本已保留")

    html = ion.read("index.html").decode("utf-8")
    langs = sorted(pathlib.PurePosixPath(name).stem for name in ion.paths("i18n", ".json")
                   if name.count("/") == 1 and "." not in pathlib.PurePosixPath(name).stem)
    meta = '<meta name="i18n-catalogs" data-i18n-catalogs="' + ",".join(l + ":1.1.1" for l in langs) + '">'
    if re.search(r'<meta\b[^>]*name=[\"\x27]i18n-catalogs[\"\x27][^>]*>', html):
        html = re.sub(r'<meta\b[^>]*name=[\"\x27]i18n-catalogs[\"\x27][^>]*>', lambda _: meta, html)
    elif "</head>" in html:
        html = html.replace("</head>", meta + "</head>", 1)
    else:
        raise RuntimeError("本地界面的 HTML 格式已变化")
    ion.write("index.html", html.encode("utf-8"))
    ion.save()
    report(35, "克隆完成")
    if COMPUTER_USE:
        report(45, "改写 Computer Use 门禁")
        patch_asar(copy)
    else:
        print("未勾选 Computer Use：副本 app.asar 保持与官方一致", flush=True)
    report(65, "安装中文词表")
    print("安装中文词表并重签副本…", flush=True)
    report(80, "重签增强版")
    ensure_signing_identity()
    if os.name != "nt":
        run([sys.executable, str(HERE / "sign-copy.py"), str(source), str(copy)])
    report(95, "校验增强版")
    check(source, copy)
    report(100, "完成")


if __name__ == "__main__":
    try:
        source = pathlib.Path(os.environ["CODEX_PLUS_CLAUDE_SOURCE"])
        copy = pathlib.Path(os.environ["CODEX_PLUS_CLAUDE_COPY"])
        if "--check" in sys.argv:
            check(source, copy)
        else:
            build(source, copy)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
