import {DateTime} from 'luxon';
export const clockTime=/^([01]\d|2[0-3]):[0-5]\d$/;
export function dateTime(value,zone){
  if(typeof value!=='string')throw new Error('时间格式错误');
  const dt=DateTime.fromISO(value,{zone,setZone:true});
  if(!dt.isValid)throw new Error(`时间无效：${value.slice(0,50)}`);
  return dt.setZone(zone);
}
export function normalizeTask(input,cfg,now=Date.now()){
  const task={title:input.title?.trim(),due:input.due||null,remind_at:input.remind_at||null,priority:input.priority||'normal',recurrence:input.recurrence||null,notes:input.notes||''};
  if(!task.title||task.title.length>200)throw new Error('待办标题应为 1–200 字');
  if(task.due){
    if(!/^\d{4}-\d{2}-\d{2}($|T)/.test(task.due))throw new Error('截止时间应为 ISO 日期');
    const dt=dateTime(task.due,cfg.timezone);
    task.due=task.due.length===10?dt.toISODate():dt.toISO();
  }
  if(task.remind_at){task.remind_at=dateTime(task.remind_at,cfg.timezone).toMillis();}
  else if(task.due){
    const dt=dateTime(task.due,cfg.timezone);
    if(task.due.length===10){const [hour,minute]=cfg.default_reminder_time.split(':').map(Number);task.remind_at=dt.set({hour,minute}).toMillis();}
    else task.remind_at=dt.toMillis();
  }
  if(task.recurrence&&!task.remind_at)throw new Error('循环待办需要首次提醒时间');
  return task;
}
export function nextOccurrence(task,now,zone){
  const step=task.recurrence==='weekly'?7:1;
  let next=DateTime.fromMillis(task.remind_at,{zone});
  const start=next;
  if(next.toMillis()<=now){
    const rough=Math.max(1,Math.floor(DateTime.fromMillis(now,{zone}).startOf('day').diff(next.startOf('day'),'days').days/step));
    next=next.plus({days:rough*step});
    while(next.toMillis()<=now)next=next.plus({days:step});
  }else next=next.plus({days:step});
  const days=Math.round(next.startOf('day').diff(start.startOf('day'),'days').days);
  const due=task.due?dateTime(task.due,zone).plus({days}):null;
  return {remind_at:next.toMillis(),due:due?(task.due.length===10?due.toISODate():due.toISO()):null};
}
export function quietUntil(now,cfg){
  const local=DateTime.fromMillis(now,{zone:cfg.timezone});
  const {start,end}=cfg.quiet_hours;
  if(start===end)return now;
  const hm=local.toFormat('HH:mm');
  const inQuiet=start>end?(hm>=start||hm<end):(hm>=start&&hm<end);
  if(!inQuiet)return now;
  const [hour,minute]=end.split(':').map(Number);
  let until=local.set({hour,minute,second:0,millisecond:0});
  if(until.toMillis()<=now)until=until.plus({days:1});
  return until.toMillis();
}
export function taskDate(task,zone){return task.due?dateTime(task.due,zone).toISODate():task.remind_at?DateTime.fromMillis(task.remind_at,{zone}).toISODate():null;}
export function formatTime(ms,zone){return DateTime.fromMillis(ms,{zone}).toFormat('MM-dd HH:mm');}
