"""Exercise real files and SQLite, not mocked merge decisions."""

from pathlib import Path
from contextlib import ExitStack, closing
import os
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / "lib/task-sync"
sys.path.insert(0, str(LIB))
from source_sync import Journal, authorize, digest
from source_exchange import inventory, support


class SourceTest(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.base = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.key = digest(b"desktop:test")
        self.js = []
        self.roots = []
        for host in ["desktop", "cloud"]:
            root = self.base / host
            project = root / "project"
            (project / "src").mkdir(parents=True)
            authorize(root, self.key, project, ["src"])
            self.js.append(stack.enter_context(closing(Journal(root, self.key))))
            self.roots.append(root)
        self.a, self.b = self.js

    def send(self, a, b):
        a.scan()
        b.scan()
        epoch = a.fence()["epoch"]
        rows = a.page(b.fence()["received"])
        b.accept(epoch, rows)
        b.scan()

    def sync(self):
        for _ in range(2):
            self.send(self.a, self.b)
            self.send(self.b, self.a)

    def file(self, j):
        return j.path / "src/demo.py"

    def seed(self):
        self.file(self.a).write_bytes(b"a\nb\nc\nd\ne\nf\n")
        self.sync()

    def test_creation_edit_deletion_and_offline_history(self):
        self.seed()
        a, b = map(self.file, self.js)
        for value in [b"one\n", b"two\n", b"three\n"]:
            a.write_bytes(value)
            self.a.scan()
        self.assertNotEqual(a.read_bytes(), b.read_bytes())
        self.sync()
        self.assertEqual(b.read_bytes(), b"three\n")
        self.assertTrue(
            all(
                self.b.db.execute(
                    "SELECT 1 FROM versions WHERE data=?", (v,)
                ).fetchone()
                for v in [b"one\n", b"two\n"]
            )
        )
        b.unlink()
        self.sync()
        self.assertFalse(a.exists())
        self.assertTrue(self.a.fence()["ready"])

    def test_bidirectional_non_overlapping_merge(self):
        self.seed()
        a, b = map(self.file, self.js)
        a.write_bytes(a.read_bytes().replace(b"a", b"left"))
        b.write_bytes(b.read_bytes().replace(b"f", b"right"))
        self.sync()
        self.assertEqual(a.read_bytes(), b"left\nb\nc\nd\ne\nright\n")
        self.assertEqual(b.read_bytes(), a.read_bytes())
        self.assertTrue(self.b.fence()["ready"])

    def test_conflict_survives_restart_and_resolution(self):
        self.seed()
        a, b = map(self.file, self.js)
        a.write_bytes(b"left")
        b.write_bytes(b"right")
        self.sync()
        self.assertEqual(a.read_bytes(), b"left")
        self.assertEqual(b.read_bytes(), b"right")
        self.assertFalse(self.a.fence()["ready"])
        heads = [r[0] for r in self.a.db.execute("SELECT id FROM heads")]
        a.write_bytes(b"human")
        subprocess.run(
            [
                sys.executable,
                str(LIB / "source_sync.py"),
                "resolve",
                str(self.roots[0]),
                self.key,
                "src/demo.py",
                *heads,
            ],
            check=True,
            stdout=subprocess.PIPE,
        )
        self.sync()
        self.assertEqual(b.read_bytes(), b"human")
        self.assertTrue(self.a.fence()["ready"])

    def test_lost_ack_and_out_of_order(self):
        self.seed()
        self.file(self.a).write_bytes(b"x")
        self.a.scan()
        row = self.a.page(self.b.fence()["received"])
        epoch = self.a.fence()["epoch"]
        self.assertRaises(
            ValueError, self.b.accept, epoch, [[row[0][0] + 1, *row[0][1:]]]
        )
        self.assertEqual(self.b.accept(epoch, row), self.b.accept(epoch, row))
        self.b.scan()
        self.assertEqual(self.file(self.b).read_bytes(), b"x")

    def test_recover_after_rename_before_replacement(self):
        self.seed()
        name = "src/demo.py"
        old = self.b.disk(name)
        self.file(self.a).write_bytes(b"remote")
        self.a.scan()
        self.b.accept(self.a.fence()["epoch"], self.a.page(self.b.fence()["received"]))
        target = self.a.disk(name)
        self.b.db.execute("INSERT INTO plans VALUES (?,?,?)", (name, old, target))
        hold = self.file(self.b).with_name(".dsh-source-" + target + ".hold")
        self.file(self.b).rename(hold)
        with closing(Journal(self.roots[1], self.key)) as restarted:
            restarted.scan()
            self.assertTrue(restarted.fence()["ready"])
        self.assertEqual(self.file(self.b).read_bytes(), b"remote")
        self.assertFalse(hold.exists())

    def test_changed_during_apply_is_not_overwritten(self):
        self.seed()
        name = "src/demo.py"
        old = self.b.disk(name)
        self.file(self.a).write_bytes(b"peer")
        self.a.scan()
        target = self.a.disk(name)
        self.b.accept(self.a.fence()["epoch"], self.a.page(self.b.fence()["received"]))
        self.b.db.execute("INSERT INTO plans VALUES (?,?,?)", (name, old, target))
        self.file(self.b).write_bytes(b"editor")
        self.b.scan()
        self.assertEqual(self.file(self.b).read_bytes(), b"editor")
        self.assertFalse(self.b.fence()["ready"])

    def test_whole_project_picks_up_new_source_directories_not_profile_or_dependencies(
        self,
    ):
        project = self.base / "nested" / "app"
        project.mkdir(parents=True)
        root = self.base / "auto"
        k = digest(b"desktop:auto")
        self.assertRaises(ValueError, authorize, root, k, project, ["*"])
        (project / "package.json").write_text("{}")
        authorize(root, k, project, ["*"])
        with closing(Journal(root, k)) as j:
            j.scan()
            (project / "ui").mkdir()
            (project / "ui" / "view.ts").write_text("hello")
            (project / "node_modules").mkdir()
            (project / "node_modules" / "omit.ts").write_text("omit")
            j.scan()
            self.assertEqual({r[2] for r in j.page(0)}, {"package.json", "ui/view.ts"})

    def test_delete_modify_conflict(self):
        self.seed()
        self.file(self.a).unlink()
        self.file(self.b).write_bytes(b"keep mine")
        self.sync()
        self.assertFalse(self.a.fence()["ready"])
        self.assertFalse(self.file(self.a).exists())
        self.assertEqual(self.file(self.b).read_bytes(), b"keep mine")

    def test_ignore_and_no_unbound_remote_paths(self):
        subprocess.run(["git", "init", "-q", str(self.a.path)], check=True)
        (self.a.path / ".gitignore").write_bytes(b"src/private.py\n")
        for n in ["private.py", ".env", "secret-data.js", "ok.py"]:
            (self.a.path / "src" / n).write_bytes(b"hi")
        self.sync()
        self.assertEqual([p.name for p in (self.b.path / "src").iterdir()], ["ok.py"])
        root = self.base / "unbound"
        root.mkdir()
        support(root, "cloud", inventory(self.roots[0]))
        self.assertEqual(inventory(root), {})


if __name__ == "__main__":
    unittest.main()
