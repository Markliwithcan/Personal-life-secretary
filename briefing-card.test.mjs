import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {tick} from './scheduler.mjs';
import {dailyCard,sendFeishuMessage} from './briefing-card.mjs';
import {routeAssignment,rememberQuestion} from './group-assignment.mjs';
const cfg={timezone:'Asia/Seoul',soft_cancel:true,default_reminder_time:'09:00',morning_digest_time:'09:30',evening_digest_time:'21:30',quiet_hours:{start:'23:00',end:'08:00'},store_chat_days:30};
const now=Date.parse('2026-10-11T09:30:00+09:00');
const task={title:'剪辑视频',due:null,remind_at:null,notes:'',priority:'normal',recurrence:null};
const setup=t=>{const s=new Store(':memory:');t.after(()=>s.close());return s;};
test('daily card deduplicates overlapping roles and hides empty sections',t=>{
 const s=setup(t);s.create({...task,remind_at:new Date(now-1000).toISOString()},'test',cfg,now);
 const card=dailyCard(s,cfg,now,'morning');
 const tables=card.card.body.elements.filter(e=>e.tag==='table');
 assert.equal(tables.length,1);assert.equal(tables[0].rows.length,1);
 assert.deepEqual(tables[0].rows[0].status.map(s=>s.text),['今日','进度待确认']);
 assert.doesNotMatch(JSON.stringify(card),/暂无|已完成 0|直接回复|工作量约 0/);
 const empty=setup(t);assert.equal(dailyCard(empty,cfg,now),'');
});
test('nonempty completion is folded; long advice preserved but initially hidden',t=>{
 const s=setup(t);s.create(task,'test',cfg,now);s.finish(1,false,cfg,now);
 const suggestion='下一步建议。'.repeat(70),card=dailyCard(s,cfg,now,'morning',suggestion);
 const panels=card.card.body.elements.filter(e=>e.tag==='collapsible_panel');
 assert.equal(panels.length,2);assert.ok(panels.every(p=>p.expanded===false));
 assert.equal(panels[1].elements[0].content,suggestion);
 assert.ok(!card.card.body.elements.some(e=>e.tag==='table'));
});
test('card retries do not start cancellation clock before successful send; only shown cancellations notified',async t=>{
 const s=setup(t);
 for(let i=0;i<95;i++){s.create({...task,title:'取消示例'+i+'字'.repeat(190)},'test',cfg,now);s.finish(i+1,true,cfg,now);}
 const evening=now+12*3600000;
 const build=()=>dailyCard(s,cfg,evening,'evening');
 const preview=build();assert.ok(Buffer.byteLength(JSON.stringify(preview.card))<26000);
 assert.ok(preview.cancel_ids.length<95);
 await tick(s,cfg,async()=>{throw Error('offline');},evening,build);
 assert.equal(s.pendingCancellations().filter(t=>t.cancel_notified_at).length,0);
 await tick(s,cfg,async()=>{},evening+60000,build);
 assert.equal(s.pendingCancellations().filter(t=>t.cancel_notified_at).length,preview.cancel_ids.length);
});
test('transport sends one interactive card, mentions the owner, preserves template and propagates platform failure',async()=>{
 const requests=[],client={im:{message:{create:async r=>{requests.push(r);return {code:0};}}}};
 const event={message:{chat_type:'group',chat_id:'test-group'},sender:{sender_id:{open_id:'test-user'}}};
 const payload={type:'daily_card',card:{schema:'2.0',body:{elements:[]}}};
 await sendFeishuMessage(client,event,payload,'test-message');
 assert.equal(requests.length,1);assert.equal(requests[0].data.msg_type,'interactive');
 assert.match(requests[0].data.content,/<at id=/);assert.equal(payload.card.body.elements.length,0);
 client.im.message.create=async()=>({code:230001});
 await assert.rejects(()=>sendFeishuMessage(client,event,payload),/FEISHU_SEND_230001/);
});
test('daily card caches without executing model writes',async t=>{
 const s=setup(t);s.create(task,'test',cfg,now);let calls=0;
 const e=new Engine(s,()=>cfg,async()=>{calls++;return {reply:'',clarification:null,actions:[{op:'complete',id:1}]};});
 const card=await e.daily('morning',now,'card');assert.equal(card.type,'daily_card');assert.equal(s.get(1).state,'open');
 assert.deepEqual(await e.daily('morning',now,'card'),card);assert.equal(calls,1);
});
test('assignment routing provides own-task context and lets the model resolve references without repeated names',async t=>{
 const s=setup(t),members=[{name:'用户甲',open_id:'a'},{name:'用户乙',open_id:'b'}];
 s.create({...task,title:'把用户乙的事情告诉妈妈'},'test',cfg,now);
 let prompt;
 const self=await routeAssignment('#1 把用户乙的事情告诉妈妈 已完成；删除测试事项',s,cfg,members,members[0],now,async messages=>{prompt=messages;return {route:'self',target:null,task:null,question:null};});
 assert.equal(self.route,'self');assert.equal(JSON.parse(prompt[1].content).own_tasks[0].id,1);
 const clarification=await routeAssignment('给他加一个阅读资料的任务',s,cfg,members,members[0],now,async()=>({route:'clarify',target:null,task:null,question:'给哪位成员？'}));
 rememberQuestion(s,'给他加一个阅读资料的任务',clarification.question,now);
 const assigned=await routeAssignment('对，另一位',s,cfg,members,members[0],now,async()=>({route:'assign',target:'用户乙',task:{...task,title:'阅读资料'},question:null}));
 assert.equal(assigned.member.open_id,'b');
 const switched=await routeAssignment('不删除，保留我的任务',s,cfg,members,members[0],now,async()=>({route:'self',target:null,task:null,question:null}));
 assert.equal(switched.route,'self');assert.equal(s.get(1).state,'open');
});
