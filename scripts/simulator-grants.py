"""Join two disposable official UI test hosts using the real grant verifier."""
import json
import runpy
import sys
import time
from pathlib import Path

scratch = Path(sys.argv[1])
cloud = scratch / "cloud-home/mobile-link"
local = Path(json.loads((scratch / "host.json").read_text())["home"]) / "mobile-link"
port = int(json.loads((scratch / "cloud/host.json").read_text())["port"])
policy = json.loads((cloud / "family-policy.json").read_text())
route = dict(policy, endpoint=f"relay-fixture.dsh-cloud.sslip.io:{port}", displayName="模拟云服务器")
(local / "family-route.json").write_text(json.dumps(route))
transfer = runpy.run_path(str(Path(__file__).resolve().parents[1] / "desktop/lib/task-sync/transfer.py"))
while True:
    if (local / "devices.json").exists():
        transfer["accept_verifiers"](cloud, transfer["verifier_manifest"](local))
    time.sleep(0.2)
