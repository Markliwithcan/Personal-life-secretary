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
仅当明确要求给另一成员新增待办/提醒，且事情内容明确时 assign。只是提到另一个人、与对方一起做事不等于给对方任务。“提醒我找某人”属于 self。“提醒某人做某事”属于给某人新增。代词他/她/你指谁不明确要 clarify，不能猜。可以利用当前发送者上一轮待澄清请求和回答消除歧义，不能利用别人的私人历史。不确定是不是要建待办或分配给谁时 clarify，提出一句具体问题。修改/取消/查看其他成员事项不允许，clarify 请当事人操作。不能输出任何操作指令或声称已完成。
task 字段 title:string,due:带偏移ISO或YYYY-MM-DD或null,remind_at:带偏移ISO或null,priority:low/normal/high,recurrence:daily/weekly/null,notes:string。相对日期按原请求时间理解，当前消息明确变更日期则采用变更。`},{role:'user',content:JSON.stringify({previous_question:prior,current:text})}],cfg);
 const result=Route.parse(raw);
 if(result.route==='assign'){
  const member=others.find(m=>m.name===result.target);
  if(!member||!result.task)throw new Error('ASSIGNMENT_INVALID');
  // A concrete recipient must appear in the request/clarification chain.
  if(!text.includes(member.name)&&!prior?.text.includes(member.name))return {route:'clarify',question:`这件事是给${member.name}添加，还是给你自己添加？`};
  return {...result,member};
 }
 return result;
}
export function rememberQuestion(store,text,question,now){
 const old=store.db.prepare('SELECT text FROM assignment_question WHERE id=1').get();
 const value=(old?old.text+'\n':'')+text+'\n助手询问：'+question;
 store.db.prepare('INSERT INTO assignment_question VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,created=excluded.created').run(value.slice(-6000),now);
}
