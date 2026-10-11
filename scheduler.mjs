import {DateTime} from 'luxon';
import {nextOccurrence,quietUntil,taskDate,formatTime} from './time.mjs';
export function line(task,cfg){
  const when=task.due?(task.due.length===10?task.due:DateTime.fromISO(task.due).setZone(cfg.timezone).toFormat('MM-dd HH:mm')):'待安排';
  return `#${task.id} ${task.title}｜${when}${task.remind_at?`｜提醒 ${formatTime(task.remind_at,cfg.timezone)}`:''}${task.recurrence?`｜${task.recurrence==='daily'?'每天':'每周'}`:''}${task.state==='pending_cancel'?'（拟取消，若有误/不取消请及时修改）':''}`;
}
export function digestData(store,cfg,now,kind='evening'){
  const local=DateTime.fromMillis(now,{zone:cfg.timezone}),today=local.toISODate(),target=kind==='morning'?today:local.plus({days:1}).toISODate();
  const tasks=store.open().filter(t=>t.state==='open');
  const slots=store.db.prepare('SELECT * FROM allocations WHERE date=? ORDER BY task_id').all(target).filter(s=>store.get(s.task_id)?.state==='open');
  const relevant=tasks.filter(t=>t.awaiting_completion||(taskDate(t,cfg.timezone)&&taskDate(t,cfg.timezone)<=today)||store.db.prepare('SELECT 1 FROM allocations WHERE task_id=? AND date<=? LIMIT 1').get(t.id,today)||t.progress==='partial'||t.progress==='unfinished');
  const unknown=relevant.filter(t=>!['partial','unfinished'].includes(t.progress));
  const unfinished=relevant.filter(t=>['partial','unfinished'].includes(t.progress));
  const start=local.startOf('day').toMillis();
  const completed=store.db.prepare("SELECT DISTINCT task_id FROM audit WHERE action='complete' AND created>=? AND created<=?").all(start,now).map(r=>store.get(r.task_id)).filter(Boolean);
  const missing=tasks.filter(t=>!t.remind_at||!t.reminder_explicit);
  const cancelling=kind==='evening'?store.pendingCancellations().filter(t=>!t.cancel_notified_at):[];
  const targetTasks=tasks.filter(t=>taskDate(t,cfg.timezone)===target);
  return {today,target,kind,tasks,slots,unknown,unfinished,completed,missing,cancelling,targetTasks};
}
export function digest(store,cfg,now,kind='evening'){
  const {target,tasks,slots,unknown,unfinished,completed,missing,cancelling,targetTasks}=digestData(store,cfg,now,kind);
  const section=(name,rows)=>rows.length?name+'\n'+rows.slice(0,30).map(t=>line(t,cfg)+(t.progress==='partial'?'｜部分完成':'')+(t.remaining_minutes!=null?`｜剩余 ${t.remaining_minutes} 分钟`:'')).join('\n')+(rows.length>30?`\n另有 ${rows.length-30} 项`: ''):'';
  const knownMinutes=unfinished.reduce((n,t)=>n+(t.remaining_minutes??(t.progress==='partial'?0:t.effort_minutes)??0),0);
  const sections=[
    section('今天已确认完成',completed),
    section(kind==='morning'?'今日事项':'明日事项',targetTasks),
    slots.length?'执行安排\n'+slots.map(s=>`${store.get(s.task_id).title}｜${s.minutes}分钟${s.step?'｜'+s.step:''}`).join('\n'):'',
    section('尚未完成',unfinished)+(unfinished.length&&knownMinutes?`\n已知剩余约 ${knownMinutes} 分钟。`:''),
    section('完成情况待确认',unknown),
    section('请补充或确认提醒时间',missing),
    section('拟取消事项',cancelling)+(cancelling.length?'\n本次通知后24小时未修改，将正式取消。':'')
  ].filter(Boolean);
  return sections.length?`${kind==='morning'?'今日':'明日'}清单 · ${target}\n\n`+sections.join('\n\n'):'';
}
export async function tick(store,cfg,send,now=Date.now(),buildDaily=null){
  store.ensureCancellation();
  store.db.prepare("UPDATE tasks SET state='cancelled',revision=revision+1,updated=? WHERE state='pending_cancel' AND cancel_notified_at IS NOT NULL AND cancel_notified_at<=?").run(now,now-86400000);
  const local=DateTime.fromMillis(now,{zone:cfg.timezone}),today=local.toISODate();
  if(local.toFormat('HH:mm')>=cfg.evening_digest_time){
    store.db.prepare('INSERT OR IGNORE INTO jobs(id,kind,run_at) VALUES (?,?,?)').run(`digest:${today}`,'digest',now);
  }
  if(cfg.morning_digest_time&&local.toFormat('HH:mm')>=cfg.morning_digest_time&&local.toFormat('HH:mm')<cfg.evening_digest_time){store.db.prepare('INSERT OR IGNORE INTO jobs(id,kind,run_at) VALUES (?,?,?)').run(`morning:${today}`,'morning',now);}
  const jobs=store.db.prepare("SELECT * FROM jobs WHERE state='pending' AND run_at<=? ORDER BY run_at LIMIT 10").all(now);
  for(const job of jobs){
    if((job.kind==='digest'&&job.id!==`digest:${today}`)||(job.kind==='morning'&&(job.id!==`morning:${today}`||local.toFormat('HH:mm')>=cfg.evening_digest_time))){store.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id);continue;}
    let task=null;
    if(job.kind==='task'){
      task=store.get(job.task_id);
      if(!task||task.state!=='open'||task.revision!==job.revision){store.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id);continue;}
    }
    if(job.kind!=='test'&&job.payload!=='explicit_test_bypass_quiet'){
      const later=quietUntil(now,cfg);
      if(later>now){store.db.prepare('UPDATE jobs SET run_at=? WHERE id=?').run(later,job.id);continue;}
    }
    let text=job.kind==='review_notice'?job.payload:['digest','morning'].includes(job.kind)?digest(store,cfg,now,job.kind==='morning'?'morning':'evening'):job.kind==='test'?'测试提醒：本地持久化提醒和主动推送已运行。':`待办提醒\n${line(task,cfg)}${now-task.remind_at>120000?'\n这是恢复连接或免打扰结束后的补发提醒。':''}\n回复“完成 ${task.id}”或“推迟 ${task.id} 30分钟”。`;
    text=text.replace('${task.id}',String(task?.id||'' )).replace('${task.id}',String(task?.id||''));
    let cancellationSnapshot=job.kind==='digest'?store.pendingCancellations().filter(t=>!t.cancel_notified_at):[];
    try{
      if(buildDaily&&['digest','morning'].includes(job.kind))text=await buildDaily(job.kind==='morning'?'morning':'evening',now);
      if(text?.type==='daily_card')cancellationSnapshot=cancellationSnapshot.filter(t=>text.cancel_ids.includes(t.id));
      if(text?.type==='daily_card'||typeof text==='string'&&text.trim())await send(text);
      else {store.db.prepare("UPDATE jobs SET state='sent',last_error=NULL WHERE id=?").run(job.id);continue;}
      store.tx(()=>{
        store.db.prepare("UPDATE jobs SET state='sent',attempts=attempts+1,last_error=NULL WHERE id=?").run(job.id);
        for(const t of cancellationSnapshot)store.db.prepare("UPDATE tasks SET cancel_notified_at=? WHERE id=? AND state='pending_cancel' AND revision=? AND cancel_notified_at IS NULL").run(now,t.id,t.revision);
        if(task?.recurrence){
          const next=nextOccurrence(task,now,cfg.timezone);
          store.db.prepare('UPDATE tasks SET due=?,remind_at=?,awaiting_completion=1,revision=revision+1,updated=? WHERE id=?').run(next.due,next.remind_at,now,task.id);
          store.schedule(store.get(task.id),now);
        }
      });
    }catch{
      const attempts=job.attempts+1;
      store.db.prepare('UPDATE jobs SET attempts=?,last_error=?,run_at=? WHERE id=?').run(attempts,'send_failed',now+Math.min(3600000,15000*2**Math.min(attempts,8)),job.id);
    }
  }
}
