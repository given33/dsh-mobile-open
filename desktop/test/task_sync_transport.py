"""Exercise the actual watch client/peer protocol on isolated directory trees, without production SSH."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'lib' / 'task-sync' / 'transfer.py'
spec = importlib.util.spec_from_file_location('task_transfer', SCRIPT)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class WatchTest(unittest.TestCase):
    def test_receiver_recovers_after_disconnect_without_publishing_or_loading_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            desktop, cloud = [Path(tmp) / name for name in ('desktop', 'cloud')]
            for node in (desktop, cloud):
                for folder in ('inbox', 'outbox'):
                    (node / folder).mkdir(parents=True)
            source = 'fixture-cloud-turn'
            name = hashlib.sha256(('cloud:' + source).encode()).hexdigest() + '.json'
            data = json.dumps(dict(v=2, source=source, origin='cloud')).encode()
            (cloud/'outbox'/name).write_bytes(data)
            (desktop/'outbox'/transfer.MODELS).write_bytes(b'not-for-an-offline-receive')
            spawn = subprocess.Popen

            def loopback(args, **kwargs):
                self.assertIn('StrictHostKeyChecking=yes', args)
                self.assertEqual(args[-2], 'fixture')
                return spawn([sys.executable, str(SCRIPT), '--peer', str(cloud), 'catalog-v1', 'models-v1', 'turns-v1'], **kwargs)

            with patch.object(sys, 'argv', [str(SCRIPT), '--receive', str(desktop), 'fixture']), \
                 patch.object(transfer, 'verifier_manifest', side_effect=AssertionError('reads pairing state')):
                with patch.object(subprocess, 'Popen', side_effect=ConnectionError):
                    with self.assertRaises(ConnectionError):
                        transfer.main()
                with patch.object(subprocess, 'Popen', side_effect=loopback) as connect:
                    with transfer.transport_slot(desktop) as owned:
                        self.assertTrue(owned)
                        transfer.main()
                        connect.assert_not_called()
                    transfer.main()
                    stamp = (desktop/'inbox'/name).stat().st_mtime_ns
                    transfer.main()
                    self.assertEqual((desktop/'inbox'/name).read_bytes(), data)
                    self.assertEqual((desktop/'inbox'/name).stat().st_mtime_ns, stamp)
            self.assertEqual(list((cloud/'inbox').iterdir()), [])

    def test_both_directions_use_the_same_ssh_connection_and_notice_new_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            desktop, cloud = [Path(tmp) / name for name in ('desktop', 'cloud')]
            for node in (desktop, cloud):
                (node / 'outbox').mkdir(parents=True)
                (node / 'inbox').mkdir()

            def packet(origin, step):
                name = hashlib.sha256((origin + ':session-qa').encode()).hexdigest() + '.json'
                data = json.dumps(dict(v=2, origin=origin, source='session-qa', checkpoint=step)).encode()
                return name, data

            def offer(node, step):
                name, data = packet(node.name, step)
                temp = node / 'outbox' / 'next.tmp'
                temp.write_bytes(data)
                temp.replace(node / 'outbox' / name)

            spawn = subprocess.Popen
            connections = []
            def loopback(args, **options):
                self.assertIn('StrictHostKeyChecking=yes', args)
                self.assertTrue(args[-1].endswith(' watch-v1 progress-v1 catalog-v1 models-v1 turns-v1 receipts-v1 relay-v1'))
                connections.append(True)
                return spawn([sys.executable, str(SCRIPT), '--peer', str(cloud), 'watch-v1', 'catalog-v1', 'models-v1', 'turns-v1'], **options)

            polls = []
            def wait(_seconds):
                # Check both directions *before* providing the next checkpoint.
                for source, dest in ((desktop, cloud), (cloud, desktop)):
                    self.assertEqual((dest/'inbox'/transfer.CATALOG).read_bytes(), (source/'outbox'/transfer.CATALOG).read_bytes())
                    step = 1 if not polls else 2
                    name, data = packet(source.name, step)
                    self.assertEqual((dest / 'inbox' / name).read_bytes(), data)
                    if not polls:
                        offer(source, 2)
                polls.append(True)

            for source in (desktop, cloud):
                catalogue = dict(v=1, owner=source.name, workspaces=[dict(key='abc', title='项目')])
                (source/'outbox'/transfer.CATALOG).write_text(json.dumps(catalogue))
            model = json.dumps(dict(v=1,owner='desktop',sections={})).encode()
            (desktop/'outbox'/transfer.MODELS).write_bytes(model)
            (cloud/'outbox'/transfer.MODELS).write_bytes(b'never-publish-to-desktop')
            offer(desktop, 1)
            offer(cloud, 1)
            with patch.object(sys, 'argv', [str(SCRIPT), '--watch', str(desktop), 'verified-host']), \
                 patch.object(subprocess, 'Popen', side_effect=loopback), \
                 patch.object(transfer.time, 'sleep', side_effect=wait), \
                 patch.object(transfer.time, 'monotonic', side_effect=lambda: 100 if len(polls) >= 3 else 0):
                transfer.main()
            self.assertEqual((cloud/'inbox'/transfer.MODELS).read_bytes(), model)
            self.assertFalse((desktop/'inbox'/transfer.MODELS).exists())
            self.assertNotIn(transfer.MODELS, transfer.manifest(desktop/'outbox', catalogs=True))
            self.assertEqual(len(connections), 1)
            self.assertEqual(len(polls), 3)


if __name__ == '__main__':
    unittest.main()
