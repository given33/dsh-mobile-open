"""Version saved project files, not process memory. Bindings live outside the project."""

import argparse
import base64
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid

import project_inputs as tree

MAX_FILE = 2 * 1024 * 1024
MAX_FILES = 4096
MAX_BYTES = 256 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}")
SENSITIVE = re.compile(
    r"credential|secret|password|token|private[-_]?key|^id_(rsa|ed25519|ecdsa|dsa)",
    re.I,
)
SKIP = {
    "node_modules",
    "vendor",
    "dist",
    "target",
    "build",
    "coverage",
    "__pycache__",
    "venv",
    "bin",
    "obj",
}
SUFFIX = set(
    "c cc cpp h hpp m mm swift kt kts java cs fs fsx go rs py pyi rb php js jsx mjs cjs ts tsx vue svelte html css scss less sql sh ps1 lua dart r ex exs erl hrl scala proto graphql gradle lock mod sum ini properties cmake make mk csproj sln fsproj vbproj json toml yaml yml xml md txt csv".split()
)
NOEXT = {"Makefile", "Dockerfile", "LICENSE", "README", "CMakeLists.txt"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()


def part_ok(part):
    return (
        0 < len(part) <= 96
        and part[0].isalnum()
        and part[-1] not in ". "
        and all(c.isalnum() or c in " ._-" for c in part)
        and not SENSITIVE.search(part)
        and part.casefold() not in SKIP
        and not re.fullmatch(r"(?i:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?", part)
    )


def valid_scopes(scopes):
    return isinstance(scopes, list) and (
        scopes == ["*"]
        or (
            0 < len(scopes) <= 64
            and all(isinstance(s, str) and part_ok(s) for s in scopes)
        )
    )


def allowed(name, scopes):
    parts = name.split("/")
    return (
        len(name) <= 240
        and name == unicodedata.normalize("NFKC", name)
        and len(parts) <= 12
        and all(map(part_ok, parts))
        and (scopes == ["*"] or parts[0] in scopes)
        and (parts[-1] in NOEXT or parts[-1].rsplit(".", 1)[-1].lower() in SUFFIX)
    )


def grants(root):
    return root / "source-grants"


def authorize(root, key, folder, scopes):
    if not HASH.fullmatch(key) or not valid_scopes(scopes):
        raise ValueError("Choose specific project directories or files")
    folder = Path(folder).resolve(strict=True)
    if not folder.is_dir() or folder in {
        Path.home(),
        Path(folder.anchor),
        root.resolve(),
    }:
        raise ValueError("Select a project, not a home or disk root")
    if scopes == ["*"] and not (root.resolve() / "workspaces" / key == folder):
        # A mistaken project-wide opt-in must not scan a disk or a general user/profile directory.
        if (
            folder.parent == Path.home()
            or any(p.startswith(".") for p in folder.parts)
            or not any(
                (folder / n).exists()
                for n in (
                    ".git",
                    "package.json",
                    "pyproject.toml",
                    "Cargo.toml",
                    "go.mod",
                    "CMakeLists.txt",
                    "pom.xml",
                    "build.gradle",
                    "project.yml",
                )
            )
        ):
            raise ValueError(
                "Project-wide sharing needs a dedicated project root; choose explicit source paths instead"
            )
    st = folder.stat()
    value = dict(
        folder=str(folder),
        scopes=sorted(set(scopes)),
        device=str(st.st_dev),
        inode=str(st.st_ino),
    )
    grants(root).mkdir(parents=True, exist_ok=True, mode=0o700)
    with tree.directory(str(grants(root))) as dest:
        try:
            tree.publish(dest, key + ".json", encoded(value))
        except FileExistsError:
            if json.loads(tree.regular_bytes(dest, key + ".json", 16384)) != value:
                raise ValueError(
                    "Existing grant differs; refusing to silently change scope"
                )


class Journal:
    def __init__(self, root, key):
        if not HASH.fullmatch(key):
            raise ValueError("Invalid workspace identity")
        grant = json.loads((grants(root) / (key + ".json")).read_bytes())
        self.path, self.scopes = Path(grant["folder"]), grant["scopes"]
        self.bound_inode = (grant["device"], grant["inode"])
        st = self.path.stat()
        if (
            self.path.resolve() != self.path
            or str(st.st_ino) != grant["inode"]
            or str(st.st_dev) != grant["device"]
        ):
            raise ValueError("Bound workspace was replaced")
        folder = root / "source-history"
        folder.mkdir(mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(
            str(folder / (key + ".sqlite")), timeout=15, isolation_level=None
        )
        self.db.executescript("""PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=131072;
          CREATE TABLE IF NOT EXISTS versions(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, path TEXT NOT NULL, parents TEXT NOT NULL, data BLOB, depth INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS bypath ON versions(path,seq);
          CREATE TABLE IF NOT EXISTS heads(path TEXT NOT NULL,id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS disk(path TEXT PRIMARY KEY,id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS stamps(path TEXT PRIMARY KEY, stamp TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS plans(path TEXT PRIMARY KEY,old TEXT,new TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
        """)
        self.db.execute(
            "INSERT OR IGNORE INTO meta VALUES (?,?)", ("epoch", uuid.uuid4().hex)
        )

    def close(self):
        self.db.close()

    @contextmanager
    def locked(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def meta(self, key, default=None):
        row = self.db.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return row[0] if row else default

    def setmeta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, str(value)))

    def insert(self, name, parents, data):
        marker = isinstance(name, str) and re.fullmatch(
            r":step/[0-9a-f]{64}/[0-9a-f]{64}/(before|returned|threw)", name
        )
        if marker and (parents or data != b""):
            raise ValueError("Unexpected tool checkpoint payload")
        if (
            (not marker and not allowed(name, self.scopes))
            or len(parents) > 2
            or parents != sorted(set(parents))
        ):
            raise ValueError("Invalid source revision")
        if data is not None:
            if len(data) > MAX_FILE or b"\0" in data:
                raise ValueError("Unsupported source file")
            data.decode("utf-8")
        value = digest(encoded([name, parents, None if data is None else digest(data)]))
        if self.db.execute("SELECT 1 FROM versions WHERE id=?", (value,)).fetchone():
            return value
        depth = 0
        for parent in parents:
            row = self.db.execute(
                "SELECT path,depth FROM versions WHERE id=?", (parent,)
            ).fetchone()
            if not row or row[0] != name:
                raise ValueError("Missing revision ancestor")
            depth = max(depth, 1 + row[1])
        self.db.execute(
            "INSERT INTO versions(id,path,parents,data,depth) VALUES (?,?,?,?,?)",
            (value, name, json.dumps(parents), data, depth),
        )
        if marker:
            return value
        self.db.executemany("DELETE FROM heads WHERE id=?", [(p,) for p in parents])
        self.db.execute("INSERT INTO heads VALUES (?,?)", (name, value))
        return value

    def data(self, ident):
        return (
            self.db.execute(
                "SELECT data FROM versions WHERE id=?", (ident,)
            ).fetchone()[0]
            if ident
            else None
        )

    def disk(self, name):
        row = self.db.execute("SELECT id FROM disk WHERE path=?", (name,)).fetchone()
        return row[0] if row else None

    def mark(self, name, ident):
        self.db.execute("INSERT OR REPLACE INTO disk VALUES (?,?)", (name, ident))
        self.db.execute("DELETE FROM stamps WHERE path=?", (name,))

    def capture(self, folder, name, full):
        # Windows can record two quick, same-size edits with identical stat fields.
        # Re-read recently touched files; explicit execution fences always check bytes.
        try:
            with tree.leaf(folder, name) as (parent, leaf):
                st = os.stat(
                    parent.child(leaf), dir_fd=parent.fd, follow_symlinks=False
                )
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or getattr(st, "st_file_attributes", 0) & 0x400
            ):
                raise ValueError("Refusing a linked or special source file")
            hot_windows_file = os.name == "nt" and abs(time.time_ns() - st.st_mtime_ns) < 2_000_000_000
            stamp = json.dumps(
                [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
            )
        except FileNotFoundError:
            stamp = "missing"
            hot_windows_file = False
        if not full and not hot_windows_file and self.db.execute(
            "SELECT stamp FROM stamps WHERE path=?", (name,)
        ).fetchone() == (stamp,):
            return
        ident = self.disk(name)
        data = read(folder, name)
        if self.data(ident) != data:
            self.mark(name, self.insert(name, [ident] if ident else [], data))
        self.db.execute("INSERT OR REPLACE INTO stamps VALUES (?,?)", (name, stamp))

    def names(self):
        names = set()
        visited = 0
        total = 0

        def visit(path, rel):
            nonlocal visited, total
            try:
                st = path.lstat()
            except FileNotFoundError:
                return
            visited += 1
            if visited > MAX_FILES * 4:
                raise ValueError("Source scan entry limit exceeded")
            if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 0x400:
                return
            if stat.S_ISDIR(st.st_mode):
                if len(rel.split("/")) >= 12:
                    return
                for child in path.iterdir():
                    if part_ok(child.name):
                        visit(child, rel + "/" + child.name)
            elif stat.S_ISREG(st.st_mode) and allowed(rel, self.scopes):
                total += st.st_size
                names.add(rel)
                if total > MAX_BYTES or len(names) > MAX_FILES:
                    raise ValueError("Source scope too large")

        scopes = (
            self.scopes
            if self.scopes != ["*"]
            else [p.name for p in self.path.iterdir() if part_ok(p.name)]
        )
        for name in scopes:
            visit(self.path / name, name)
        return names

    def ignored(self, names):
        # Apply the project's existing ignore rules (also to tracked files); never run hooks or filters.
        if not names or not (self.path / ".git").exists():
            return set()
        proc = subprocess.run(
            [
                "git",
                "--no-optional-locks",
                "-C",
                str(self.path),
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
            ],
            input=b"".join(n.encode() + b"\0" for n in names),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        if proc.returncode not in (0, 1):
            raise ValueError("Cannot check project ignore rules")
        return {n.decode() for n in proc.stdout.split(b"\0") if n}

    def ancestry(self, ident):
        return dict(
            self.db.execute(
                """WITH RECURSIVE ancestors(id) AS (VALUES (?) UNION
          SELECT j.value FROM ancestors a JOIN versions v ON a.id=v.id JOIN json_each(v.parents) j)
          SELECT v.id,v.depth FROM ancestors a JOIN versions v USING(id)""",
                (ident,),
            )
        )

    def merge(self, name, heads):
        a, b = heads
        left, right = self.data(a), self.data(b)
        aa, bb = self.ancestry(a), self.ancestry(b)
        common = aa.keys() & bb.keys()
        if left == right:
            return self.insert(name, heads, left)
        if not common:
            return None
        # Multiple incomparable merge bases are ambiguous; never pick one by timestamp.
        frontier = sorted(common, key=aa.get, reverse=True)
        base = frontier[0]
        if len(common) > 1 and not common <= self.ancestry(base).keys():
            return None
        original = self.data(base)
        if left == original:
            merged = right
        elif right == original:
            merged = left
        elif None in (left, right, original):
            return None
        else:
            with tempfile.TemporaryDirectory() as tmp:
                paths = [Path(tmp) / str(i) for i in range(3)]
                for path, content in zip(paths, (left, original, right)):
                    path.write_bytes(content)
                r = subprocess.run(
                    [
                        "git",
                        "-c",
                        "merge.renormalize=false",
                        "merge-file",
                        "-p",
                        "--",
                        *paths,
                    ],
                    cwd=tmp,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=15,
                )
                if r.returncode != 0:
                    return None
                merged = r.stdout
        return self.insert(name, heads, merged)

    def scan(self, full=False):
        # Local grants identify one concrete directory, not a path that may later
        # be repointed at a different project by a missing mount or junction.
        with tree.directory(str(self.path)) as folder, self.locked():
            self.check_binding(folder)
            self.recover(folder)
            names = self.names() | {
                r[0] for r in self.db.execute("SELECT DISTINCT path FROM heads")
            }
            if len({n.casefold() for n in names}) != len(names):
                raise ValueError("Case collision in shared source paths")
            ignored = self.ignored(names)
            for name in sorted(names - ignored):
                self.capture(folder, name, full)
            for (name,) in self.db.execute(
                "SELECT DISTINCT path FROM heads ORDER BY path"
            ).fetchall():
                if name in ignored:
                    continue
                heads = [
                    r[0]
                    for r in self.db.execute(
                        "SELECT id FROM heads WHERE path=? ORDER BY id", (name,)
                    )
                ]
                target = (
                    heads[0]
                    if len(heads) == 1
                    else self.merge(name, heads)
                    if len(heads) == 2
                    else None
                )
                old = self.disk(name)
                if target and target != old:
                    self.db.execute(
                        "INSERT INTO plans VALUES (?,?,?)", (name, old, target)
                    )
        # Persist write intentions before touching the tree; retries use the same target.
        with tree.directory(str(self.path)) as folder, self.locked():
            self.recover(folder)

    def check_binding(self, folder):
        st = os.fstat(folder.fd) if folder.fd is not None else self.path.stat()
        if (str(st.st_dev), str(st.st_ino)) != self.bound_inode:
            raise ValueError("Workspace identity changed")

    def recover(self, folder):
        self.check_binding(folder)
        for name, old, target in self.db.execute(
            "SELECT path,old,new FROM plans"
        ).fetchall():
            before, after = self.data(old), self.data(target)
            actual = read(folder, name)
            backup = ".dsh-source-" + target + ".hold"
            prefix = name.rpartition("/")[0]
            hold = (prefix + "/" if prefix else "") + backup
            displaced = read(folder, hold)
            if (
                actual != after
                and displaced is None
                and actual == before
                and before is not None
            ):
                with tree.leaf(folder, name) as (parent, leaf):
                    tree.publish_name(parent, parent.child(leaf), backup)
                    if parent.fd is not None:
                        os.fsync(parent.fd)
                displaced = read(folder, hold)
                actual = read(folder, name)
            if displaced is not None and displaced != before:
                # An editor won the race. Preserve its bytes and model them as a sibling.
                sibling = self.insert(name, [old] if old else [], displaced)
                if actual is None:
                    tree.publish(folder, name, displaced)
                    actual = displaced
                if actual == displaced:
                    self.mark(name, sibling)
            elif (
                actual is None
                and after is not None
                and (before is None or displaced == before)
            ):
                try:
                    mode = 0o600
                    if displaced is not None and os.name == "posix":
                        with tree.leaf(folder, hold) as (parent, leaf):
                            mode = os.stat(
                                parent.child(leaf),
                                dir_fd=parent.fd,
                                follow_symlinks=False,
                            ).st_mode
                    tree.publish(folder, name, after, mode)
                except FileExistsError:
                    pass
                actual = read(folder, name)
            if actual == after:
                self.mark(name, target)
            elif actual != before and (displaced != actual or displaced is None):
                self.mark(name, self.insert(name, [old] if old else [], actual))
            if displaced is not None and displaced == before:
                with tree.leaf(folder, hold) as (p, n):
                    os.unlink(p.child(n), dir_fd=p.fd)
            self.db.execute("DELETE FROM plans WHERE path=?", (name,))

    def fence(self):
        conflicts = [
            r[0]
            for r in self.db.execute(
                "SELECT path FROM heads GROUP BY path HAVING COUNT(*)>1"
            )
        ]
        blocked = self.db.execute(
            "SELECT COUNT(*) FROM heads h LEFT JOIN disk d ON d.path=h.path AND d.id=h.id WHERE d.id IS NULL"
        ).fetchone()[0]
        return dict(
            epoch=self.meta("epoch"),
            seq=self.db.execute("SELECT COALESCE(MAX(seq),0) FROM versions").fetchone()[
                0
            ],
            peerStored=int(self.meta("ack", 0)),
            received=int(self.meta("recv", 0)),
            peerEpoch=self.meta("peer"),
            conflicts=conflicts,
            ready=not blocked,
        )

    def page(self, start):
        rows = self.db.execute(
            "SELECT seq,id,path,parents,data FROM versions WHERE seq>? ORDER BY seq LIMIT 16",
            (start,),
        )
        page = []
        size = 0
        for seq, ident, path, parents, data in rows:
            size += len(data or b"")
            if page and size > 4 * MAX_FILE:
                break
            page.append(
                [
                    seq,
                    ident,
                    path,
                    json.loads(parents),
                    None if data is None else base64.b64encode(data).decode(),
                ]
            )
        return page

    def accept(self, epoch, rows):
        if (
            not isinstance(epoch, str)
            or not re.fullmatch("[0-9a-f]{32}", epoch)
            or not isinstance(rows, list)
            or len(rows) > 16
        ):
            raise ValueError("Invalid source page")
        with self.locked():
            if self.meta("peer") not in (None, epoch):
                raise ValueError("Peer journal changed; rebind explicitly")
            self.setmeta("peer", epoch)
            cursor = int(self.meta("recv", 0))
            for seq, ident, path, parents, blob in rows:
                if type(seq) != int or seq < 1 or seq > cursor + 1:
                    raise ValueError("Gap in source journal")
                if seq <= cursor:
                    continue
                data = (
                    base64.b64decode(blob, validate=True) if blob is not None else None
                )
                if self.insert(path, parents, data) != ident:
                    raise ValueError("Source digest mismatch")
                cursor = seq
            self.setmeta("recv", cursor)
        return cursor


def read(folder, name):
    try:
        return tree.regular_bytes(folder, name, MAX_FILE)
    except FileNotFoundError:
        return None


def keys(root):
    return [
        p.stem for p in sorted(grants(root).glob("*.json")) if HASH.fullmatch(p.stem)
    ][:64]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=[
            "git-backup",
            "bind",
            "scan",
            "watch",
            "status",
            "fence",
            "mark",
            "resolve",
            "export",
        ],
    )
    parser.add_argument("root", type=Path)
    parser.add_argument("key", nargs="?")
    parser.add_argument("args", nargs="*")
    opts = parser.parse_args()
    if opts.action == "bind":
        folder, *scopes = opts.args
        authorize(opts.root, opts.key, folder, scopes)
        return
    if opts.action == "watch":
        # Parent owns the write end; even an ungraceful DSH exit closes it.
        stopped = threading.Event()

        def wait_for_parent():
            try:
                sys.stdin.buffer.read(1)
            finally:
                stopped.set()

        threading.Thread(target=wait_for_parent, daemon=True).start()
        backups = {}
        while not stopped.is_set():
            for key in keys(opts.root):
                try:
                    with closing(Journal(opts.root, key)) as j:
                        j.scan()
                        if opts.key == "cloud" and time.monotonic() >= backups.get(key, (0, None))[0]:
                            state = j.fence()
                            revision = (state["epoch"], state["seq"], state["peerEpoch"])
                            previous = backups.get(key, (0, None))[1]
                            backups[key] = (time.monotonic() + 30, previous)
                            if state["ready"] and state["peerEpoch"] and revision != previous:
                                from source_backup import backup
                                saved = backup(opts.root, key, j, state["peerEpoch"], state["received"], allowed)
                                if saved.get("gitCommit"):
                                    backups[key] = (time.monotonic() + 30, revision)
                except (
                    ValueError,
                    OSError,
                    sqlite3.Error,
                    subprocess.SubprocessError,
                ) as exc:
                    print(
                        "Source checkpoint unavailable:",
                        key,
                        type(exc).__name__,
                        file=sys.stderr,
                        flush=True,
                    )
            stopped.wait(0.4)
        return
    with closing(Journal(opts.root, opts.key)) as j:
        if opts.action in ("scan", "fence", "mark", "git-backup"):
            j.scan(full=True)
        if opts.action == "git-backup":
            from source_backup import backup
            epoch, seq = opts.args
            print(json.dumps(backup(opts.root, opts.key, j, epoch, int(seq), allowed)))
            return
        if opts.action == "mark":
            session, call, phase = opts.args
            if phase not in ("before", "returned", "threw") or not all(
                re.fullmatch(r"[\w.-]{1,160}", s) for s in (session, call)
            ):
                raise ValueError("Invalid step identity")
            with j.locked():
                j.insert(
                    ":step/"
                    + digest(session.encode())
                    + "/"
                    + digest(call.encode())
                    + "/"
                    + phase,
                    [],
                    b"",
                )
        if opts.action in ("resolve", "export"):
            name = opts.args[0]
            heads = sorted(
                r[0] for r in j.db.execute("SELECT id FROM heads WHERE path=?", (name,))
            )
            if opts.action == "export":
                dest = Path(opts.args[1])
                dest.mkdir(mode=0o700, exist_ok=False)
                for h in heads:
                    data = j.data(h)
                    (
                        dest / (h + (".deleted" if data is None else ".source"))
                    ).write_bytes(data or b"")
                print(json.dumps(heads))
                return
            with j.locked(), tree.directory(str(j.path)) as folder:
                latest = sorted(
                    r[0]
                    for r in j.db.execute("SELECT id FROM heads WHERE path=?", (name,))
                )
                if len(heads) < 2 or sorted(opts.args[1:]) != heads or latest != heads:
                    raise ValueError("Confirm both current revision IDs")
                data = read(folder, name)
                resolved = heads[0]
                for other in heads[1:]:
                    resolved = j.insert(name, sorted([resolved, other]), data)
                j.mark(name, resolved)
        print(json.dumps(j.fence(), ensure_ascii=True))


if __name__ == "__main__":
    main()
