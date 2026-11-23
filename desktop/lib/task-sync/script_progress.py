"""Cooperative script state only. Frames never name a file to open or a command to run.

A script can commit progress locally while its peer is down. 'paired' means the
same immutable checkpoint was committed on both hosts, not that either owns a
lease to execute non-repeatable work. Use only for replay-safe computation.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import threading
import uuid

MAX_BYTES = 256 * 1024
MAX_PENDING = 64 * 1024 * 1024
MAX_TIPS = 64 * 1024 * 1024
MAX_RUNS = 1024
MAX_RECORDS = 200000
HEX = re.compile(r"[0-9a-f]{64}")
SESSION = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}")
START = "0" * 64


def connect(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(str(root / "script-progress.sqlite"), timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA synchronous=FULL")
    db.executescript("""CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY, run TEXT NOT NULL, rev INTEGER NOT NULL, parent TEXT NOT NULL,
      digest TEXT NOT NULL, done INTEGER NOT NULL, state BLOB,
      delivery TEXT NOT NULL, UNIQUE(run,rev));
      CREATE INDEX IF NOT EXISTS progress_outbox ON records(delivery,id);
      CREATE TABLE IF NOT EXISTS pulses(run TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_pulses(run TEXT PRIMARY KEY, token TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_run_digest ON records(run,digest);
      CREATE TABLE IF NOT EXISTS tips(run TEXT PRIMARY KEY, rev INTEGER NOT NULL, digest TEXT NOT NULL);
    """)
    return db


def run_id(session, job, recipe):
    if (
        not SESSION.fullmatch(session)
        or not SESSION.fullmatch(job)
        or not HEX.fullmatch(recipe)
    ):
        raise ValueError("Invalid session, job or SHA-256 recipe fingerprint")
    return hashlib.sha256(
        ("dsh-script-progress/v1:" + session + ":" + job + ":" + recipe).encode("ascii")
    ).hexdigest()


def fingerprint(run, rev, parent, done, state):
    prefix = f"dsh-script-state/v1:{run}:{rev}:{parent}:{int(done)}:".encode("ascii")
    return hashlib.sha256(prefix + state).hexdigest()


def frame(row):
    return dict(
        run=row["run"],
        rev=row["rev"],
        parent=row["parent"],
        digest=row["digest"],
        done=bool(row["done"]),
        state=base64.b64encode(row["state"]).decode("ascii"),
    )


def compact(db, run):
    # Never discard an unacknowledged payload. Keep digest receipts of older revisions
    # so a delayed ACK or replay can still be reconciled without rerunning the chunk.
    db.execute(
        """UPDATE records SET state=NULL WHERE run=? AND state IS NOT NULL AND delivery='paired'
                  AND rev < (SELECT rev FROM tips WHERE run=?)""",
        (run, run),
    )


def apply(db, f, source="peer"):
    if (
        source not in ("local", "peer")
        or not isinstance(f, dict)
        or set(f) != {"run", "rev", "parent", "digest", "done", "state"}
    ):
        raise ValueError("Invalid progress frame")
    run, rev, parent, digest, done, encoded = (
        f[k] for k in ("run", "rev", "parent", "digest", "done", "state")
    )
    if (
        not all(isinstance(x, str) and HEX.fullmatch(x) for x in (run, parent, digest))
        or type(rev) is not int
        or not 1 <= rev <= MAX_RECORDS
        or type(done) is not bool
        or not isinstance(encoded, str)
        or len(encoded) > 4 * ((MAX_BYTES + 2) // 3)
    ):
        raise ValueError("Invalid progress identity or state length")
    state = base64.b64decode(encoded, validate=True)
    if len(state) > MAX_BYTES or fingerprint(run, rev, parent, done, state) != digest:
        raise ValueError("Corrupt progress frame")
    with db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute(
            "SELECT digest,delivery FROM records WHERE run=? AND rev=?", (run, rev)
        ).fetchone()
        if prior:
            if prior["delivery"] == "conflict":
                return "conflict"
            if prior["digest"] != digest:
                if source == "peer":
                    db.execute(
                        "UPDATE records SET delivery='conflict' WHERE run=? AND rev=?",
                        (run, rev),
                    )
                return "conflict"
            if source == "peer":
                db.execute(
                    "UPDATE records SET delivery='paired' WHERE run=? AND rev=?",
                    (run, rev),
                )
                compact(db, run)
            return "stored"
        head = db.execute(
            "SELECT r.* FROM tips t JOIN records r USING(run,rev) WHERE t.run=?", (run,)
        ).fetchone()
        if db.execute(
            "SELECT 1 FROM records WHERE run=? AND delivery='conflict' LIMIT 1", (run,)
        ).fetchone():
            return "conflict"
        if (rev, parent) != (
            (head["rev"] + 1, head["digest"]) if head else (1, START)
        ) or (head and (head["done"] or head["delivery"] == "conflict")):
            return "conflict"
        if (
            not head
            and db.execute("SELECT count(*) FROM tips").fetchone()[0] >= MAX_RUNS
        ):
            return "full"
        if (
            db.execute("SELECT coalesce(max(id),0) FROM records").fetchone()[0]
            >= MAX_RECORDS
        ):
            return "full"
        # Limit disk consumption by outstanding and latest payloads separately.
        oldsize = len(head["state"]) if head else 0
        tips = db.execute(
            "SELECT coalesce(sum(length(r.state)),0) FROM tips t JOIN records r USING(run,rev)"
        ).fetchone()[0]
        if tips - oldsize + len(state) > MAX_TIPS:
            return "full"
        if source == "local":
            queued = db.execute(
                "SELECT coalesce(sum(length(state)),0) FROM records WHERE delivery!='paired'"
            ).fetchone()[0]
            if queued + len(state) > MAX_PENDING:
                return "full"
        db.execute(
            "INSERT INTO records(run,rev,parent,digest,done,state,delivery) VALUES(?,?,?,?,?,?,?)",
            (
                run,
                rev,
                parent,
                digest,
                int(done),
                state,
                "local" if source == "local" else "paired",
            ),
        )
        db.execute("INSERT OR REPLACE INTO tips VALUES(?,?,?)", (run, rev, digest))
        compact(db, run)
    return "stored"


def pending(db, limit=8):
    # Offer at most one revision per job per poll, in order. A conflicting job
    # cannot prevent discovery of unrelated work.
    rows = db.execute(
        """SELECT r.* FROM records r JOIN (
        SELECT run,min(id) AS id FROM records WHERE delivery!='paired' GROUP BY run
        ) p USING(run,id) WHERE delivery='local' ORDER BY id LIMIT ?""",
        (limit,),
    )
    return [frame(r) for r in rows]


def acknowledge(db, run, rev, digest, answer):
    if answer not in ("stored", "conflict", "full"):
        raise ValueError("Invalid checkpoint response")
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT digest,delivery FROM records WHERE run=? AND rev=?", (run, rev)
        ).fetchone()
        if not row or row["digest"] != digest:
            raise ValueError("Receipt does not identify a local checkpoint")
        if row["delivery"] == "local" and answer != "full":
            db.execute(
                "UPDATE records SET delivery=? WHERE run=? AND rev=?",
                ("paired" if answer == "stored" else "conflict", run, rev),
            )
            compact(db, run)


def current(db, run):
    row = db.execute(
        "SELECT r.* FROM tips t JOIN records r USING(run,rev) WHERE t.run=?", (run,)
    ).fetchone()
    if not row:
        return dict(rev=0, digest=START, done=False, state=None, delivery="none")
    health = db.execute(
        "SELECT 1 FROM records WHERE run=? AND delivery='conflict' LIMIT 1", (run,)
    ).fetchone()
    return dict(
        rev=row["rev"],
        digest=row["digest"],
        done=bool(row["done"]),
        state=base64.b64encode(row["state"]).decode("ascii"),
        delivery="conflict" if health else row["delivery"],
    )


def live_pulses(db):
    # Never queue heartbeats for retransmission after a disconnect. No comparison
    # between wall clocks on the two machines is needed by the standby.
    return [
        dict(r)
        for r in db.execute(
            "SELECT run,token,seq FROM pulses WHERE updated BETWEEN ? AND ? LIMIT 256",
            (time.time() - 5, time.time() + 1),
        )
    ]


def observe(db, pulses):
    if not isinstance(pulses, list) or len(pulses) > 256:
        raise ValueError("Invalid heartbeat inventory")
    with db:
        for p in pulses:
            if (
                not isinstance(p, dict)
                or set(p) != {"run", "token", "seq"}
                or not isinstance(p["run"], str)
                or not HEX.fullmatch(p["run"])
                or not isinstance(p["token"], str)
                or not re.fullmatch("[a-f0-9]{32}", p["token"])
                or type(p["seq"]) is not int
                or not 0 < p["seq"] <= 2**53
            ):
                raise ValueError("Invalid heartbeat")
            # A heartbeat cannot create a job, advance a checkpoint or authorize a command.
            db.execute(
                """INSERT INTO peer_pulses(run,token,seq) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM tips WHERE run=?)
                ON CONFLICT(run) DO UPDATE SET token=excluded.token,seq=excluded.seq
                WHERE token!=excluded.token OR seq<excluded.seq""",
                (p["run"], p["token"], p["seq"], p["run"]),
            )


def pulse_until_eof(db, run):
    token = uuid.uuid4().hex
    seq = 0
    closed = threading.Event()

    def watch_pipe():
        try:
            # The primary process owns the only pipe writer. Even a killed or CPU-bound
            # primary releases it on exit; no detached timer keeps it alive forever.
            sys.stdin.buffer.read(1)
        finally:
            closed.set()

    threading.Thread(target=watch_pipe, daemon=True).start()
    try:
        while not closed.is_set():
            seq += 1
            now = time.time()
            with db:
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    "DELETE FROM pulses WHERE updated NOT BETWEEN ? AND ?",
                    (now - 6, now + 1),
                )
                active = db.execute(
                    "SELECT token FROM pulses WHERE run=?", (run,)
                ).fetchone()
                if active and active["token"] != token:
                    raise ValueError("Another local producer holds this heartbeat")
                if (
                    not active
                    and db.execute("SELECT count(*) FROM pulses").fetchone()[0] >= 256
                ):
                    raise ValueError("Too many active producers")
                db.execute(
                    "INSERT OR REPLACE INTO pulses VALUES(?,?,?,?)",
                    (run, token, seq, now),
                )
            if seq == 1:
                print("ready", flush=True)
            closed.wait(1)
    finally:
        with db:
            db.execute("DELETE FROM pulses WHERE run=? AND token=?", (run, token))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["load", "save", "wait", "quiet", "pulse"])
    parser.add_argument("session")
    parser.add_argument("job")
    parser.add_argument("recipe")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
        / "mobile-task-sync",
    )
    parser.add_argument("--quiet-ms", type=int, default=12000)
    parser.add_argument("--parent")
    parser.add_argument("--rev", type=int)
    parser.add_argument("--done", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()
    run = run_id(args.session, args.job, args.recipe)
    os.umask(0o077)
    if args.action in ("load", "wait", "quiet"):
        path = args.root / "script-progress.sqlite"
        deadline = time.monotonic() + min(300, max(0, args.timeout))
        while (
            args.action == "quiet" and not path.exists() and time.monotonic() < deadline
        ):
            time.sleep(0.15)
        if not path.exists():
            if args.action != "load":
                raise ValueError("No checkpoint on this host")
            print(
                json.dumps(
                    dict(
                        rev=0,
                        digest=START,
                        done=False,
                        state=None,
                        delivery="none",
                        peerPulse=None,
                    )
                )
            )
            return
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
        db.row_factory = sqlite3.Row
    else:
        db = connect(args.root)
    try:
        if args.action == "pulse":
            pulse_until_eof(db, run)
            return
        if args.action == "save":
            state = sys.stdin.buffer.read(MAX_BYTES + 1)
            if len(state) > MAX_BYTES or not args.parent or not args.rev:
                raise ValueError("Expected bounded stdin, --parent and --rev")
            f = dict(
                run=run,
                rev=args.rev,
                parent=args.parent,
                done=args.done,
                state=base64.b64encode(state).decode("ascii"),
                digest=fingerprint(run, args.rev, args.parent, args.done, state),
            )
            status = apply(db, f, "local")
            if status != "stored":
                raise ValueError("Checkpoint not committed: " + status)
        if args.action == "wait":
            if (
                not args.parent
                or not HEX.fullmatch(args.parent)
                or not 0 <= args.timeout <= 300
            ):
                raise ValueError("Expected --parent DIGEST and a bounded timeout")
            until = time.monotonic() + args.timeout
            while True:
                row = db.execute(
                    "SELECT delivery,rev FROM records WHERE run=? AND digest=?",
                    (run, args.parent),
                ).fetchone()
                if not row:
                    raise ValueError("Unknown checkpoint")
                conflict = db.execute(
                    "SELECT 1 FROM records WHERE run=? AND rev<=? AND delivery='conflict' LIMIT 1",
                    (run, row["rev"]),
                ).fetchone()
                if conflict:
                    raise ValueError("Divergent checkpoint; nothing replayed")
                if row["delivery"] == "paired":
                    break
                if time.monotonic() >= until:
                    raise TimeoutError("Peer has not acknowledged this checkpoint")
                time.sleep(0.1)
            print(json.dumps(dict(digest=args.parent, delivery="paired")))
            return
        if args.action == "quiet":
            if not 1000 <= args.quiet_ms <= 120000 or not 1 <= args.timeout <= 300:
                raise ValueError("Invalid standby timeout")
            stamp = None
            changed = time.monotonic()
            while True:
                info = current(db, run)
                if info["delivery"] == "conflict":
                    raise ValueError("Divergent computation; do not replay")
                pulse = db.execute(
                    "SELECT token,seq FROM peer_pulses WHERE run=?", (run,)
                ).fetchone()
                observed = (info["digest"], tuple(pulse) if pulse else None)
                now = time.monotonic()
                if observed != stamp:
                    stamp = observed
                    changed = now
                if info["delivery"] == "paired" and (
                    info["done"] or (now - changed) * 1000 >= args.quiet_ms
                ):
                    info["peerPulse"] = dict(pulse) if pulse else None
                    print(json.dumps(info))
                    return
                if now >= deadline:
                    raise TimeoutError(
                        "No quiet, acknowledged checkpoint; not authorized to replay"
                    )
                time.sleep(0.15)
        info = current(db, run)
        if args.action == "load":
            pulse = db.execute(
                "SELECT token,seq FROM peer_pulses WHERE run=?", (run,)
            ).fetchone()
            info["peerPulse"] = dict(pulse) if pulse else None
        if args.action == "save":
            # A stale producer may be retrying a previous ACK. Never hand it another
            # writer's newer state as if it were the state it just committed.
            if info["digest"] != f["digest"]:
                raise ValueError("A later checkpoint exists; reload before continuing")
            del info["state"]
        print(json.dumps(info))
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TimeoutError, sqlite3.Error, OSError) as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
