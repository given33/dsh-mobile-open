"""Return delivery invariants (no DSH process required)."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPERS = Path(__file__).resolve().parents[1] / "lib/task-sync"
sys.path.insert(0, str(HELPERS))
import result_delivery as mailbox


class ResultMailbox(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.workspace = self.root / "project"
        self.workspace.mkdir()
        self.db = mailbox.database(self.root)
        self.addCleanup(self.db.close)
        self.key = "a" * 64
        self.names = ["reports/build.txt", "artifacts/run.json"]
        self.policy = self.root / "relay-outputs.json"
        route = "desktop:sample"
        self.policy.write_text(json.dumps({route: self.names}))
        self.session = "1" * 64
        self.grant = dict(
            names=self.names,
            route=route,
            folder=str(self.workspace),
            owner="desktop",
            session=self.session,
        )
        mailbox.register(self.db, self.root, self.key, self.grant)
        files = [
            dict(
                name=n,
                bytes=base64.b64encode(n.encode()).decode(),
                digest=hashlib.sha256(n.encode()).hexdigest(),
            )
            for n in self.names
        ]
        self.body = json.dumps(dict(id=self.key, files=files))

    def accept(self, body=None):
        return mailbox.accept(
            self.db, self.root, "desktop", self.key, body or self.body
        )

    def status(self):
        return mailbox.inspect_local("status", self.root, "desktop", [])[0]["status"]

    def test_resume_after_receipt_before_write_and_lost_ack(self):
        digest = self.accept()
        self.assertEqual(self.status(), "received")
        with self.db:
            self.db.execute(
                "UPDATE grants SET created=0"
            )  # a long offline interval isn't a failed task
        self.assertEqual(
            mailbox.receipts_for(self.db, "desktop", [self.key]), {self.key: digest}
        )
        mailbox.deliver(self.db, self.root, "desktop")
        self.assertEqual(self.status(), "delivered")
        self.assertEqual(self.accept(), digest)
        stamp = (self.workspace / self.names[0]).stat().st_mtime_ns
        mailbox.deliver(self.db, self.root, "desktop")
        self.assertEqual((self.workspace / self.names[0]).stat().st_mtime_ns, stamp)
        for name in self.names:
            self.assertEqual((self.workspace / name).read_bytes(), name.encode())

        def query(session):
            return json.loads(
                subprocess.check_output(
                    [
                        sys.executable,
                        "-I",
                        str(HELPERS / "result_delivery.py"),
                        "session-status",
                        str(self.root),
                        session,
                    ],
                    input=b'{"owner":"desktop"}',
                )
            )

        self.assertEqual(query("2" * 64), [])
        self.assertEqual(query(self.session)[0]["status"], "delivered")

    def test_conflict_keeps_user_bytes_and_can_export_to_new_directory(self):
        self.accept()
        file = self.workspace / self.names[-1]
        file.parent.mkdir()
        file.write_bytes(b"local edit")
        mailbox.deliver(self.db, self.root, "desktop")
        self.assertEqual(self.status(), "conflict")
        self.assertEqual(file.read_bytes(), b"local edit")
        self.assertFalse((self.workspace / self.names[0]).exists())
        recovered = self.root / "new"
        mailbox.inspect_local(
            "recover", self.root, "desktop", [self.key, str(recovered)]
        )
        for name in self.names:
            self.assertEqual((recovered / name).read_bytes(), name.encode())
        with self.assertRaises(FileExistsError):
            mailbox.inspect_local(
                "recover", self.root, "desktop", [self.key, str(recovered)]
            )

    def test_workspace_replaced_or_policy_revoked_after_receipt(self):
        self.accept()
        self.workspace.rename(self.root / "old-project")
        self.workspace.mkdir()
        mailbox.deliver(self.db, self.root, "desktop")
        self.assertEqual(self.status(), "conflict")
        self.assertFalse(list(self.workspace.iterdir()))

    def test_no_undeclared_traversal_or_forged_receipts(self):
        with self.assertRaises(ValueError):
            mailbox.accept(self.db, self.root, "cloud", self.key, self.body)
        with self.assertRaises(ValueError):
            self.accept(self.body.replace("reports/build.txt", "../other/file"))
        with self.assertRaises(ValueError):
            self.accept(self.body.replace('digest": "', 'digest": "1', 1))
        self.policy.unlink()
        self.assertFalse(mailbox.inventory(self.db, self.root, "desktop")["want"])
        with self.assertRaises(ValueError):
            self.accept()
        self.assertEqual(self.status(), "waiting")
        for names in [
            ["dist/NUL.txt"],
            ["../file.txt"],
            ["reports/1.txt", "reports/1.txt/x.json"],
            ["reports/passwords.json"],
        ]:
            self.assertFalse(mailbox.names_ok(names))

    def test_existing_hardlink_is_not_a_destination(self):
        self.accept()
        original = self.root / "other"
        original.write_bytes(b"keep")
        file = self.workspace / self.names[0]
        file.parent.mkdir()
        os.link(original, file)
        mailbox.deliver(self.db, self.root, "desktop")
        self.assertEqual(self.status(), "conflict")
        self.assertEqual(original.read_bytes(), b"keep")

    def test_incomplete_turn_gets_no_files_or_success_claim(self):
        message = {"id": self.key, "outcome": "turn-not-completed"}
        mailbox.save_export(self.db, self.key, "desktop", message)
        with self.assertRaises(ValueError):
            mailbox.acknowledge(self.db, self.key, "desktop", "b" * 64)
        body = mailbox.read_export(self.db, self.key, "desktop")
        digest = self.accept(body)
        self.assertEqual(self.status(), "unavailable")
        self.assertFalse(list(self.workspace.iterdir()))
        with self.assertRaises(ValueError):
            self.accept()
        mailbox.acknowledge(self.db, self.key, "desktop", digest)
        self.assertFalse(mailbox.inventory(self.db, self.root, "cloud")["have"])


if __name__ == "__main__":
    unittest.main()
