import {z} from 'zod';
import {TaskSchema,requestJSON} from './model.mjs';
import {DateTime} from 'luxon';
const Route=z.object({route:z.enum(['self','assign','clarify']),target:z.string().nullable(),task:TaskSchema.nullable(),question:z.string().nullable()}).strict();
export async function routeAssignment(text,store,cfg,members,sender,now,ask=requestJSON){
 store.db.exec('CREATE TABLE IF NOT EXISTS assignment_question(id INTEGER PRIMARY KEY CHECK(id=1),text TEXT,created INTEGER)');
 let prior=store.db.prepare('SELECT * FROM assignment_question WHERE id=1').get();
 if(prior&&now-prior.created>86400000){store.db.prepare('DELETE FROM assignment_question').run();prior=null;}
 const others=members.filter(m=>m.open_id!==sender.open_id);
 if(!prior&&!others.some(m=>text.includes(m.name))&&!/(给他|给她|帮他|帮她|让他|让她|提醒他|提醒她|对方|另一个人|记在|你要|你明天)/.test(text))return {route:'self'};
 const raw=await ask([{role:'system',content:`你是这个双人群的任务归属判断器。发送人 ${sender.name}。成员列表 ${JSON.stringify(members.map(m=>m.name))}。当前时间 ${DateTime.fromMillis(now,{zone:cfg.timezone}).toISO()}。只输出 JSON {route:'self'|'assign'|'clarify',target:成员完整姓名或null,task:{title,due,remind_at,priority,recurrence,notes}或null,question:string或null}。
你的职责仅是识别“给另一成员新增任务”。其余消息返回 self，由普通秘书理解和执行。相信完整语义，不因出现人名就认定分配：执行者是谁与任务涉及谁是两回事。“把对方的事情告诉妈妈”“提醒我联系对方”属于本人任务。本人复盘、已有任务的完成/取消/改期、查询、闲聊都返回 self，即使任务标题包含另一成员姓名或有多条操作。不要询问本人要删哪项、是否确定删除、是否完成，也不要接管一般待办澄清。
明确给另一成员新增待办/提醒且内容明确时 assign；可以结合当前原话、已有归属问答理解省略和代词，无需强迫用户重复名字。仅在确有跨成员新增意图而接收者或新增内容尚不明确时 clarify。只是提到另一人、不确定是否是跨成员新增，返回 self。上一轮归属提问不是必须继续的流程；当前消息转回本人事项就返回 self。不能修改/取消/查看其他成员已有任务，此类请求交回 self，由普通秘书说明权限。不能声称已执行。
task 字段 title:string,due:带偏移ISO或YYYY-MM-DD或null,remind_at:带偏移ISO或null,priority:low/normal/high,recurrence:daily/weekly/null,notes:string。相对日期按原请求时间理解，当前消息明确变更日期则采用变更。`},{role:'user',content:JSON.stringify({previous_question:prior,current:text,own_tasks:store.open().map(t=>({id:t.id,title:t.title,state:t.state})).slice(0,150)})}],cfg);
 const result=Route.parse(raw);
 if(result.route==='assign'){
  const member=others.find(m=>m.name===result.target);
  if(!member||!result.task)throw new Error('ASSIGNMENT_INVALID');
  // The model resolves references; the program only checks the selected account.
  return {...result,member};
 }
 return result;
}
export function rememberQuestion(store,text,question,now){
 const old=store.db.prepare('SELECT text FROM assignment_question WHERE id=1').get();
 const value=(old?old.text+'\n':'')+text+'\n助手询问：'+question;
 store.db.prepare('INSERT INTO assignment_question VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,created=excluded.created').run(value.slice(-6000),now);
}
