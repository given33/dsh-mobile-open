"""Per-host driver for a disposable Windows↔Linux power-loss test; no access to real task ledgers."""

import argparse
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys

SOURCE = """def compute(buf, depth):
    if depth:
        child = compute(buf, depth-1)
        return child + depth
    inner = buf
    n = 0
    while n < 18:
        n += 1
    work = sum(range(450000000))
    inner[0] += work % 19
    return sum(inner)

buf = [3, 5, 7, 11]
mirror = buf
for row in range(5):
    for col in range(9):
        k = (row + col) % 4
        mirror[k] = (buf[k] * 5 + row + col) % 100003
        if row == 2 and col == 4:
            delta = compute(mirror, 2)
            buf[k] += delta % 19
print(buf)
"""


def instrument(runner, argv):
    # Observe CPython line events without changing the user's program or introducing an artificial wait.
    busy = SOURCE.splitlines().index("    work = sum(range(450000000))") + 1

    def trace(frame, event, arg):
        if event == "line" and frame.f_code.co_filename == "<checkpoint-assignment>":
            if frame.f_lineno == busy:
                Path("inside-cpu-step").touch(exist_ok=False)
            elif frame.f_lineno == busy + 1:
                Path("past-cpu-step").touch(exist_ok=False)
        return trace

    sys.argv = [str(runner), *argv]
    sys.settrace(trace)
    runpy.run_path(str(runner), run_name="__main__")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--trace-runner":
        instrument(Path(sys.argv[2]), sys.argv[3:])
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("runner", type=Path)
    parser.add_argument("role", choices=["primary", "standby"])
    parser.add_argument("session")
    a = parser.parse_args()
    ws = a.workspace.resolve()
    ws.mkdir(parents=True, exist_ok=False)
    src = ws / "untouched.py"
    src.write_text(SOURCE, encoding="utf8", newline="\n")
    root = ws / "state"
    runner = a.runner.resolve()
    cmd = [sys.executable, "-I", "-B"]
    if a.role == "primary":
        cmd.extend([__file__, "--trace-runner"])
    cmd.extend(
        [
            str(runner),
            a.role,
            str(src),
            "--root",
            str(root),
            "--session",
            a.session,
            "--job",
            "arrays",
            "--interval",
            "16",
            "--quiet-ms",
            "4500",
            "--timeout",
            "120",
        ]
    )
    with (ws / "output").open("w") as out, (ws / "errors").open("w") as err:
        child = subprocess.Popen(
            cmd, cwd=ws, stdin=subprocess.DEVNULL, stdout=out, stderr=err
        )
        try:
            for line in sys.stdin:
                action = json.loads(line)
                if action == "end":
                    break
                if action == "cut":
                    assert (
                        a.role == "primary"
                        and child.poll() is None
                        and (ws / "inside-cpu-step").exists()
                        and not (ws / "past-cpu-step").exists()
                    )
                    child.kill()
                    assert (
                        child.wait(timeout=6) != 0
                        and not (ws / "past-cpu-step").exists()
                    )
                    value = True
                elif action == "status":
                    value = {
                        "busy": (ws / "inside-cpu-step").exists()
                        and not (ws / "past-cpu-step").exists(),
                        "exit": child.poll(),
                    }
                    if child.returncode == 0:
                        value["report"] = json.loads((ws / "output").read_bytes())
                    elif child.returncode is not None:
                        value["error"] = (ws / "errors").read_text(errors="replace")[
                            -900:
                        ]
                    dbfile = root / "script-progress.sqlite"
                    if dbfile.exists():
                        with sqlite3.connect(
                            dbfile.resolve().as_uri() + "?mode=ro", uri=True, timeout=4
                        ) as db:
                            tables = db.execute(
                                "select name from sqlite_master where name='tips'"
                            ).fetchone()
                            row = (
                                db.execute(
                                    "select r.state,r.rev,r.delivery,r.digest from tips t join records r using(run,rev)"
                                ).fetchone()
                                if tables
                                else None
                            )
                            if row:
                                state = json.loads(row[0])
                                frames = state["stack"] + [state]
                                module = frames[0]["names"]
                                active = state["names"]
                                value["tip"] = {
                                    "rev": row[1],
                                    "delivery": row[2],
                                    "digest": row[3],
                                    "steps": state["steps"],
                                    "pc": state["pc"],
                                    "cursors": sum(len(f["ranges"]) for f in frames),
                                    "callDepth": len(state["stack"]),
                                    "aliased": bool(state["heap"])
                                    and "buf" in module
                                    and module["buf"]
                                    == module.get("mirror")
                                    == active.get("buf")
                                    == active.get("inner"),
                                }
                else:
                    raise ValueError("Unknown fixture action")
                print(json.dumps(value), flush=True)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)


if __name__ == "__main__":
    main()
