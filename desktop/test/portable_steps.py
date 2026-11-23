"""Failure-boundary regressions for the portable step ledger and offline mailbox."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib/task-sync'))
import portable_worker as worker
import transfer


class StepRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.db=worker.database(self.root)
        self.addCleanup(lambda:self.db.close())
        self.ticket=dict(session='s1',call='c1',attempt='1'*32,ms=20000,op='sha256-upper',input=base64.b64encode(b'bound input').decode())

    def test_hard_cut_and_cloud_restart_preserve_elapsed_time_input_and_fence(self):
        self.assertEqual(worker.arm(self.db,self.ticket,100),'armed')
        self.assertEqual(worker.local(self.db,self.ticket,'pulse',104),'ok')
        self.db.close();self.db=worker.database(self.root)
        worker.sweep(self.db,115);self.assertEqual(worker.page(self.db,0),[])
        self.assertEqual(worker.local(self.db,self.ticket,'pulse',116),'fenced')
        worker.sweep(self.db,120);worker.sweep(self.db,999)
        self.assertEqual(worker.arm(self.db,self.ticket|{'attempt':'2'*32},999),'duplicate')
        self.assertEqual(worker.arm(self.db,self.ticket|{'ms':0},999),'conflict')
        self.assertEqual(worker.local(self.db,self.ticket,'completed',999),'fenced')
        rows=worker.page(self.db,0); self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['result'],hashlib.sha256(b'bound input').hexdigest().upper())
        self.assertEqual(rows[0]['owner'],'cloud')
        mailbox=self.root/'desktop';mailbox.mkdir()
        transfer.collect_receipts(mailbox,io.BytesIO(json.dumps(rows).encode()+b'\n'),io.BytesIO())
        receipt=mailbox/'step-results'/hashlib.sha256(b's1').hexdigest()/'1.json'
        self.assertEqual(json.loads(receipt.read_bytes()),rows[0]);self.assertIsNone(self.db.execute('SELECT payload FROM steps').fetchone()[0])

    def test_success_cancel_and_live_lease_prevent_standby_replay(self):
        for i,outcome in enumerate(['completed','failed','cancelled','unconfirmed']):
            t=self.ticket|{'call':f'c{i}','ms':1}
            worker.arm(self.db,t,0);worker.local(self.db,t,'pulse',8);worker.sweep(self.db,11)
            self.assertEqual(worker.local(self.db,t,outcome,12),'ok');worker.sweep(self.db,999)
        rows=worker.page(self.db,0);self.assertEqual([r['status'] for r in rows],['completed','failed','cancelled','unconfirmed']);self.assertTrue(all(r['owner']=='desktop' for r in rows))
        with self.assertRaises(ValueError):worker.arm(self.db,self.ticket|{'op':'shell'},0)


if __name__=='__main__':unittest.main()
