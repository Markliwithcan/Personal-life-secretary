import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {snapshot,restore} from './cloud-backup.mjs';
import {healthy} from './healthcheck.mjs';
import {parsePlanBuffer} from './importer.mjs';
test('backup CLI runs through a release directory symlink',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-cli-'));
 try{
  const src=path.join(root,'source');fs.mkdirSync(src);const db=new DatabaseSync(path.join(src,'inbox.sqlite3'));db.exec('CREATE TABLE proof(value TEXT)');db.close();
  fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)),path.join(root,'current'),'junction');
  const run=spawnSync(process.execPath,[path.join(root,'current','cloud-backup.mjs'),'backup',src,path.join(root,'snapshot')],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).databases,1);assert.ok(fs.existsSync(path.join(root,'snapshot','manifest.json')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cloud backup preserves WAL data, validates hashes and refuses overwrites',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-backup-'));
 const src=path.join(root,'source'),out=path.join(root,'snapshot'),dest=path.join(root,'restored');fs.mkdirSync(src);
 const db=new DatabaseSync(path.join(src,'inbox.sqlite3'));db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(value TEXT); INSERT INTO jobs VALUES ('pending reminder');");
 try{
  assert.equal(await snapshot(src,out),1);assert.equal(restore(out,dest),1);
  const copy=new DatabaseSync(path.join(dest,'inbox.sqlite3'));try{assert.equal(copy.prepare('SELECT value FROM jobs').get().value,'pending reminder');}finally{copy.close();}
  assert.throws(()=>restore(out,dest),/EMPTY/);
  fs.appendFileSync(path.join(out,'inbox.sqlite3'),'tampered');assert.throws(()=>restore(out,path.join(root,'other')),/CHECKSUM/);
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('health requires real connection, fresh heartbeat and progressing worker',()=>{
 const now=Date.now(),s={connection:'connected',updated_at:new Date(now).toISOString(),last_work_completed:new Date(now).toISOString()};
 assert.equal(healthy(s,now),true);assert.equal(healthy({...s,connection:'reconnecting'},now),false);assert.equal(healthy(s,now+61000),false);
 assert.equal(healthy({...s,last_work_completed:new Date(now-1000000).toISOString()},now),false);
});
test('configured Python parses a plan buffer and removes temporary file',async()=>{
 const r=await parsePlanBuffer(Buffer.from('title,date\nCloud import test,2026-10-01\n'));
 assert.equal(r.result.tasks[0].title,'Cloud import test');assert.equal(r.hash.length,64);
});
