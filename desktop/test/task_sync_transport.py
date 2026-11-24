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
            self.assertFalse((desktop/'failover').exists())
            self.assertFalse((cloud/'failover').exists())

    def test_failover_mailbox_and_cloud_liveness_over_real_peer(self):
        with tempfile.TemporaryDirectory() as tmp:
            desktop, cloud = [Path(tmp) / name for name in ('desktop', 'cloud')]
            sid = 'fixture-turn'
            now = int(transfer.time.time() * 1000)
            for node, epoch in ((desktop, 'd' * 32), (cloud, 'c' * 32)):
                (node / 'failover').mkdir(parents=True)
                local = dict(v=1, role=node.name, epoch=epoch, updatedAt=now,
                             active={sid if node == desktop else 'other': dict(turn=3, epoch=epoch, armed=False)}, surrenders={})
                (node / 'failover/local-state.json').write_text(json.dumps(local))
            spawn = subprocess.Popen

            def loopback(args, **kwargs):
                self.assertIn('failover-v1', args[-1].split())
                return spawn([sys.executable, str(SCRIPT), '--peer', str(cloud), 'failover-v1', 'relay-v1'], **kwargs)

            def exchange(mode):
                with patch.object(sys, 'argv', [str(SCRIPT), mode, str(desktop), 'fixture']), \
                     patch.object(subprocess, 'Popen', side_effect=loopback):
                    transfer.main()

            def patch_state(node, name, update):
                state = transfer.failover_state(node, name)
                update(state)
                (node / 'failover' / name).write_text(json.dumps(state))

            def seen(node):
                return transfer.failover_state(node, 'peer-observed.json')

            exchange('--sync')
            self.assertFalse(seen(cloud)['active'][sid]['peerArmed'])
            self.assertEqual(seen(desktop)['ackOffer'][sid], {'turn': 3, 'epoch': 'd' * 32})
            self.assertGreater(seen(cloud)['lastSeenAt'], 0)
            patch_state(desktop, 'local-state.json', lambda s: s['active'][sid].update(armed=True))
            exchange('--sync')
            desktop_grant = seen(desktop)['leaseGrants'][sid]
            self.assertTrue(desktop_grant['armed'])
            backup_start = seen(cloud)['active'][sid]['leaseRenewedAt']
            cloud_grant = seen(cloud)['leaseGrants']['other']
            # Simulate 21s without a live desktop ping; no sleeps or clock skew required.
            old = now - 21000
            patch_state(cloud, 'peer-observed.json', lambda s: s.update(lastSeenAt=old))
            checkpoint = dict(v=2, source=sid, origin='desktop')
            name = hashlib.sha256(('desktop:' + sid).encode()).hexdigest() + '.json'
            (desktop/'outbox'/name).write_text(json.dumps(checkpoint))
            command = '1' * 32
            intent = dict(v=2, boundary='auto-failover', trigger='shutdown', session=sid,
                          command=command, **{'from': 'desktop'})
            job = hashlib.sha256(f'dsh-cloud-run/v1:{sid}:{command}'.encode()).hexdigest() + '.json'
            (desktop/'relay-outgoing').mkdir()
            (desktop/'relay-outgoing'/job).write_text(json.dumps(dict(checkpoint, cloudIntent=intent)))
            # A relay-v1-only peer must not receive or acknowledge an auto-failover job.
            def legacy(args, **kwargs):
                return spawn([sys.executable, str(SCRIPT), '--peer', str(cloud), 'relay-v1'], **kwargs)
            with patch.object(sys, 'argv', [str(SCRIPT), '--mailbox', str(desktop), 'fixture']), \
                 patch.object(subprocess, 'Popen', side_effect=legacy):
                transfer.main()
            self.assertTrue((desktop/'relay-outgoing'/job).exists())
            self.assertFalse((cloud/'relay-incoming'/job).exists())
            exchange('--mailbox')
            self.assertEqual(json.loads((cloud/'inbox'/name).read_bytes()), checkpoint)
            self.assertEqual(json.loads((cloud/'relay-incoming'/job).read_bytes())['cloudIntent'], intent)
            self.assertTrue(seen(cloud)['active'][sid]['peerArmed'])
            self.assertEqual(seen(cloud)['surrenders'], {})
            self.assertEqual(seen(cloud)['lastSeenAt'], old)
            self.assertGreaterEqual(seen(desktop)['lastSeenAt'], now)
            self.assertEqual(seen(cloud)['ackOffer']['other'], {'turn': 3, 'epoch': 'c' * 32})
            # SSH can still launch --peer, but stale cloud DSH state is not a renewal.
            patch_state(cloud, 'local-state.json', lambda s: s.update(updatedAt=old))
            for _ in range(21):
                # Keep cloud liveness fresh even on a slow CI machine.
                patch_state(cloud, 'local-state.json', lambda s: s.update(updatedAt=int(transfer.time.time() * 1000)))
                exchange('--mailbox')
                self.assertEqual(seen(desktop)['leaseGrants'][sid], desktop_grant)
                self.assertEqual(seen(cloud)['active'][sid]['leaseRenewedAt'], backup_start)
            self.assertNotEqual(seen(cloud)['leaseGrants']['other']['renewalId'], cloud_grant['renewalId'])
            patch_state(cloud, 'local-state.json', lambda s: s.update(updatedAt=old))
            cloud_grant = seen(cloud)['leaseGrants']['other']
            cloud_last_renewal = seen(desktop)['active']['other']['leaseRenewedAt']
            last = seen(desktop)['lastSeenAt']
            exchange('--mailbox')
            self.assertEqual(seen(desktop)['lastSeenAt'], last)
            self.assertEqual(seen(cloud)['lastSeenAt'], old)

            exchange('--sync')  # Even a live desktop may not get a grant from a stale cloud host.
            self.assertEqual(seen(desktop)['leaseGrants'][sid], desktop_grant)
            self.assertEqual(seen(cloud)['leaseGrants']['other'], cloud_grant)
            self.assertEqual(seen(desktop)['active']['other']['leaseRenewedAt'], cloud_last_renewal)

    def test_late_and_unrelated_receipts_do_not_extend_a_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'failover').mkdir()
            epoch = 'd' * 32
            local = dict(v=1, role='desktop', epoch=epoch, active={'s': dict(epoch=epoch, turn=3, armed=True)})
            (root / 'failover/local-state.json').write_text(json.dumps(local))
            sent = []
            def reply(_):
                frame = sent[-1][1]
                ack = dict(renewalId=frame['renewalId'], epoch=epoch, sessions={'s': dict(turn=3, armed=True)})
                return dict(v=1, role='cloud', epoch='c'*32, hostAlive=True, leaseAck=ack)
            with patch.object(transfer, 'send', side_effect=lambda _, msg: sent.append(msg)), \
                 patch.object(transfer, 'receive', side_effect=reply), patch.object(transfer.time, 'time', side_effect=[100.,113.]):
                transfer.exchange_failover(root, None, None, True)
            seen = transfer.failover_state(root, 'peer-observed.json')
            self.assertEqual(seen['lastSeenAt'], 113000)
            self.assertEqual(seen['leaseGrants']['s']['renewedAt'], 100000)
            request = sent[0][1]
            ack = reply(None)['leaseAck']
            for changed in [dict(epoch='c'*32), dict(renewalId='1'*32), dict(sessions={'s': dict(turn=4, armed=True)}),
                            dict(sessions={'s': dict(turn=3, armed=False)})]:
                self.assertEqual(transfer.validated_grants(request, {**ack, **changed}, 100000), {})

    def test_reverse_ack_is_one_use_and_uses_cloud_send_time_after_13s_delay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'failover').mkdir()
            epoch, sid = 'c' * 32, 'cloud-task'
            state = dict(v=1, role='cloud', epoch=epoch, updatedAt=100000, active={sid: dict(epoch=epoch, turn=2, armed=True)})
            (root / 'failover/local-state.json').write_text(json.dumps(state))
            boot = """import sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent)); import transfer
clock=[100.0]; transfer.time.time=lambda:clock[0]; read=transfer.receive
def receive(stream):
    msg=read(stream)
    clock[0]=113.0 if msg[0]=='failover-lease-ack' else 100.0
    return msg
transfer.receive=receive; sys.argv=sys.argv[1:]; transfer.main()
"""
            with subprocess.Popen([sys.executable, '-B', '-c', boot, str(SCRIPT), '--peer', str(root), 'failover-v1'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
                try:
                    self.assertIn('failover-v1', transfer.receive(proc.stdout))
                    def call(msg):
                        transfer.send(proc.stdin, msg)
                        return transfer.receive(proc.stdout)
                    ping = ['failover-ping', dict(v=1, role='desktop', epoch='d'*32, hostAlive=False)]
                    def ack(reply):
                        return dict(renewalId=reply['renewalId'], epoch=epoch, sessions={sid: dict(turn=2, armed=True)})
                    first = ack(call(ping))
                    self.assertFalse(call(['failover-lease-ack', {**first, 'epoch': 'd'*32}]))
                    self.assertFalse(call(['failover-lease-ack', first]))
                    second = ack(call(ping))
                    self.assertNotEqual(first['renewalId'], second['renewalId'])
                    self.assertTrue(call(['failover-lease-ack', second]))
                    self.assertFalse(call(['failover-lease-ack', second]))
                    grant = transfer.failover_state(root, 'peer-observed.json')['leaseGrants'][sid]
                    self.assertEqual((grant['renewalId'], grant['renewedAt']), (second['renewalId'], 100000))
                finally:
                    transfer.send(proc.stdin, ['end'])
                    self.assertEqual(proc.wait(timeout=10), 0)

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
                self.assertTrue(args[-1].endswith(' watch-v1 progress-v1 sources-v1 results-v1 catalog-v1 models-v1 turns-v1 receipts-v1 relay-v1'))
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
                polls.append(_seconds)

            for source in (desktop, cloud):
                catalogue = dict(v=1, owner=source.name, workspaces=[dict(key='abc', title='椤圭洰')])
                (source/'outbox'/transfer.CATALOG).write_text(json.dumps(catalogue))
            model = json.dumps(dict(v=1,owner='desktop',sections={})).encode()
            (desktop/'outbox'/transfer.MODELS).write_bytes(model)
            (cloud/'outbox'/transfer.MODELS).write_bytes(b'never-publish-to-desktop')
            offer(desktop, 1)
            offer(cloud, 1)
            with patch.object(sys, 'argv', [str(SCRIPT), '--watch', str(desktop), 'verified-host']), \
                 patch.object(subprocess, 'Popen', side_effect=loopback), \
                 patch.object(transfer.time, 'sleep', side_effect=wait), \
                 patch.object(transfer.time, 'monotonic', side_effect=lambda: 181 if len(polls) >= 7 else 0):
                transfer.main()
            self.assertEqual((cloud/'inbox'/transfer.MODELS).read_bytes(), model)
            self.assertFalse((desktop/'inbox'/transfer.MODELS).exists())
            self.assertNotIn(transfer.MODELS, transfer.manifest(desktop/'outbox', catalogs=True))
            self.assertEqual(len(connections), 1)
            self.assertEqual(polls[:2], [0.25, 0.25])
            self.assertEqual(polls[2:], sorted(polls[2:]))
            self.assertEqual(polls[-1], 0.6)


if __name__ == '__main__':
    unittest.main()
