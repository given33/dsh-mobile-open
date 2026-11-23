"""Opt-in result mailbox. A peer frame has no local destination path or executable action."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from contextlib import ExitStack, closing
import errno

# Python -I omits the script directory. Import only from this installed bundle.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_inputs as tree

ID = re.compile(r"[a-f0-9]{64}")
QUOTA = 64 * 1024 * 1024
MAX_JOBS = 256
MAX_FILES = 16
LIMIT = 4 * 1024 * 1024
EXT = {"txt", "md", "csv", "json", "pdf", "png", "jpg", "jpeg", "webp", "xlsx", "docx"}


def names_ok(names):
    if not isinstance(names, list) or not 1 <= len(names) <= MAX_FILES:
        return False
    seen = {}
    for name in names:
        if not isinstance(name, str) or len(name) > 160:
            return False
        parts = name.split("/")
        if (
            not 2 <= len(parts) <= 6
            or parts[0] not in ("reports", "artifacts", "dist")
            or parts[-1].split(".")[-1].lower() not in EXT
            or "." not in parts[-1]
        ):
            return False
        for i, part in enumerate(parts):
            if (
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", part)
                or part.endswith(".")
                or re.match(r"^(con|prn|aux|nul|com\d|lpt\d)(\.|$)", part, re.I)
            ):
                return False
            if re.search(
                r"credential|secret|password|token|private[-_]?key", part, re.I
            ):
                return False
            path = "/".join(parts[: i + 1])
            key = path.lower()
            is_dir = i < len(parts) - 1
            if key in seen and (not is_dir or seen[key] != (path, True)):
                return False
            seen[key] = (path, is_dir)
    return True


def database(root):
    db = sqlite3.connect(str(root / "result-mailbox.sqlite"), timeout=8)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    db.executescript("""CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, route TEXT NOT NULL, folder TEXT NOT NULL, identity TEXT NOT NULL,
      names TEXT NOT NULL, created REAL NOT NULL, status TEXT NOT NULL, digest TEXT, body TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY, owner TEXT NOT NULL, created REAL NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captured (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, session TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS results_by_session ON sessions(session);
      CREATE INDEX IF NOT EXISTS result_pending ON grants(owner,status,created);""")
    return db


def identity(folder):
    info = (
        os.fstat(folder.fd)
        if folder.fd is not None
        else os.stat(folder.path, follow_symlinks=False)
    )
    if not info.st_ino:
        raise ValueError("Filesystem has no stable workspace ID")
    return str(info.st_dev) + ":" + str(info.st_ino)


def policy(root, route):
    try:
        with (root / "relay-outputs.json").open("rb") as f:
            raw = f.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            return None
        return json.loads(raw.decode("utf-8-sig")).get(route)
    except (OSError, ValueError, AttributeError):
        return None


def register(db, root, key, data):
    owner, route, names, folder = (
        data[k] for k in ("owner", "route", "names", "folder")
    )
    if (
        owner not in ("desktop", "cloud")
        or not route.startswith(owner + ":")
        or not names_ok(names)
        or policy(root, route) != names
        or not ID.fullmatch(data["session"])
        or not os.path.isabs(folder)
    ):
        raise ValueError("Owner result policy does not match")
    with tree.directory(folder) as cwd:
        ident = identity(cwd)
    now = time.time()
    with db:
        db.execute("BEGIN IMMEDIATE")
        if (
            db.execute(
                "SELECT count(*) FROM grants WHERE status IN ('waiting','received','conflict')"
            ).fetchone()[0]
            >= MAX_JOBS
        ):
            raise ValueError("Result grants full")
        db.execute("INSERT INTO sessions VALUES(?,?)", (key, data["session"]))
        db.execute(
            "INSERT INTO grants(id,owner,route,folder,identity,names,created,status) VALUES(?,?,?,?,?,?,?,?)",
            (key, owner, route, folder, ident, json.dumps(names), now, "waiting"),
        )


def capture(db, root, key, data):
    # Only the per-request staging subtree of a managed foreign workspace is read.
    owner, route, names = (data[k] for k in ("owner", "route", "names"))
    if (
        owner not in ("cloud", "desktop")
        or not route.startswith(owner + ":")
        or not names_ok(names)
    ):
        raise ValueError("Invalid return declaration")
    if db.execute("SELECT 1 FROM captured WHERE id=?", (key,)).fetchone():
        return
    try:
        files = collect_staged(root, key, route, names)
    except FileNotFoundError:
        message = {"id": key, "outcome": "missing-files"}
    except (ValueError, NotADirectoryError):
        message = {"id": key, "outcome": "invalid-files"}
    except OSError as e:
        if e.errno != errno.ELOOP:
            raise
        message = {"id": key, "outcome": "invalid-files"}
    else:
        message = {"id": key, "files": files}
    save_export(db, key, owner, message)


def collect_staged(root, key, route, names):
    space = hashlib.sha256(route.encode("utf8")).hexdigest()
    with ExitStack() as stack:
        parent = stack.enter_context(tree.directory(str(root)))
        for part in ("workspaces", space, "dsh-returns", key):
            parent = stack.enter_context(tree.directory(part, parent))
        files = []
        left = LIMIT
        for name in names:
            raw = tree.regular_bytes(parent, name, left)
            left -= len(raw)
            files.append(
                dict(
                    name=name,
                    bytes=base64.b64encode(raw).decode(),
                    digest=hashlib.sha256(raw).hexdigest(),
                )
            )
    return files


def save_export(db, key, owner, message):
    body = json.dumps(message, separators=(",", ":"))
    now = time.time()
    with db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM captured WHERE id=?", (key,)).fetchone():
            return
        db.execute("INSERT INTO captured VALUES(?)", (key,))
        count, size = db.execute(
            "SELECT count(*),coalesce(sum(length(body)),0) FROM exports"
        ).fetchone()
        if size + len(body) > QUOTA or count >= MAX_JOBS:
            raise ValueError("Result export quota reached")
        db.execute("INSERT INTO exports VALUES(?,?,?,?)", (key, owner, now, body))


def inventory(db, root, role):
    other = "cloud" if role == "desktop" else "desktop"
    have = [
        r[0]
        for r in db.execute(
            "SELECT id FROM exports WHERE owner=? ORDER BY created",
            (other,),
        )
    ]
    want = [
        r["id"]
        for r in db.execute(
            "SELECT * FROM grants WHERE owner=? AND status='waiting' ORDER BY created",
            (role,),
        )
        if policy(root, r["route"]) == json.loads(r["names"])
    ]
    return {"have": have, "want": want}


def receipts_for(db, role, offered):
    if (
        not isinstance(offered, list)
        or len(offered) > MAX_JOBS
        or not all(isinstance(k, str) and ID.fullmatch(k) for k in offered)
    ):
        raise ValueError("Invalid offered result IDs")
    if not offered:
        return {}
    placeholders = ",".join("?" for _ in offered)
    return dict(
        db.execute(
            "SELECT id,digest FROM grants WHERE owner=? AND digest IS NOT NULL AND id IN ("
            + placeholders
            + ")",
            [role] + offered,
        )
    )


def acknowledge(db, key, recipient, digest):
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT body FROM exports WHERE id=? AND owner=?", (key, recipient)
        ).fetchone()
        if row is None:
            return
        if hashlib.sha256(row[0].encode("ascii")).hexdigest() != digest:
            raise ValueError("Result receipt digest mismatch")
        db.execute("DELETE FROM exports WHERE id=? AND owner=?", (key, recipient))


def read_export(db, key, recipient):
    row = db.execute(
        "SELECT body FROM exports WHERE id=? AND owner=?",
        (key, recipient),
    ).fetchone()
    if not row:
        raise ValueError("No offered result")
    return row[0]


def accept(db, root, role, key, body):
    if not isinstance(body, str) or len(body) > LIMIT * 1.4 + 8192:
        raise ValueError("Oversized result")
    digest = hashlib.sha256(body.encode("ascii")).hexdigest()
    with db:
        db.execute("BEGIN IMMEDIATE")
        g = db.execute(
            "SELECT * FROM grants WHERE id=? AND owner=?", (key, role)
        ).fetchone()
        if not g or policy(root, g["route"]) != json.loads(g["names"]):
            raise ValueError("No matching current result grant")
        if g["status"] != "waiting":
            if g["digest"] != digest:
                raise ValueError("Conflicting result receipt")
            return digest
        obj = json.loads(body)
        if (
            isinstance(obj, dict)
            and set(obj) == {"id", "outcome"}
            and obj["id"] == key
            and obj["outcome"]
            in ("missing-files", "invalid-files", "turn-not-completed")
        ):
            db.execute(
                "UPDATE grants SET status='unavailable',digest=?,detail=? WHERE id=?",
                (digest, obj["outcome"], key),
            )
            return digest
        names = json.loads(g["names"])
        files = obj["files"]
        left = LIMIT
        if (
            set(obj) != {"id", "files"}
            or obj["id"] != key
            or not isinstance(files, list)
            or [f["name"] for f in files] != names
            or not names_ok(names)
        ):
            raise ValueError("Unexpected result paths")
        for f in files:
            if set(f) != {"name", "bytes", "digest"}:
                raise ValueError("Unexpected result metadata")
            raw = base64.b64decode(f["bytes"], validate=True)
            left -= len(raw)
            if (
                left < 0
                or base64.b64encode(raw).decode() != f["bytes"]
                or hashlib.sha256(raw).hexdigest() != f["digest"]
            ):
                raise ValueError("Corrupt result")
        if (
            db.execute("SELECT coalesce(sum(length(body)),0) FROM grants").fetchone()[0]
            + len(body)
            > QUOTA
        ):
            raise ValueError("Local result inbox full")
        db.execute(
            "UPDATE grants SET status='received',body=?,digest=? WHERE id=?",
            (body, digest, key),
        )
    return digest


def deliver(db, root, role):
    # A crash after publishing any prefix is safe: prepare compares existing files
    # and publishes missing ones without replacement. A copied receipt never reruns a task.
    for (key,) in db.execute(
        "SELECT id FROM grants WHERE owner=? AND status='received' ORDER BY created",
        (role,),
    ).fetchall():
        with db:
            db.execute("BEGIN IMMEDIATE")
            g = db.execute(
                "SELECT * FROM grants WHERE id=? AND status='received'", (key,)
            ).fetchone()
            if not g:
                continue
            try:
                if policy(root, g["route"]) != json.loads(g["names"]):
                    raise ValueError("Result grant revoked")
                with tree.directory(g["folder"]) as dest:
                    if identity(dest) != g["identity"]:
                        raise ValueError("Original workspace identity changed")
                    tree.run("prepare", dest, json.loads(g["body"])["files"])
                db.execute(
                    "UPDATE grants SET status='delivered',body=NULL,detail=NULL WHERE id=?",
                    (key,),
                )
            except (ValueError, FileExistsError, NotADirectoryError) as err:
                db.execute(
                    "UPDATE grants SET status='conflict',detail=? WHERE id=?",
                    (str(err)[:400], key),
                )
            except OSError as err:
                # An unplugged volume or a temporarily locked file may recover.
                if err.errno == errno.ELOOP:
                    db.execute(
                        "UPDATE grants SET status='conflict', detail=? WHERE id=?",
                        (str(err)[:400], key),
                    )
                else:
                    db.execute(
                        "UPDATE grants SET detail=? WHERE id=?", (str(err)[:400], key)
                    )


def inspect_local(action, root, role, extra):
    if (
        role not in ("desktop", "cloud")
        or not (root / "result-mailbox.sqlite").is_file()
    ):
        raise ValueError("No mailbox for this role")
    with closing(database(root)) as db:
        if action == "status" and not extra:
            rows = db.execute(
                "SELECT id,route,names,status,detail FROM grants WHERE owner=? ORDER BY created DESC",
                (role,),
            )
            return [
                dict(
                    id=r["id"],
                    workspace=r["route"],
                    files=json.loads(r["names"]),
                    status=r["status"],
                    detail=r["detail"],
                )
                for r in rows
            ]
        if action == "recover" and len(extra) == 2 and ID.fullmatch(extra[0]):
            # Only a local operator can choose a recovery directory. It must be
            # new and beneath a parent the operator already controls.
            row = db.execute(
                "SELECT body FROM grants WHERE owner=? AND id=? AND status='conflict'",
                (role, extra[0]),
            ).fetchone()
            if not row or not row["body"]:
                raise ValueError("No retained conflict for this request")
            dest = Path(extra[1]).absolute()
            with tree.directory(str(dest.parent)) as parent:
                os.mkdir(parent.child(dest.name), 0o700, dir_fd=parent.fd)
                if parent.fd is not None:
                    os.fsync(parent.fd)
                with tree.directory(dest.name, parent) as child:
                    tree.run("prepare", child, json.loads(row["body"])["files"])
            return True
        raise ValueError(
            "Expected status ROOT ROLE or recover ROOT ROLE ID NEW_DIRECTORY"
        )


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 4 and sys.argv[1] in ("status", "recover"):
            print(
                json.dumps(
                    inspect_local(
                        sys.argv[1], Path(sys.argv[2]), sys.argv[3], sys.argv[4:]
                    ),
                    ensure_ascii=False,
                )
            )
            sys.exit(0)
        action, folder, key = sys.argv[1:]
        root = Path(folder)
        if not ID.fullmatch(key):
            raise ValueError("Invalid result request ID")
        data = json.loads(sys.stdin.buffer.read(16385).decode("utf8"))
        with closing(database(root)) as db:
            if action == "session-status":
                rows = db.execute(
                    "SELECT id,names,status FROM grants JOIN sessions USING(id) WHERE owner=? AND session=? ORDER BY created DESC LIMIT 16",
                    (data["owner"], key),
                )
                print(
                    json.dumps(
                        [
                            dict(
                                request=r["id"],
                                files=json.loads(r["names"]),
                                status=r["status"],
                            )
                            for r in rows
                        ]
                    )
                )
                sys.exit(0)
            if action == "grant":
                register(db, root, key, data)
            elif action == "skip" and data.get("owner") in ("desktop", "cloud"):
                save_export(
                    db, key, data["owner"], {"id": key, "outcome": "turn-not-completed"}
                )
            elif action == "capture":
                capture(db, root, key, data)
            else:
                raise ValueError("Unknown result operation")
        print("true")
    except (KeyError, TypeError, ValueError, OSError, sqlite3.Error) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
