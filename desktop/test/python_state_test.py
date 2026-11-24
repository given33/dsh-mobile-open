"""Compare restored execution to untouched CPython, including aliases and nested loop control."""

from contextlib import closing
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[1] / "lib" / "task-sync"
sys.path.insert(0, str(LIB))
from python_state import Machine, Program, slice_once

SAMPLE = """buf = [1, 2, 3, 4]
alias = buf
refs = [buf, alias]
score = 0
for outer in range(17, -1, -1):
    for j in range(9):
        if j == 2:
            continue
        if j == outer:
            break
        k = (j + outer) % 4
        alias[k] += j
    else:
        score += 1
    while score < outer:
        score += 2
    else:
        score += 1
print(sum(refs[1]) + score)
"""


class AutomaticState(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.path = Path(t.name) / "work.py"
        self.path.write_text(SAMPLE, encoding="utf8")

    def test_every_boundary_matches_unmodified_cpython(self):
        expected = subprocess.check_output(
            [sys.executable, "-I", str(self.path)], text=True
        ).strip()
        for interval in [1, 13, 512]:
            program = Program(self.path, interval)
            m = Machine(program)
            resets = 0
            while m.pc != -1:
                m.advance()
                raw = m.snapshot()
                m = Machine.restore(program, raw)
                self.assertEqual(m.snapshot(), raw)
                if "alias" in m.values:
                    self.assertIs(m.values["alias"], m.values["buf"])
                resets += 1
            self.assertEqual(m.final_text(), expected)
            if interval == 1:
                self.assertGreater(resets, 300)

    def test_recursive_frames_share_one_heap_and_return_to_each_original_caller(self):
        self.path.write_text(
            "def f(a, n):\n    if n == 0:\n        a[0] += 1\n        return a\n    child = f(a, n-1)\n    child[0] += n\n    return child\nv=[4]\nb=f(v, 5)\nprint(v)\n",
            encoding="utf8",
        )
        p = Program(self.path, 1)
        m = Machine(p)
        deepest = 0
        while m.pc != -1:
            m.advance()
            raw = m.snapshot()
            m = Machine.restore(p, raw)
            self.assertEqual(m.snapshot(), raw)
            deepest = max(deepest, len(m.stack))
            if len(m.stack) > 1:
                self.assertIs(m.values["a"], m.stack[0][1]["v"])
                corrupt = json.loads(raw)
                corrupt["stack"].pop(0)
                with self.assertRaises(ValueError):
                    Machine.restore(p, json.dumps(corrupt).encode())
        self.assertEqual(deepest, 6)
        self.assertEqual(
            m.final_text(),
            subprocess.check_output(
                [sys.executable, "-I", str(self.path)], text=True
            ).strip(),
        )

    def test_no_peer_prevents_even_the_first_assignment(self):
        import sqlite3

        self.path.write_text("x=13\nprint(x)\n", encoding="utf8")
        root = self.path.parent / "ledger"
        cp = subprocess.run(
            [
                sys.executable,
                "-IB",
                str(LIB / "paired_python.py"),
                "primary",
                str(self.path),
                "--job",
                "job",
                "--session",
                "unit",
                "--root",
                str(root),
                "--timeout",
                "1",
            ],
            capture_output=True,
            text=True,
            timeout=12,
        )
        self.assertNotEqual(cp.returncode, 0)
        self.assertIn("local only", cp.stderr)
        with closing(sqlite3.connect(root / "script-progress.sqlite")) as db:
            state, rev, delivery = db.execute(
                "SELECT state,rev,delivery FROM records"
            ).fetchone()
            self.assertEqual((rev, delivery), (1, "local"))
            self.assertEqual(
                (json.loads(state)["steps"], json.loads(state)["names"]), (0, {})
            )

    def test_final_expression_fault_is_not_a_successful_checkpoint(self):
        self.path.write_text("print(1//0)\n", encoding="utf8")
        p = Program(self.path, 1)
        seed = slice_once(p, b"")
        self.assertFalse(seed["done"])
        with self.assertRaises(ZeroDivisionError):
            slice_once(p, seed["state"])

    def test_nonportable_source_rejected_even_on_unreached_branch(self):
        for code in [
            'if False:\n    open("receipt", "w")',
            "import os",
            "a = getattr",
            "n = range(2)",
            "print(1)\nprint(2)",
            "from subprocess import run",
        ]:
            self.path.write_text(code, encoding="utf8")
            with self.assertRaises(ValueError):
                Program(self.path, 1)

    def test_snapshot_cannot_supply_code_or_switch_recipes(self):
        program = Program(self.path, 1)
        raw = Machine(program).snapshot()
        for field, value in [
            ("pc", True),
            ("pc", 5000),
            ("heap", [1]),
            ("names", {"buf": [5]}),
            ("ranges", {"-1": [0, 2, 1]}),
        ]:
            s = json.loads(raw)
            s[field] = value
            with self.assertRaises(ValueError):
                Machine.restore(program, json.dumps(s).encode())
        for interval in [2, 7]:
            with self.assertRaises(ValueError):
                Machine.restore(Program(self.path, interval), raw)
        self.path.write_text(SAMPLE + "#different input", encoding="utf8")
        with self.assertRaises(ValueError):
            Machine.restore(Program(self.path, 1), raw)

    def test_sandbox_slice_first_saves_entry_and_resumes_binary_state(self):
        p = Program(self.path, 100)
        result = slice_once(p, b"")
        self.assertEqual(result["steps"], 0)
        while not result["done"]:
            result = slice_once(p, result["state"])
        self.assertEqual(
            result["result"],
            subprocess.check_output(
                [sys.executable, "-I", str(self.path)], text=True
            ).strip(),
        )
        self.assertEqual(json.loads(base64.b64decode(result["state"]))["pc"], -1)

    def test_reassigned_iterator_and_empty_loop_else(self):
        self.path.write_text(
            "n=4\ns=0\nfor i in range(n):\n    n=0\n    s+=i\n    i=500\nfor j in range(0):\n    pass\nelse:\n    s+=n\nprint(s+i)\n",
            encoding="utf8",
        )
        p = Program(self.path, 1)
        m = Machine(p)
        while m.pc != -1:
            m.advance()
            m = Machine.restore(p, m.snapshot())
        self.assertEqual(m.final_text(), "506")


if __name__ == "__main__":
    unittest.main()
