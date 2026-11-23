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
                self.assertTrue(args[-1].endswith(' watch-v1'))
                connections.append(True)
                return spawn([sys.executable, str(SCRIPT), '--peer', str(cloud), 'watch-v1'], **options)

            polls = []
            def wait(_seconds):
                # Check both directions *before* providing the next checkpoint.
                for source, dest in ((desktop, cloud), (cloud, desktop)):
                    step = 1 if not polls else 2
                    name, data = packet(source.name, step)
                    self.assertEqual((dest / 'inbox' / name).read_bytes(), data)
                    if not polls:
                        offer(source, 2)
                polls.append(True)

            offer(desktop, 1)
            offer(cloud, 1)
            with patch.object(sys, 'argv', [str(SCRIPT), '--watch', str(desktop), 'verified-host']), \
                 patch.object(subprocess, 'Popen', side_effect=loopback), \
                 patch.object(transfer.time, 'sleep', side_effect=wait), \
                 patch.object(transfer.time, 'monotonic', side_effect=lambda: 100 if len(polls) >= 3 else 0):
                transfer.main()
            self.assertEqual(len(connections), 1)
            self.assertEqual(len(polls), 3)


if __name__ == '__main__':
    unittest.main()
