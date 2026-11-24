from pathlib import Path
import tempfile, subprocess, sys, json, shlex, uuid, re, tarfile, time
import argparse

parser = argparse.ArgumentParser(
    description="Run two isolated failover tests using an existing verified SSH alias for a Linux user with CPython 3.11. No sudo or production configuration."
)
parser.add_argument("--ssh-host", required=True)
host = parser.parse_args().ssh_host
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", host):
    parser.error("Expected a configured SSH alias")
base = Path(__file__).resolve().parents[2]
driver = "test/e2e/auto_python_checkpoint.py"
lib = "lib/task-sync/"
ssh = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    host,
]
sys.path.insert(0, str(base / lib))
import transfer

sys.path.insert(0, str(base / "test/e2e"))
from auto_python_checkpoint import SOURCE

ref = subprocess.check_output([sys.executable, "-I", "-c", SOURCE], text=True).strip()
print("Plain CPython reference:", ref, flush=True)
remote = subprocess.check_output(
    ssh + ["mktemp -d /tmp/dsh-state-qa.XXXXXXXX"], text=True
).strip()
assert re.fullmatch(r"/tmp/dsh-state-qa\.[A-Za-z0-9]{8}", remote)
launch = "cd /tmp && exec "
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
    t = Path(temp)
    bundle = t / "files.tar"
    with tarfile.open(bundle, "w") as f:
        for name in [
            driver,
            *[
                lib + x
                for x in [
                    "python_state.py",
                    "paired_python.py",
                    "script_progress.py",
                    "transfer.py",
                ]
            ],
        ]:
            f.add(base / name, name)
    subprocess.run(
        ["scp", "-q", *ssh[2:-1], str(bundle), host + ":" + remote + "/"], check=True
    )
    subprocess.run(ssh + [f"cd {remote} && tar xf files.tar"], check=True)
    for origin in ["desktop", "cloud"]:
        dest = "cloud" if origin == "desktop" else "desktop"
        sid = uuid.uuid4().hex
        lws = t / origin
        rws = remote + "/" + origin
        p = {}
        wire = None

        def ctl(role, arg):
            q = p[role]
            q.stdin.write(json.dumps(arg) + "\n")
            q.stdin.flush()
            return json.loads(q.stdout.readline())

        def connect():
            w = subprocess.Popen(
                ssh
                + [
                    launch
                    + shlex.join(
                        [
                            "/usr/bin/python3.11",
                            "-B",
                            remote + "/" + lib + "transfer.py",
                            "--peer",
                            rws + "/state",
                            "progress-v1",
                        ]
                    )
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )
            assert "progress-v1" in transfer.receive(w.stdout)
            return w

        def cutwire():
            transfer.send(wire.stdin, ["end"])
            wire.stdin.close()
            assert wire.wait(timeout=10) == 0

        def sync():
            transfer.exchange_progress(lws / "state", wire.stdout, wire.stdin, True)

        try:
            local = [
                sys.executable,
                "-I",
                "-B",
                str(base / driver),
                str(lws),
                str(base / lib / "paired_python.py"),
                "primary" if origin == "desktop" else "standby",
                sid,
            ]
            cloud = [
                "/usr/bin/python3.11",
                "-I",
                "-B",
                remote + "/" + driver,
                rws,
                remote + "/" + lib + "paired_python.py",
                "primary" if origin == "cloud" else "standby",
                sid,
            ]
            for name, cmd in [
                ("desktop", local),
                ("cloud", ssh + [launch + shlex.join(cloud)]),
            ]:
                p[name] = subprocess.Popen(
                    cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
                )
            for role in p:
                assert ctl(role, "status")["exit"] is None
            wire = connect()
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                sync()
                s = ctl(origin, "status")
                assert s["exit"] is None, s
                if s["busy"]:
                    break
                time.sleep(0.07)
            assert s["busy"], s
            peer = ctl(dest, "status")
            seed = peer["tip"]
            assert (
                seed["delivery"] == "paired"
                and seed["aliased"]
                and seed["cursors"] == 2
                and seed["callDepth"] == 3
                and seed["steps"] > 16
                and seed["pc"] >= 0
            ), peer
            cutwire()
            wire = None
            assert ctl(origin, "cut")
            for _ in range(200):
                d = ctl(dest, "status")
                if d["exit"] is not None:
                    break
                time.sleep(0.15)
            assert d["exit"] == 0, d
            report = d["report"]
            assert (
                report["restoredSteps"] == seed["steps"]
                and report["totalSteps"] > seed["steps"]
                and report["delivery"] == "local"
                and report["result"] == ref
            ), report
            wire = connect()
            deadline = time.monotonic() + 100
            while time.monotonic() < deadline:
                sync()
                s = ctl(origin, "status")
                d = ctl(dest, "status")
                if (
                    s["tip"]["digest"] == d["tip"]["digest"]
                    and s["tip"]["delivery"] == d["tip"]["delivery"] == "paired"
                ):
                    break
            assert (
                s["tip"]["digest"] == d["tip"]["digest"]
                and s["tip"]["pc"] == -1
                and d["tip"]["delivery"] == "paired"
            )
            print(
                json.dumps(
                    {
                        "from": origin,
                        "to": dest,
                        "cutInsideNativeCPU": True,
                        "seed": seed,
                        "terminal": report,
                        "returnedEqualDigest": True,
                    }
                ),
                flush=True,
            )
        finally:
            if wire and wire.poll() is None:
                try:
                    cutwire()
                except (OSError, subprocess.TimeoutExpired):
                    wire.kill()
                    wire.wait()
            for q in p.values():
                if q.poll() is None:
                    q.stdin.write('"end"\n')
                    q.stdin.close()
                    q.wait(timeout=20)
