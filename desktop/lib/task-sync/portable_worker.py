"""Durable, non-shell executor for the paired host. No program names or paths from the wire."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

LEASE = 10  # Only the cloud clock decides expiry.
MAX_INPUT = 1 << 20
ID = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}')


def database(root):
    root.mkdir(mode=0o700, exist_ok=True, parents=True)
    db = sqlite3.connect(str(root/'portable-steps.sqlite'), timeout=5, isolation_level='IMMEDIATE')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA synchronous=FULL')
    db.execute('PRAGMA secure_delete=ON')
    db.executescript('''CREATE TABLE IF NOT EXISTS steps (
      session TEXT NOT NULL, call TEXT NOT NULL, attempt TEXT NOT NULL, identity TEXT NOT NULL,
      due REAL NOT NULL, lease REAL NOT NULL, operation TEXT NOT NULL, payload BLOB,
      state TEXT NOT NULL, PRIMARY KEY(session,call));
      CREATE INDEX IF NOT EXISTS pending_steps ON steps(state,lease,due);
      CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY, session TEXT NOT NULL,
        call TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL,
        finished INTEGER NOT NULL, UNIQUE(session,call));''')
    return db


def parse(ticket):
    if not isinstance(ticket, dict) or set(ticket) != {'session','call','attempt','ms','op','input'}:
        raise ValueError('Invalid step')
    sid, call, attempt = (ticket[k] for k in ('session','call','attempt'))
    if not all(isinstance(x, str) and ID.fullmatch(x) for x in (sid,call)) or not re.fullmatch('[a-f0-9]{32}', attempt):
        raise ValueError('Invalid identity')
    ms, op = ticket['ms'], ticket['op']
    if type(ms) is not int or not 0 <= ms <= 3600000 or op not in ('wait','line','bytes','sha256-upper','sha256-lower'):
        raise ValueError('Unsupported operation')
    raw = base64.b64decode(ticket['input'], validate=True)
    if len(raw) > MAX_INPUT or (op == 'wait' and raw) or (op == 'line' and (len(raw)>512 or not raw.decode().isprintable())):
        raise ValueError('Invalid portable input')
    fingerprint = hashlib.sha256(f'{op}:{ms}:'.encode()+raw).hexdigest()
    return sid,call,attempt,ms,op,raw,fingerprint


def arm(db, ticket, now):
    sid,call,attempt,ms,op,raw,fingerprint = parse(ticket)
    with db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT identity,attempt,state FROM steps WHERE session=? AND call=?',(sid,call)).fetchone()
        if row:
            # Even the original client cannot start a second native process for an admitted call.
            return 'duplicate' if row['identity']==fingerprint else 'conflict'
        if db.execute("SELECT count(*) FROM steps WHERE state='armed'").fetchone()[0] >= 64:
            return 'busy'
        db.execute('INSERT INTO steps VALUES(?,?,?,?,?,?,?,?,?)',(sid,call,attempt,fingerprint,now+ms/1000,now+LEASE,op,raw,'armed'))
        return 'armed'


def finish(db, row, owner, status, text, now):
    db.execute('INSERT INTO receipts(session,call,owner,status,result,finished) VALUES(?,?,?,?,?,?)',
               (row['session'],row['call'],owner,status,text,int(now*1000)))
    db.execute("UPDATE steps SET state='closed',payload=NULL WHERE session=? AND call=?",(row['session'],row['call']))


def output(row):
    op,raw = row['operation'],row['payload']
    if op == 'wait': result = ''
    elif op == 'line': result = raw.decode()
    elif op == 'bytes': result = str(len(raw))
    elif op in ('sha256-upper','sha256-lower'):
        digest = hashlib.sha256(raw).hexdigest()
        result = digest.upper() if op=='sha256-upper' else digest
    else: raise ValueError('Unknown stored step')
    return result


def local(db, ticket, action, now):
    if action not in ('pulse','completed','cancelled','failed','unconfirmed'):
        raise ValueError('Invalid step update')
    with db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM steps WHERE session=? AND call=? AND attempt=?',
                         (ticket['session'],ticket['call'],ticket['attempt'])).fetchone()
        if not row or row['state']!='armed' or now >= row['lease']:
            return 'fenced'
        if action=='pulse':
            db.execute('UPDATE steps SET lease=? WHERE session=? AND call=?',(now+LEASE,row['session'],row['call']))
        else:
            finish(db,row,'desktop',action,output(row) if action=='completed' else '',now)
        return 'ok'


def sweep(db, now):
    with db:
        db.execute('BEGIN IMMEDIATE')
        for row in db.execute("SELECT * FROM steps WHERE state='armed' AND lease<=? AND due<=? LIMIT 16",(now,now)).fetchall():
            # All inputs are immutable bytes. The server cannot execute a shell or read a client-supplied path.
            finish(db,row,'cloud','completed',output(row),now)


def page(db, after):
    if type(after) is not int or after < 0: raise ValueError('Invalid receipt cursor')
    return [dict(row) for row in db.execute('SELECT * FROM receipts WHERE seq>? ORDER BY seq LIMIT 64',(after,))]


def serve(db):
    def message(limit):
        data=sys.stdin.buffer.readline(limit+1)
        if not data: return None
        if len(data)>limit or not data.endswith(b'\n'): raise ValueError('Invalid frame')
        return json.loads(data)
    if message(80) != 'hello-v1': raise ValueError('Unknown step protocol')
    print(json.dumps('ready-v1'),flush=True)
    ticket=message(2*MAX_INPUT)
    answer=arm(db,ticket,time.time()); print(json.dumps(answer),flush=True)
    if answer!='armed': return
    while True:
        action=message(80)
        if action is None: return  # Lease remains; a dead client cannot revoke or renew it.
        answer=local(db,ticket,action,time.time());print(json.dumps(answer),flush=True)
        if answer!='ok' or action!='pulse': return


if __name__=='__main__':
    os.umask(0o077)
    db=database(Path(sys.argv[2]))
    if sys.argv[1]=='--step': serve(db)
    elif sys.argv[1]=='--status':
        sid=sys.argv[3]
        if not ID.fullmatch(sid): raise ValueError('Invalid session')
        print(json.dumps([dict(r) for r in db.execute('SELECT * FROM receipts WHERE session=? ORDER BY seq DESC LIMIT 10',(sid,))]))
    elif sys.argv[1]=='--worker':
        while True:
            sweep(db,time.time());time.sleep(1)
    else: raise SystemExit('Unknown portable worker mode')
