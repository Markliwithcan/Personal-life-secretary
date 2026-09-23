import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {tick,digest} from './scheduler.mjs';
import {normalizeTask,quietUntil,nextOccurrence} from './time.mjs';
import {Plan} from './model.mjs';
const cfg={timezone:'Asia/Seoul',default_reminder_time:'09:00',evening_digest_time:'21:30',quiet_hours:{start:'23:00',end:'08:00'},store_chat_days:30,model:{}};
const NOW=Date.parse('2026-09-16T10:00:00+09:00');
function fixture(t,model){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-test-'));const filename=path.join(dir,'db.sqlite');let store=new Store(filename);const engine=new Engine(store,()=>cfg,model);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine,filename};}
test('create receipt survives reopen and duplicate message does not duplicate task',async t=>{
  const {store,engine,filename}=fixture(t);const first=await engine.process('one','提醒 10分钟 喝水',NOW);assert.match(first,/已记下/);
  const reopened=new Store(filename);const again=new Engine(reopened,()=>cfg);assert.equal(await again.process('one','提醒 10分钟 喝水',NOW+500),first);assert.equal(reopened.open().length,1);reopened.close();
});
test('postpone and cancellation invalidate old pending reminders',async t=>{
  const {store,engine}=fixture(t);await engine.process('1','提醒 1分钟 喝水',NOW);await engine.process('2','推迟 1 30分钟',NOW);
  const sends=[];await tick(store,cfg,async text=>sends.push(text),NOW+61000);assert.equal(sends.length,0);
  await engine.process('3','取消 1',NOW+62000);await tick(store,cfg,async text=>sends.push(text),NOW+3600000);assert.equal(sends.length,0);assert.equal(store.get(1).state,'cancelled');
});
test('offline reminders recover and retry with persisted backoff',async t=>{
  const {store,engine}=fixture(t);await engine.process('1','提醒 1分钟 喝水',NOW);
  await tick(store,cfg,async()=>{throw new Error('network');},NOW+600000);
  let job=store.db.prepare("SELECT * FROM jobs WHERE kind='task'").get();assert.equal(job.state,'pending');assert.equal(job.attempts,1);
  const sends=[];await tick(store,cfg,async s=>sends.push(s),job.run_at);assert.equal(sends.length,1);assert.match(sends[0],/补发/);
  await tick(store,cfg,async s=>sends.push(s),job.run_at+60000);assert.equal(sends.length,1);
});
test('quiet hours defer reminders; test command bypasses quiet hours',async t=>{
  const {store,engine}=fixture(t);const late=Date.parse('2026-09-16T23:30:00+09:00');
  assert.equal(quietUntil(late,cfg),Date.parse('2026-09-17T08:00:00+09:00'));
  await engine.process('1','提醒 1分钟 喝水',late);await engine.process('2','测试提醒',late);const sent=[];
  await tick(store,cfg,async s=>sent.push(s),late+60000);assert.equal(sent.length,1);assert.match(sent[0],/测试提醒/);
});
test('daily digest generated once and separates tomorrow from unscheduled',async t=>{
  const {store,engine}=fixture(t);await engine.process('1','添加 找牙医',NOW);
  store.create({title:'提交材料',due:'2026-09-17'},'test',cfg,NOW);
  assert.match(digest(store,cfg,NOW),/待安排（不是明天必须做）/);
  const sent=[];const evening=Date.parse('2026-09-16T21:31:00+09:00');await tick(store,cfg,async s=>sent.push(s),evening);await tick(store,cfg,async s=>sent.push(s),evening+5000);assert.equal(sent.length,1);assert.match(sent[0],/提交材料/);
});
test('recurring reminder advances and completing notified occurrence does not skip next',async t=>{
  const {store}=fixture(t);store.create({title:'读书',remind_at:new Date(NOW+1000).toISOString(),recurrence:'daily'},'test',cfg,NOW);
  await tick(store,cfg,async()=>{},NOW+2000);assert.equal(store.get(1).remind_at,NOW+86401000);
  store.finish(1,false,cfg,NOW+5000);assert.equal(store.get(1).remind_at,NOW+86401000);assert.equal(store.get(1).state,'open');
});
test('ambiguous model answer applies no actions',async t=>{
  const {store,engine}=fixture(t,async()=>({reply:'',clarification:'你指哪件事？',actions:[{op:'cancel',id:1}]}));await engine.process('1','添加 买菜',NOW);const response=await engine.process('2','那个算了',NOW);assert.equal(response,'你指哪件事？');assert.equal(store.get(1).state,'open');
});
test('multi-action failure rolls back prior writes',async t=>{
  const {store,engine}=fixture(t,async()=>({reply:'',clarification:null,actions:[{op:'complete',id:1},{op:'cancel',id:999}]}));await engine.process('1','添加 买菜',NOW);assert.match(await engine.process('2','执行',NOW),/没有执行变更/);assert.equal(store.get(1).state,'open');
});
test('bulk destructive operations are staged until explicit confirmation',async t=>{
  const {store,engine}=fixture(t,async()=>({reply:'',clarification:null,actions:[{op:'cancel',id:1},{op:'cancel',id:2}]}));await engine.process('1','添加 买菜',NOW);await engine.process('2','添加 买水',NOW);const response=await engine.process('3','取消这两项',NOW);const id=response.match(/确认 ([a-f0-9]{6})/)[1];assert.equal(store.open().length,2);await engine.process('4','确认 '+id,NOW+1);assert.equal(store.open().length,0);
});
test('import previews, skips same title and deduplicates exact file',async t=>{
  const {store,engine}=fixture(t);await engine.process('1','添加 买菜',NOW);const result={tasks:[{title:'买菜',due:null},{title:'读书',due:'2026-09-17'}],warnings:[]};const response=engine.previewImport('f1',result,'sha','test.xlsx',NOW);const id=response.match(/确认 ([a-f0-9]{6})/)[1];assert.equal(store.open().length,1);await engine.process('f2','确认 '+id,NOW+1);assert.equal(store.open().length,2);assert.match(engine.previewImport('f3',result,'sha','test.xlsx',NOW+2),/已经导入/);
});
test('invalid dates and extra model operations are rejected',()=>{
  assert.throws(()=>normalizeTask({title:'x',due:'2026-02-30'},cfg));assert.throws(()=>Plan.parse({reply:'',clarification:null,actions:[{op:'shell',command:'bad'}]}));
});
test('weekly recurrence preserves local wall time across DST',()=>{
  const task={remind_at:Date.parse('2026-03-01T09:00:00-05:00'),due:'2026-03-01',recurrence:'weekly'};const next=nextOccurrence(task,task.remind_at+1,'America/New_York');assert.equal(next.remind_at,Date.parse('2026-03-08T09:00:00-04:00'));assert.equal(next.due,'2026-03-08');
});
