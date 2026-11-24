"""Exercise real files and SQLite, not mocked merge decisions."""

from pathlib import Path
from contextlib import ExitStack, closing
import os
import json
from unittest.mock import patch
import shutil
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / "lib/task-sync"
sys.path.insert(0, str(LIB))
from source_sync import Journal, authorize, digest, allowed, disable, ScopeChangeError
from source_backup import backup
from source_exchange import inventory, support, exchange
from transfer import send, receive


class CloudLayoutTest(unittest.TestCase):
    def test_renamed_transfer_supports_source_binding_and_peer(self):
        with tempfile.TemporaryDirectory() as tmp:
            install = Path(tmp)
            for name in ("source_sync.py", "source_exchange.py", "project_inputs.py", "source_backup.py"):
                shutil.copyfile(LIB / name, install / name)
            shutil.copyfile(LIB / "transfer.py", install / "task-transfer.py")

            def run(*args, stdin=b""):
                # Ignore PYTHONPATH and skip site packages; only the deployed siblings are available.
                result = subprocess.run([sys.executable, "-E", "-S", *args], cwd=install,
                                        input=stdin, capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout

            root, project = install / "state", install / "project"
            project.mkdir()
            (project / "package.json").write_text("{}")
            key = digest(b"cloud-layout")
            grant = root / "source-grants" / (key + ".json")
            run("source_sync.py", "auto-bind", root, key, project)
            auto = json.loads(grant.read_bytes())
            self.assertIs(auto.pop("auto"), True)
            run("source_sync.py", "bind", root, key, project, "*")
            self.assertEqual(json.loads(grant.read_bytes()), auto)
            if os.name == "posix":
                self.assertEqual(grant.stat().st_mode & 0o777, 0o600)

            hello = run("task-transfer.py", "--peer", root, "sources-v1", stdin=b'["end"]\n')
            self.assertIn("sources-v1", json.loads(hello))


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

    def test_private_git_history_only_includes_applied_granted_sources(self):
        self.seed()
        (self.b.path / "src/secret.py").write_text("excluded")
        (self.b.path / "outside.txt").write_text("excluded")
        self.b.scan()
        epoch = self.a.fence()["epoch"]
        def archive():
            return backup(self.roots[1], self.key, self.b, epoch, self.a.fence()["seq"], allowed)["gitCommit"]
        repo = self.roots[1] / "source-backups" / (self.key + ".git")
        def git(*args):
            return subprocess.check_output(["git", "--git-dir=" + str(repo), *args])
        assert "gitCommit" not in backup(self.roots[1], self.key, self.b, "0" * 32, 0, allowed)
        first = archive()
        self.assertEqual(archive(), first)
        self.assertEqual(git("ls-tree", "-r", "--name-only", "HEAD").splitlines(), [b"src/demo.py"])
        self.assertFalse(git("remote"))
        self.file(self.a).unlink(); self.sync()
        second = archive()
        self.assertNotEqual(first, second)
        self.assertEqual(git("rev-parse", "HEAD^" ).decode().strip(), first)
        self.assertFalse(git("ls-tree", "-r", "--name-only", "HEAD"))
        self.assertEqual(git("show", first + ":src/demo.py"), b"a\nb\nc\nd\ne\nf\n")

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

    def test_auto_bind_skips_protected_roots_even_with_project_markers(self):
        home = self.base / "profile"
        mail = self.base / "mail"
        protected = [home, home / "Desktop", home / "Documents", home / "Downloads",
                     home / ".codex" / "nested", home / ".hidden", self.base / "empty"]
        for path in protected:
            path.mkdir(parents=True, exist_ok=True)
            if path.name != "empty":
                (path / "package.json").write_text("{}")
        with patch.object(Path, "home", return_value=home):
            for path in [*protected, Path(home.anchor)]:
                with self.subTest(path=path):
                    authorize(mail, self.key, path, ["*"], auto=True)
                    self.assertEqual(inventory(mail), {})

    def test_auto_bind_does_not_follow_project_alias(self):
        project = self.base / "dedicated"
        project.mkdir()
        (project / "package.json").write_text("{}")
        alias = self.base / "alias"
        if os.name == "nt":
            subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(alias), str(project)],
                           check=True, stdout=subprocess.PIPE)
        else:
            alias.symlink_to(project, target_is_directory=True)
        root = self.base / "mail"
        authorize(root, self.key, alias, ["*"], auto=True)
        self.assertEqual(inventory(root), {})

    def test_auto_source_exchange_and_original_scope_only_resume(self):
        root, cloud = self.base / "pc-mail", self.base / "peer-mail"
        project = self.base / "nested" / "app"
        project.mkdir(parents=True)
        (project / "package.json").write_text("{}")
        replica = cloud / "workspaces" / self.key
        replica.mkdir(parents=True)
        (cloud / "routes").mkdir()
        (cloud / "routes" / (self.key + ".json")).write_text(json.dumps({"owner":"desktop", "key":"test"}))
        authorize(root, self.key, project, ["*"], auto=True)
        with closing(Journal(root, self.key)) as j:
            self.assertTrue(j.fence()["auto"])
            epoch = j.fence()["epoch"]
        with subprocess.Popen([sys.executable, "-B", str(LIB / "transfer.py"), "--peer", str(cloud), "sources-v1"],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE) as peer:
            try:
                self.assertIn("sources-v1", receive(peer.stdout)[2:])
                def pump():
                    exchange(root, peer.stdout, peer.stdin, send, receive)
                pump()
                self.assertEqual((replica / "package.json").read_bytes(), b"{}")
                disable(root, self.key)
                marker = root / "source-grants" / (self.key + ".disabled")
                original = marker.read_bytes()
                self.assertEqual(json.loads(original)["previousScopes"], ["*"])
                disable(root, self.key)
                authorize(root, self.key, project, ["*"], auto=True)
                with self.assertRaisesRegex(ScopeChangeError, "使用原范围恢复"):
                    authorize(root, self.key, project, ["src"])
                self.assertEqual(marker.read_bytes(), original)
                self.assertEqual(inventory(root), {})
                (project / "unshared.js").write_bytes(b"offline")
                (replica / "peer.js").write_bytes(b"peer")
                pump()
                self.assertFalse((replica / "unshared.js").exists())
                self.assertFalse((project / "peer.js").exists())
                authorize(root, self.key, project, ["*"])
                pump()
                self.assertEqual((replica / "unshared.js").read_bytes(), b"offline")
                self.assertEqual((project / "peer.js").read_bytes(), b"peer")
                with closing(Journal(root, self.key)) as j:
                    self.assertEqual(j.fence()["epoch"], epoch)
                    self.assertFalse(j.fence()["auto"])
                send(peer.stdin, ["end"])
                self.assertEqual(peer.wait(timeout=10), 0)
            finally:
                if peer.poll() is None:
                    peer.kill()

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
