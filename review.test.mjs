import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {digest} from './scheduler.mjs';
import {scheduleReviews,runReviews} from './review.mjs';
const cfg={timezone:'Asia/Seoul',default_reminder_time:'09:00',evening_digest_time:'21:30',quiet_hours:{start:'23:00',end:'08:00'},store_chat_days:30};
const now=Date.parse('2026-09-16T21:01:00+09:00');
const task=title=>({title,due:null,remind_at:null,priority:'normal',recurrence:null,notes:''});
function setup(t,model){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-test-'));const store=new Store(path.join(dir,'db.sqlite'));t.after(()=>{store.close();if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()))throw new Error('unsafe path');fs.rmSync(dir,{recursive:true,force:true});});return {store,engine:new Engine(store,()=>cfg,model)};}
test('startup and daily slots persist exactly once and scan only local today',async t=>{
  const {store}=setup(t);store.addHistory('user','昨天',now-86400000);store.addHistory('user','明天买书',now-1000);
  scheduleReviews(store,cfg,'session',now);scheduleReviews(store,cfg,'session',now);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM review_runs').get().n,3);
  let calls=0;const analyze=async records=>{calls++;assert.equal(records.length,1);assert.equal(records[0].content,'明天买书');return [];};
  await runReviews(store,cfg,now,analyze);await runReviews(store,cfg,now,analyze);await runReviews(store,cfg,now,analyze);assert.equal(calls,1);
});
test('candidate requires evidence, confirmation and avoids repeated proposal',async t=>{
  const {store,engine}=setup(t);store.addHistory('user','找时间买书',now-1000);const id=store.db.prepare('SELECT id FROM history').get().id;
  scheduleReviews(store,cfg,'a',now);
  await runReviews(store,cfg,now,async()=>[{task:task('买书'),source_ids:[id],evidence:'买书'},{task:task('虚构'),source_ids:[id],evidence:'不存在的原话'}]);
  assert.equal(store.open().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM review_candidates').get().n,1);
  await engine.process('accept','补记 1',now);assert.equal(store.open().length,1);
  scheduleReviews(store,cfg,'b',now+1);await runReviews(store,cfg,now+1,async()=>[{task:task('买书'),source_ids:[id],evidence:'买书'}]);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM review_candidates').get().n,1);
});
test('model failure leaves retryable review and never creates task',async t=>{
  const {store}=setup(t);store.addHistory('user','买书',now);scheduleReviews(store,cfg,'a',now);
  await runReviews(store,cfg,now,async()=>{throw new Error('MODEL_NETWORK_ERROR')});const row=store.db.prepare('SELECT * FROM review_runs ORDER BY rowid LIMIT 1').get();assert.equal(row.state,'pending');assert.ok(row.next_attempt>now);assert.equal(store.open().length,0);
});
test('digest includes default time and explicit supplement removes request',async t=>{
  const {store,engine}=setup(t);const a=store.create({title:'报告',due:'2026-09-17'},'x',cfg,now);assert.equal(a.reminder_explicit,0);
  assert.match(digest(store,cfg,now),/补时间 1/);await engine.process('time','补时间 1 2026-09-17 15:00',now);assert.equal(store.get(1).reminder_explicit,1);assert.doesNotMatch(digest(store,cfg,now),/补时间 1/);
});
test('voice correction updates linked task twice without duplicates and corrects review history',async t=>{
  let call=0;
  const {store,engine}=setup(t,async()=>({reply:'',clarification:null,actions:++call===1?[{op:'create',task:task('找老汪')}]:[{op:'update',id:1,patch:{title:call===2?'找老王':'找老黄'}}]}));
  assert.match(await engine.processVoice('v','找老汪',now),/语音转写 V1/);
  await engine.process('c1','修改语音 找老王',now+1);await engine.process('c2','修改语音 1 找老黄',now+2);
  assert.equal(store.open().length,1);assert.equal(store.get(1).title,'找老黄');assert.equal(store.db.prepare('SELECT corrected FROM voices').get().corrected,'找老黄');assert.match(store.db.prepare('SELECT content FROM history WHERE id=1').get().content,/找老黄/);
});
test('voice correction cannot change unrelated task',async t=>{
  const {store,engine}=setup(t,async()=>({reply:'',clarification:null,actions:[{op:'cancel',id:99}]}));store.db.prepare('INSERT INTO voices(message_id,original,created) VALUES (?,?,?)').run('v','买菜',now);
  assert.match(await engine.process('c','修改语音 买水',now+1),/均未修改/);assert.equal(store.db.prepare('SELECT corrected FROM voices').get().corrected,null);
});
