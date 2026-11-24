"""Run an eligible, unmodified Python script with automatic paired memory checkpoints.
Both native commands must be authorized before failover; no commands are received over the wire.
"""

import argparse
import base64
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import time

# Allow `python -I .../paired_python.py` without loading anything from the task's cwd.
LIB = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB))
import python_state
import script_progress as progress


def ledger_command(action, args, program):
    return [
        sys.executable,
        "-I",
        "-B",
        str(LIB / "script_progress.py"),
        action,
        args.session,
        args.job,
        program.recipe,
        "--root",
        str(args.root),
    ]


@contextmanager
def heartbeat(args, program):
    with subprocess.Popen(
        ledger_command("pulse", args, program),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    ) as pulse:
        try:
            if pulse.stdout.readline().strip() != b"ready":
                raise RuntimeError("Local producer heartbeat not acquired")
            yield pulse
        finally:
            pulse.stdin.close()
            try:
                pulse.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pulse.kill()


def paired_barrier(db, run, tip, timeout):
    deadline = time.monotonic() + timeout if timeout else None
    while True:
        current = progress.current(db, run)
        if current["digest"] != tip["digest"] or current["delivery"] == "conflict":
            raise ValueError(
                "Another checkpoint or conflict exists; reload before proceeding"
            )
        if current["delivery"] == "paired":
            return
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                "Checkpoint is local only; no further statements were executed"
            )
        time.sleep(0.1)


def save(db, run, parent, machine):
    data = machine.snapshot()
    rev = parent["rev"] + 1
    done = machine.pc == -1
    if done:
        machine.final_text()  # A failing final expression must never create a success receipt.
    digest = progress.fingerprint(run, rev, parent["digest"], done, data)
    frame = dict(
        run=run,
        rev=rev,
        parent=parent["digest"],
        digest=digest,
        done=done,
        state=base64.b64encode(data).decode("ascii"),
    )
    status = progress.apply(db, frame, "local")
    if status != "stored":
        raise ValueError("Checkpoint not committed: " + status)
    tip = progress.current(db, run)
    if tip["digest"] != digest or tip["delivery"] == "conflict":
        raise ValueError("Local tip changed; reload before continuing")
    return tip


def seed_machine(program, tip):
    if tip["delivery"] == "conflict":
        raise ValueError("Divergent history; will not replay")
    machine = python_state.Machine.restore(
        program, base64.b64decode(tip["state"], validate=True)
    )
    if tip["done"] != (machine.pc == -1):
        raise ValueError("Terminal marker does not match saved instruction")
    return machine


def run(args):
    program = python_state.Program(args.script, args.interval)
    job = progress.run_id(args.session, args.job, program.recipe)
    standby = args.action == "standby"
    with closing(progress.connect(args.root)) as db:
        if standby:
            # Quiet detection is only an authorization to repeat pure computation. A slow producer
            # still sends heartbeats. An armed standby is not a five-minute shell timeout.
            stamp = None
            changed = time.monotonic()
            while True:
                tip = progress.current(db, job)
                if tip["delivery"] == "conflict":
                    raise ValueError("Divergent history; will not promote")
                pulse = db.execute(
                    "SELECT token,seq FROM peer_pulses WHERE run=?", (job,)
                ).fetchone()
                observed = (tip["digest"], tuple(pulse) if pulse else None)
                if observed != stamp:
                    stamp, changed = observed, time.monotonic()
                if tip["delivery"] == "paired" and (
                    tip["done"] or time.monotonic() - changed >= args.quiet_ms / 1000
                ):
                    break
                time.sleep(0.15)
        else:
            tip = progress.current(db, job)
        with heartbeat(args, program) as pulse:
            if progress.current(db, job)["digest"] != tip["digest"]:
                raise ValueError(
                    "Producer advanced during startup; reload before continuing"
                )
            return execute(db, job, program, tip, pulse, standby, args.timeout)


def execute(db, job, program, tip, pulse, standby, timeout):
    if tip["rev"]:
        machine = seed_machine(program, tip)
    else:
        machine = python_state.Machine(program)
        # Revision one contains the entry point; no application instruction runs until it is paired.
        tip = save(db, job, tip, machine)
    start_steps = machine.steps
    first_takeover_rev = tip["rev"] + 1
    while True:
        if pulse.poll() is not None:
            raise RuntimeError("Lost producer heartbeat")
        if standby and tip["rev"] >= first_takeover_rev:
            # Only an ACK for our own post-takeover work demonstrates renewed replication.
            receipt = db.execute(
                "SELECT delivery FROM records WHERE run=? AND rev=?",
                (job, first_takeover_rev),
            ).fetchone()
            if receipt and receipt["delivery"] == "paired":
                standby = False
        if not standby:
            paired_barrier(db, job, tip, timeout)
        if machine.pc == -1:
            break
        machine.advance()
        tip = save(db, job, tip, machine)
    final = progress.current(db, job)
    if final["delivery"] == "conflict" or final["digest"] != tip["digest"]:
        raise ValueError("Terminal checkpoint no longer agrees with ledger")
    return dict(
        recipe=program.recipe,
        delivery=final["delivery"],
        restoredSteps=start_steps,
        totalSteps=machine.steps,
        revision=tip["rev"],
        result=machine.final_text(),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["primary", "standby"])
    parser.add_argument("script", type=Path)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
        / "mobile-task-sync",
    )
    parser.add_argument("--session", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--interval", type=int, default=512)
    parser.add_argument(
        "--timeout",
        type=int,
        default=0,
        help="Peer ACK timeout in seconds (0: keep waiting)",
    )
    parser.add_argument("--quiet-ms", type=int, default=12000)
    args = parser.parse_args()
    if not 0 <= args.timeout <= 300 or not 1000 <= args.quiet_ms <= 120000:
        parser.error("Invalid timeout or quiet interval")
    os.umask(0o077)
    print(json.dumps(run(args)))


if __name__ == "__main__":
    main()
