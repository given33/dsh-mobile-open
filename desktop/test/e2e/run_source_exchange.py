"""Exercise the production wire protocol against an isolated paired host, not its live workspaces."""

from pathlib import Path
from contextlib import closing
import argparse
import re
import subprocess
import sys
import tempfile

LIB = Path(__file__).resolve().parents[2] / "lib/task-sync"
sys.path.insert(0, str(LIB))
from source_sync import authorize, digest, Journal
from source_exchange import exchange
from transfer import send, receive


def main(alias):
    if not re.fullmatch(r"[A-Za-z0-9][\w.-]*", alias):
        raise ValueError("Expected configured SSH alias")
    ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias]
    remote = (
        subprocess.check_output(ssh + ["mktemp -d /tmp/dsh-source-test.XXXXXXXX"])
        .decode()
        .strip()
    )
    if not re.fullmatch(r"/tmp/dsh-source-test\.[a-zA-Z0-9]{8}", remote):
        raise ValueError("Unexpected fixture root")

    def execute(code):
        return (
            subprocess.check_output(
                ssh + ["cd " + remote + " && /usr/bin/python3 -"], input=code.encode()
            )
            .decode()
            .strip()
        )

    try:
        for name in [
            "source_sync.py",
            "source_exchange.py",
            "project_inputs.py",
            "transfer.py",
        ]:
            subprocess.run(
                ["scp", "-q", *ssh[2:-1], str(LIB / name), alias + ":" + remote + "/"],
                check=True,
            )
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "mail"
            project = Path(td) / "project"
            (project / "src").mkdir(parents=True)
            ident = digest(b"desktop:test")
            authorize(root, ident, project, ["src"])
            file = project / "src/demo.py"
            prefix = (
                'from pathlib import Path\nfrom contextlib import closing\nfrom source_sync import Journal,keys\nimport json\nroot=Path("mail").resolve()\nkey="'
                + ident
                + '"\nfolder=root/"workspaces"/key\nf=folder/"src/demo.py"\n'
            )
            execute(
                prefix
                + 'folder.mkdir(parents=True); (root/"routes").mkdir(); (root/"routes"/(key+".json")).write_text(json.dumps(dict(owner="desktop",key="test")))'
            )

            def opened():
                proc = subprocess.Popen(
                    ssh
                    + [
                        "cd "
                        + remote
                        + ' && /usr/bin/python3 transfer.py --peer "$PWD/mail" sources-v1'
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                )
                assert "sources-v1" in receive(proc.stdout)[2:]
                return proc

            def pump(p):
                exchange(root, p.stdout, p.stdin, send, receive)

            def end(p):
                send(p.stdin, ["end"])
                p.stdin.close()
                assert p.wait(timeout=20) == 0

            p = opened()
            try:
                file.write_bytes(b"a\nb\nc\nd\ne\nf\n")
                pump(p)
                pump(p)
                assert execute(prefix + "print(f.read_text().splitlines()[0])") == "a"
                file.write_bytes(file.read_bytes().replace(b"a", b"win"))
                subprocess.run(
                    [
                        sys.executable,
                        str(LIB / "source_sync.py"),
                        "mark",
                        str(root),
                        ident,
                        "session-qa",
                        "tool-qa",
                        "returned",
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                )
                # Drop the connection without sending the new version. Both sides keep working.
                p.kill()
                p.wait()
                execute(
                    prefix
                    + 'f.write_bytes(f.read_bytes().replace(b"f",b"linux"))\nwith closing(Journal(root,key)) as j: j.scan()'
                )
                p = opened()
                pump(p)
                pump(p)
                assert file.read_bytes() == b"win\nb\nc\nd\ne\nlinux\n"
                assert (
                    execute(
                        prefix
                        + """with closing(Journal(root,key)) as j:
 print(f.read_bytes().hex(),j.db.execute("SELECT count(*) FROM versions WHERE path LIKE ':step/%'").fetchone()[0])"""
                    )
                    == file.read_bytes().hex() + " 1"
                )
                file.write_bytes(b"local conflict")
                execute(prefix + 'f.write_bytes(b"cloud conflict")')
                pump(p)
                pump(p)
                with closing(Journal(root, ident)) as j:
                    assert (
                        j.fence()["conflicts"] == ["src/demo.py"]
                        and not j.fence()["ready"]
                    )
                assert execute(prefix + "print(f.read_text())") == "cloud conflict"
                assert file.read_text() == "local conflict"
                end(p)
                print(
                    "Windows + remote Linux: native peer handshake; saved file replicated; SSH disconnected; offline changes merged both ways; tool boundary delivered; overlapping edits retained and handoff blocked."
                )
            finally:
                if p.poll() is None:
                    p.kill()
                    p.wait()
    finally:
        # Remove only the random private fixture created above.
        execute(
            "import shutil,os\nfrom pathlib import Path\np=Path.cwd().resolve()\nassert p==Path("
            + repr(remote)
            + ') and p.parent==Path("/tmp")\nos.chdir("/tmp");shutil.rmtree(str(p))'
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-host", required=True)
    main(parser.parse_args().ssh_host)
