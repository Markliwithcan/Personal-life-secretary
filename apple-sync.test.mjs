import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot,tokenHash,createSyncServer,readScopeRows} from './apple-sync.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {digest,tick} from './scheduler.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const scope='a'.repeat(64),namespace='b'.repeat(32),now=Date.parse('2026-10-04T09:30:00+09:00');
const cfg={timezone:'Asia/Seoul',morning_digest_time:'09:30',evening_digest_time:'21:30',default_reminder_time:'09:00',quiet_hours:{start:'23:00',end:'08:00'},store_chat_days:30};
const row={scope,id:1,title:'测试事项',state:'open',remind_at:now+3600000,reminder_explicit:1};
test('snapshot preserves identity across edits; unknown times and pending cancellation do not invent alarms',()=>{
 const get=r=>snapshot([r],namespace,cfg.timezone,now).items[0];
 const a=get(row),b=get({...row,title:'改名',remind_at:now+7200000});
 assert.equal(a.marker,b.marker);assert.notEqual(a.fingerprint,b.fingerprint);
 assert.equal(get({...row,reminder_explicit:0}).alarm,'');
 assert.equal(get({...row,remind_at:now-1}).alarm,'');
 assert.equal(get({...row,state:'pending_cancel'}).alarm,'');
 assert.equal(get({...row,state:'pending_cancel'}).active,true);
 for(const state of ['done','cancelled'])assert.equal(get({...row,state}).active,false);
 assert.notEqual(a.marker,get({...row,scope:'c'.repeat(64)}).marker);
 assert.deepEqual(a,get(row));
});
test('sync API authenticates each client and cannot select another scope or write state',async t=>{
 const token='test-device-token',seen=[];
 const server=createSyncServer({namespace,timezone:cfg.timezone,clients:[{token_hash:tokenHash(token),scopes:[scope]}],readRows:scopes=>{seen.push(scopes);return [row];}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/v1/apple-reminders`,headers={Authorization:`Bearer ${token}`};
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(url+'?scope=other',{headers})).status,404);
 assert.equal((await fetch(url,{headers,method:'POST'})).status,404);
 const response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await response.json()).items[0].title,row.title);assert.deepEqual(seen,[[scope]]);
});
test('missing scope fails rather than returning empty data; malformed scopes rejected',()=>{
 assert.throws(()=>readScopeRows(['../private']));
 assert.throws(()=>createSyncServer({namespace,clients:[{token_hash:tokenHash('x'),scopes:['../private']}]}));
});
test('pairing persists only token hashes; readonly export uses selected database and omits private notes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'secretary-apple-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(path.join(root,'feishu',scope,'assistant.sqlite3'));
 store.create({title:'个人测试',notes:'do not export chat history or notes',due:null,remind_at:null,priority:'normal',recurrence:null},'test',cfg,now);
 store.close();
 const output=execFileSync(process.execPath,['apple-pair.mjs',scope],{cwd:import.meta.dirname,env:{...process.env,ASSISTANT_CONFIG_DIR:root,ASSISTANT_DATA_DIR:root},encoding:'utf8'});
 const config=JSON.parse(fs.readFileSync(path.join(root,'apple-sync.local.json')));
 const device=JSON.parse(fs.readFileSync(path.join(root,fs.readdirSync(root).find(n=>n.startsWith('apple-device-')))));
 assert.equal(config.enabled,false);assert.equal(config.clients[0].token_hash,tokenHash(device.authorization.slice(7)));
 assert.ok(!output.includes(device.authorization.slice(7)));
 const rows=readScopeRows([scope],root);assert.equal(rows[0].title,'个人测试');assert.equal(rows[0].notes,undefined);
 assert.throws(()=>readScopeRows([scope,'c'.repeat(64)],root));
});
test('empty daily briefings send nothing, avoid model calls and mark scheduled job handled',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());let sent=0,models=0;
 const engine=new Engine(store,()=>cfg,async()=>{models++;throw Error('must not call');});
 assert.equal(digest(store,cfg,now),'');
 await tick(store,cfg,async()=>sent++,now,(kind,n)=>engine.daily(kind,n));
 assert.equal(sent,0);assert.equal(models,0);
 assert.equal(store.db.prepare("SELECT state FROM jobs WHERE kind='morning'").get().state,'sent');
 assert.equal(await engine.process('query','今日清单',now),'当前没有需要提醒或确认的事项。');
});
test('briefings omit empty sections and instructions while preserving questions',()=>{
 const store=new Store(':memory:');
 try{store.create({title:'待确认事项',due:null,remind_at:null,priority:'normal',notes:'',recurrence:null},'test',cfg,now);
 const text=digest(store,cfg,now);assert.match(text,/请补充或确认提醒时间/);
 assert.doesNotMatch(text,/暂无|直接回复|补时间|语音|执行安排|今天已确认完成/);
 }finally{store.close();}
});
