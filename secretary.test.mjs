import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {tick,digest} from './scheduler.mjs';
import {validateSchedule} from './planning.mjs';
const cfg={timezone:'Asia/Seoul',default_reminder_time:'09:00',morning_digest_time:'09:30',evening_digest_time:'21:30',quiet_hours:{start:'23:00',end:'08:00'},store_chat_days:30};
const now=Date.parse('2026-09-23T09:30:00+09:00');
function setup(t,model){const s=new Store(':memory:');t.after(()=>s.close());return {s,e:new Engine(s,()=>cfg,model)};}
const task={title:'写报告',notes:'',due:null,remind_at:null,priority:'normal',recurrence:null};
const proposal={op:'schedule',reason:'分两天完成',slots:[{id:1,date:'2026-09-23',minutes:30,step:'提纲'},{id:1,date:'2026-09-24',minutes:30,step:'正文'}],capacity:[{date:'2026-09-23',minutes:45},{date:'2026-09-24',minutes:45}]};
test('progress survives and metadata update does not resend an already delivered reminder',async t=>{
 const {s,e}=setup(t,async()=>({reply:'还可以先写提纲。',clarification:null,actions:[{op:'update',id:1,patch:{progress:'partial',remaining_minutes:45}}]}));
 s.create({...task,remind_at:new Date(now-60000).toISOString()},'a',cfg,now-60000);
 s.db.prepare("INSERT INTO jobs(id,kind,run_at,state) VALUES ('morning:2026-09-23','morning',?,'sent')").run(now);
 let sent=0;await tick(s,cfg,async()=>sent++,now);assert.equal(sent,1);
 const reply=await e.process('b','报告做了一半，还剩45分钟',now+1);assert.match(reply,/提纲/);assert.equal(s.get(1).remaining_minutes,45);
 await tick(s,cfg,async()=>sent++,now+2);assert.equal(sent,1);
});
test('recommendation does not create a task or mark one started',async t=>{
 const {s,e}=setup(t,async()=>({reply:'建议先写20分钟提纲。',clarification:null,actions:[]}));s.create(task,'a',cfg,now);
 await e.process('b','我有半小时',now);assert.equal(s.open().length,1);assert.equal(s.get(1).progress,undefined);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM allocations').get().n,0);
});
test('schedule is draft, explicit confirmation commits only allocations, and undo restores',async t=>{
 const {s,e}=setup(t,async()=>({reply:'',clarification:null,actions:[proposal]}));s.create({...task,remaining_minutes:60,splittable:true},'a',cfg,now);
 const before=s.get(1),reply=await e.process('b','分两天安排',now),code=reply.match(/确认 ([a-f0-9]{6})/)[1];
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM allocations').get().n,0);
 await e.process('c','确认 '+code,now+1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM allocations').get().n,2);assert.deepEqual(s.get(1),before);
 await e.process('d','撤销计划',now+2);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM allocations').get().n,0);
});
test('stale proposal cannot overwrite changed progress',async t=>{
 const {s,e}=setup(t,async()=>({reply:'',clarification:null,actions:[proposal]}));s.create({...task,remaining_minutes:60,splittable:true},'a',cfg,now);
 const code=(await e.process('b','安排',now)).match(/确认 ([a-f0-9]{6})/)[1];s.update(1,{remaining_minutes:20},cfg,now+1);
 assert.match(await e.process('c','确认 '+code,now+2),/发生变化/);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM allocations').get().n,0);
});
test('capacity counts other confirmed tasks; deadlines and splitting stay protected',t=>{
 const {s}=setup(t);s.create({...task,remaining_minutes:60,splittable:true},'a',cfg,now);s.create({...task,title:'买菜'},'b',cfg,now);
 s.db.prepare('INSERT INTO allocations VALUES (?,?,?,?)').run(2,'2026-09-23',30,'买菜');assert.throws(()=>validateSchedule(s,proposal,cfg,now),/超过可用/);
 s.db.exec('DELETE FROM allocations');s.update(1,{due:'2026-09-23'},cfg,now);assert.throws(()=>validateSchedule(s,proposal,cfg,now),/超过原截止/);
 s.update(1,{due:null,splittable:false},cfg,now);assert.throws(()=>validateSchedule(s,proposal,cfg,now),/跨天拆分/);
});
test('unanswered completion/time questions carry across morning and evening without mutations',async t=>{
  const {s}=setup(t);s.ensureCancellation();s.create({...task,due:'2026-09-22'},'a',cfg,now);const original=s.get(1);
 for(const [date,kind] of [[now,'morning'],[now+12*3600000,'evening'],[now+86400000,'morning']]){const text=digest(s,cfg,date,kind);assert.match(text,/完成情况待确认/);assert.match(text,/写报告/);assert.match(text,/请补充或确认提醒时间/);}
 assert.deepEqual(s.get(1),original);
});
test('morning at 09:30, retries survive and no obsolete morning at evening',async t=>{
 const {s}=setup(t);s.create(task,'daily-test',cfg,now);let calls=0;await tick(s,cfg,async()=>calls++,now-1);assert.equal(calls,0);
 await tick(s,cfg,async()=>{throw Error('offline');},now);assert.equal(s.db.prepare("SELECT state FROM jobs WHERE kind='morning'").get().state,'pending');
 await tick(s,cfg,async()=>calls++,now+60000);assert.equal(calls,1);await tick(s,cfg,async()=>calls++,now+120000);assert.equal(calls,1);
 const other=new Store(':memory:');t.after(()=>other.close());await tick(other,cfg,async()=>{},now+12*3600000);assert.equal(other.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='morning'").get().n,0);
});
test('daily review snapshots confirmed completion and safely falls back if model fails',async t=>{
 const {s,e}=setup(t,async()=>{throw Error('offline');});s.create(task,'a',cfg,now);s.create({...task,title:'已完成示例'},'b',cfg,now);s.finish(2,false,cfg,now);
 const body=await e.daily('morning',now);assert.match(body,/今天已确认完成\n#2/);assert.doesNotMatch(body,/暂不可用|暂无|直接回复/);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM briefings').get().n,1);
 assert.equal(await e.daily('morning',now),body);assert.equal(s.get(1).state,'open');
});
test('daily model never executes arbitrary write actions',async t=>{
 const {s,e}=setup(t,async()=>({reply:'',clarification:null,actions:[{op:'complete',id:1}]}));s.create(task,'a',cfg,now);await e.daily('evening',now);assert.equal(s.get(1).state,'open');
});
