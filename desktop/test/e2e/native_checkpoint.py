"""Same native DSH session: pre-armed receiver finishes an in-progress independent npm build
and the remaining model round after the original UI, worker and transport all disappear.
Run with an isolated DSH CLI path and plugin tgz. Never uses a production model or profile.
"""

import argparse
import base64
import hashlib
import re
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from checkpoint_build import SCRIPT

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib/task-sync"))
from offline_cloud_turn import Host, exchange, wait


def test(root, cli, package, origin):
    target = "cloud" if origin == "desktop" else "desktop"
    hosts = {}
    worker = None
    finished = threading.Event()
    sdk_seen = []
    waiting = threading.Event()
    digest = hashlib.sha256(b"dsh-script-recipe/v1:")
    adapter = Path(__file__).resolve().parents[2] / "tools/computation-slice.mjs"
    for part in (SCRIPT.encode(), adapter.read_bytes(), b'["North","East","West"]', b"html-v1"):
        digest.update(str(len(part)).encode() + b":" + part)
    recipe = digest.hexdigest()

    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            tools = {t["name"] for t in req.get("tools", [])}
            role = self.path.split("/")[1]
            tool = None
            args = {}
            text = "Fixture"
            if "relay_remaining_task" in tools:
                history = json.dumps(req["messages"], ensure_ascii=False)
                if role == origin:
                    tool = "relay_remaining_task"
                else:
                    info = seed = save = None
                    stored = False
                    for msg in req["messages"]:
                        for item in msg.get("content", []):
                            if (
                                not isinstance(item, dict)
                                or item.get("type") != "tool_result"
                            ):
                                continue
                            content = item.get("content", [])
                            for part in (
                                content if isinstance(content, list) else [content]
                            ):
                                raw = (
                                    part.get("text", "")
                                    if isinstance(part, dict)
                                    else part
                                )
                                record = re.search(
                                    r"DSH-QA-SAVE:([a-zA-Z0-9+/=]+)", raw
                                )
                                if record:
                                    save = json.loads(base64.b64decode(record[1]))
                                try:
                                    obj = json.loads(raw)
                                except (ValueError, TypeError):
                                    continue
                                if isinstance(obj, dict) and obj.get("handoff"):
                                    info = obj["scriptProgress"]
                                if (
                                    isinstance(obj, dict)
                                    and obj.get("kind") == "script-progress/v1"
                                ):
                                    if obj.get("done") and "state" not in obj:
                                        stored = True
                                    else:
                                        seed = obj
                    if stored:
                        text = "NATIVE-MODEL-FINISHED"
                        finished.set()
                    elif save:
                        tool = "relay_script_checkpoint"
                        args = save
                    elif not info:
                        tool = "relay_environment"
                    elif not seed:
                        tool = "relay_script_checkpoint"
                        args = dict(
                            action="quiet",
                            job="site",
                            recipe=recipe,
                            quietMs=4000,
                            timeout=60,
                        )
                        waiting.set()
                    elif not sdk_seen:
                        import shlex

                        sdk_seen.append(info["session"])
                        env = dict(
                            DSH_QA_SESSION=info["session"],
                            DSH_QA_SEED=base64.b64encode(
                                json.dumps(seed).encode()
                            ).decode(),
                        )
                        if os.name == "nt":
                            tool = "pwsh"
                            prefix = "".join(
                                "$env:" + k + "='" + v.replace("'", "''") + "'; "
                                for k, v in env.items()
                            )
                        else:
                            tool = "bash"
                            prefix = (
                                " ".join(
                                    k + "=" + shlex.quote(v) for k, v in env.items()
                                )
                                + " "
                            )
                        args = dict(
                            command=prefix + "npm run build",
                            description="Resume the prepared static site build",
                            timeoutMs=90000,
                        )
                    else:
                        text = "NATIVE-BUILD-FAILED"
                        print(
                            "Receiver fixture error:",
                            str(req["messages"][-1])[-1200:],
                            flush=True,
                        )
                        finished.set()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def emit(k, **data):
                self.wfile.write(
                    (
                        "event: "
                        + k
                        + "\ndata: "
                        + json.dumps(dict(type=k, **data))
                        + "\n\n"
                    ).encode()
                )
                self.wfile.flush()

            emit(
                "message_start",
                message=dict(
                    id="qa",
                    type="message",
                    role="assistant",
                    model=req["model"],
                    content=[],
                    usage=dict(input_tokens=4, output_tokens=0),
                ),
            )
            if tool:
                emit(
                    "content_block_start",
                    index=0,
                    content_block=dict(
                        type="tool_use", id=uuid.uuid4().hex, name=tool, input={}
                    ),
                )
                emit(
                    "content_block_delta",
                    index=0,
                    delta=dict(type="input_json_delta", partial_json=json.dumps(args)),
                )
            else:
                emit(
                    "content_block_start",
                    index=0,
                    content_block=dict(type="text", text=""),
                )
                emit(
                    "content_block_delta",
                    index=0,
                    delta=dict(type="text_delta", text=text),
                )
            emit("content_block_stop", index=0)
            emit(
                "message_delta",
                delta=dict(
                    stop_reason="tool_use" if tool else "end_turn", stop_sequence=None
                ),
                usage=dict(output_tokens=4),
            )
            emit("message_stop")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def control(msg):
        worker.stdin.write(json.dumps(msg) + "\n")
        worker.stdin.flush()
        line = worker.stdout.readline()
        if not line.strip():
            log = root / 'worker/build.log'
            raise RuntimeError(f'QA worker exit={worker.poll()}, response={line!r}, log=' + (log.read_text(errors='replace')[-600:] if log.is_file() else 'absent'))
        result = json.loads(line)
        if msg == 'status' and result.get('exit') not in (None, 0) and not result.get('mid'):
            raise RuntimeError(str(result))
        return result

    def pump():
        return exchange(
            hosts["desktop"], hosts["cloud"], "--mailbox", relay=True, progress=True
        )

    try:
        for r in (origin, target):
            h = Host(
                root / r,
                cli,
                package,
                "http://127.0.0.1:" + str(server.server_port) + "/" + r,
            )
            hosts[r] = h
            cfg = h.root / "profiles/web/cordis.patch.yml"
            cfg.write_text(
                cfg.read_text("utf8").replace(
                    "cloudTurns: true", "cloudTurns: true, turnRelay: true"
                ),
                encoding="utf8",
            )
            h.start()
        src, dst = hosts[origin], hosts[target]
        ws = root / "source"
        ws.mkdir()
        wid = src.rpc("workspace/create", {"path": str(ws)})["workspace"]["workspaceId"]
        sid = src.rpc("session/create", {"workspaceId": wid})["sessionId"]
        (ws / "package.json").write_text(
            json.dumps({"scripts": {"build": "node build.mjs"}})
        )
        (ws / "build.mjs").write_bytes(SCRIPT.encode())
        (ws / adapter.name).write_bytes(adapter.read_bytes())
        src.sync.mkdir(exist_ok=True)
        (src.sync / "relay-inputs.json").write_text(
            json.dumps({origin + ":" + wid: ["package.json", "build.mjs", adapter.name]})
        )
        sdk = Path(__file__).resolve().parents[2] / "tools/script-progress.mjs"
        worker = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(Path(__file__).with_name("checkpoint_build.py")),
                str(root / "worker"),
                str(sdk),
                "primary",
                sid,
                "--dsh-home",
                str(src.root),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        wait(lambda: pump() and control("status")["mid"], 35)
        src.prompt(
            sid,
            "Prepare the paired host to finish my replay-safe static site build and report the final result in this session.",
        )
        wait(lambda: next((src.sync / "relay-outgoing").glob("*.json"), None), 40)
        src.stop()
        wait(lambda: pump() and waiting.is_set(), 50)
        workspace = next((dst.sync / "workspaces").glob("*/build.mjs")).parent
        # Closing native DSH did not kill the independent job. Even a long quiet
        # build chunk must not cause duplicate computation while the pipe is live.
        end = time.monotonic() + 6
        while time.monotonic() < end:
            pump()
            assert not (workspace / "executed").exists()
            time.sleep(0.1)
        assert control("cut") and control("status")["steps"] == ["0"]
        # No pump, model RPC or recovery command to the peer until the model is done.
        if not finished.wait(24):
            page = json.loads(dst.page(sid))
            for item in page.get("items", []):
                ev = item.get("event", {})
                d = ev.get("data", {})
                msg = d.get("message", {})
                if ev.get("type") == "tool/result":
                    print("Fixture result:", str(msg.get("content"))[-900:])
            print(
                "fixture local files:",
                [f.name for f in workspace.iterdir()],
                "model runs:",
                len(sdk_seen),
                flush=True,
            )
            raise RuntimeError("Receiver model did not finish")
        assert sdk_seen == [sid], sdk_seen
        assert (workspace / "executed").read_text().splitlines() == ["1", "2"]
        assert (workspace / "site.html").read_text().splitlines() == [
            f'<article id="{i}">{v}</article>'
            for i, v in enumerate(["North", "East", "West"])
        ]
        wait(lambda: "NATIVE-MODEL-FINISHED" in dst.page(sid))
        print(
            origin
            + " -> "
            + target
            + ": primary killed mid-build; original native session used the peer checkpoint, completed the artifact and continued the model round.",
            flush=True,
        )
    finally:
        if worker and worker.poll() is None:
            worker.stdin.write('"end"\n')
            worker.stdin.close()
            worker.wait(timeout=12)
        for h in hosts.values():
            h.stop()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cli", type=Path)
    p.add_argument("package", type=Path)
    p.add_argument("--origin", choices=["desktop", "cloud"], default="desktop")
    a = p.parse_args()
    with tempfile.TemporaryDirectory(
        prefix="native-script-progress-", ignore_cleanup_errors=True
    ) as t:
        test(Path(t), a.cli.resolve(), a.package.resolve(), a.origin)
