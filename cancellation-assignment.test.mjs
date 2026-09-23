import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import fs from 'node:fs';
const readSettings=()=>JSON.parse(fs.readFileSync(new URL('./assistant.example.json',import.meta.url),'utf8'));
import {tick,digest} from './scheduler.mjs';
import {routeAssignment,rememberQuestion} from './group-assignment.mjs';
const cfg={...readSettings(),soft_cancel:true,timezone:'Asia/Shanghai',evening_digest_time:'21:00',quiet_hours:{start:'00:00',end:'00:00'}};
const now=Date.parse('2026-09-17T20:00:00+08:00');
test('descriptive cancellation pauses reminders, waits for successful digest then 24 hours',async()=>{
 const s=new Store(':memory:');const e=new Engine(s,()=>cfg);
 try{
 await e.process('1','提醒 10分钟 买牛奶',now);await e.process('2','取消 牛奶',now+1);
 assert.equal(s.get(1).state,'pending_cancel');assert.equal(s.db.prepare("SELECT count(*) n FROM jobs WHERE kind='task' AND state='pending'").get().n,0);
 const evening=now+3600000;assert.match(digest(s,cfg,evening),/拟取消，若有误\/不取消请及时修改/);
 await tick(s,cfg,async()=>{throw new Error('offline');},evening);
 assert.equal(s.get(1).cancel_notified_at,null);
 // Failed notice, even after a full day, must not finalize cancellation.
 await tick(s,cfg,async()=>{throw new Error('offline');},evening+86400000);assert.equal(s.get(1).state,'pending_cancel');
 const sentAt=evening+86400000+120000;await tick(s,cfg,async()=>{},sentAt);
 assert.equal(s.get(1).cancel_notified_at,sentAt);
 await tick(s,cfg,async()=>{},sentAt+86400000-1);assert.equal(s.get(1).state,'pending_cancel');
 await tick(s,cfg,async()=>{},sentAt+86400000);assert.equal(s.get(1).state,'cancelled');
 }finally{s.close();}
});
test('ambiguous title asks; restoration and editing undo pending cancellation',async()=>{
 const s=new Store(':memory:');const e=new Engine(s,()=>cfg);
 try{
 await e.process('1','添加 买牛奶',now);await e.process('2','添加 送牛奶',now);
 assert.match(await e.process('3','取消 牛奶',now),/哪件事/);assert.equal(s.get(1).state,'open');
 await e.process('4','取消 买牛奶',now);await e.process('5','不取消 买牛奶',now);assert.equal(s.get(1).state,'open');
 await e.process('6','取消 买牛奶',now);s.update(1,{title:'买两瓶牛奶'},cfg,now);assert.equal(s.get(1).state,'open');
 }finally{s.close();}
});
test('cross assignment requires known explicit recipient and can continue clarification',async()=>{
 const s=new Store(':memory:');const members=[{open_id:'a',name:'用户甲'},{open_id:'b',name:'用户乙'}];
 const task={title:'阅读资料',due:null,remind_at:null,priority:'normal',recurrence:null,notes:''};
 const ask=async()=>({route:'assign',target:'用户甲',task,question:null});
 try{
 const r=await routeAssignment('明天下午一点提醒用户甲阅读资料',s,cfg,members,members[1],now,ask);assert.equal(r.member.open_id,'a');assert.equal(s.all().length,0);
 const uncertain=await routeAssignment('提醒他阅读资料',s,cfg,members,members[1],now,ask);assert.equal(uncertain.route,'clarify');
 rememberQuestion(s,'提醒他阅读资料',uncertain.question,now);
 const clarified=await routeAssignment('是用户甲',s,cfg,members,members[1],now,ask);assert.equal(clarified.member.open_id,'a');
 s.db.prepare('DELETE FROM assignment_question').run();
 const self=await routeAssignment('添加 买菜',s,cfg,members,members[1],now,()=>{throw Error('unnecessary model call');});assert.equal(self.route,'self');
 }finally{s.close();}
});
