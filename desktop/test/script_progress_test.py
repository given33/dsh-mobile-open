"""Checkpoint invariants which a happy-path kill-and-resume test cannot exercise."""
import base64
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib/task-sync'))
import script_progress as ledger


class ProgressTest(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.path = Path(workspace.name)
        self.db = ledger.connect(self.path)
        self.addCleanup(self.db.close)
        self.run = ledger.run_id('session', 'build', '1' * 64)

    def frame(self, rev=1, parent=ledger.START, data=b'first', done=False):
        return dict(run=self.run, rev=rev, parent=parent, done=done,
                    digest=ledger.fingerprint(self.run, rev, parent, done, data),
                    state=base64.b64encode(data).decode('ascii'))

    def test_commit_is_not_peer_ack(self):
        first = self.frame()
        self.assertEqual(ledger.apply(self.db, first, 'local'), 'stored')
        reopened = ledger.connect(self.path)
        try:
            self.assertEqual(ledger.current(reopened, self.run)['delivery'], 'local')
            self.assertEqual(ledger.pending(reopened), [first])
            ledger.acknowledge(reopened, self.run, 1, first['digest'], 'full')
            self.assertEqual(ledger.pending(reopened), [first])
            with self.assertRaises(ValueError):
                ledger.acknowledge(reopened, self.run, 1, '2' * 64, 'stored')
            ledger.acknowledge(reopened, self.run, 1, first['digest'], 'stored')
            self.assertEqual(ledger.current(self.db, self.run)['delivery'], 'paired')
        finally:
            reopened.close()

    def test_fork_after_compaction_fences_future_revisions(self):
        first = self.frame()
        second = self.frame(2, first['digest'], b'second')
        for item in [first, second]:
            self.assertEqual(ledger.apply(self.db, item, 'peer'), 'stored')
        self.assertIsNone(self.db.execute('SELECT state FROM records WHERE rev=1').fetchone()[0])
        self.assertEqual(ledger.apply(self.db, self.frame(data=b'fork'), 'peer'), 'conflict')
        ledger.acknowledge(self.db, self.run, 1, first['digest'], 'stored')
        self.assertEqual(ledger.current(self.db, self.run)['delivery'], 'conflict')
        self.assertEqual(ledger.apply(self.db, self.frame(3, second['digest']), 'local'), 'conflict')

    def test_corruption_size_order_and_terminal_state(self):
        with self.assertRaises(ValueError):
            ledger.apply(self.db, dict(self.frame(), state='YmFk'))
        with self.assertRaises(ValueError):
            ledger.apply(self.db, self.frame(data=b'a' * (ledger.MAX_BYTES + 1)))
        self.assertEqual(ledger.apply(self.db, self.frame(2)), 'conflict')
        final = self.frame(done=True)
        self.assertEqual(ledger.apply(self.db, final), 'stored')
        self.assertEqual(ledger.apply(self.db, self.frame(2, final['digest'])), 'conflict')

    def test_pulse_does_not_create_checkpoint(self):
        pulse = dict(run=self.run, token='c' * 32, seq=3)
        ledger.observe(self.db, [pulse])
        self.assertEqual(ledger.current(self.db, self.run)['delivery'], 'none')
        self.assertEqual(self.db.execute('SELECT count(*) FROM peer_pulses').fetchone()[0], 0)
        ledger.apply(self.db, self.frame())
        ledger.observe(self.db, [pulse, dict(pulse, seq=2)])
        self.assertEqual(self.db.execute('SELECT seq FROM peer_pulses').fetchone()[0], 3)


if __name__ == '__main__':
    unittest.main()
