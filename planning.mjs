import {DateTime} from 'luxon';
export function validateSchedule(store,plan,cfg,now){
  const today=DateTime.fromMillis(now,{zone:cfg.timezone}).toISODate();
  const validDate=d=>DateTime.fromISO(d,{zone:cfg.timezone}).isValid&&d>=today;
  const capacities=new Map();
  for(const c of plan.capacity){if(!validDate(c.date)||capacities.has(c.date))throw new Error('可用时间的日期无效或重复');capacities.set(c.date,c.minutes);}
  const ids=new Set(plan.slots.map(s=>s.id)),seen=new Set(),totals=new Map(),perTask=new Map();
  const previous=store.db.prepare('SELECT * FROM allocations ORDER BY task_id,date').all();
  for(const s of previous)if(!ids.has(s.task_id)&&store.get(s.task_id)?.state==='open')totals.set(s.date,(totals.get(s.date)||0)+s.minutes);
  for(const s of plan.slots){
    const t=store.get(s.id),key=`${s.id}:${s.date}`;
    if(!t||t.state!=='open')throw new Error('计划包含已结束、拟取消或不存在的任务');
    if(t.fixed||t.recurrence)throw new Error('固定事项和循环任务保留原安排，请单独确认');
    if(!validDate(s.date)||!capacities.has(s.date)||seen.has(key))throw new Error('每个计划日期需有可用时间，且同一任务每天只安排一段');
    if(t.due&&(s.date>DateTime.fromISO(t.due,{zone:cfg.timezone}).setZone(cfg.timezone).toISODate()||(t.due.length>10&&DateTime.fromISO(t.due,{zone:cfg.timezone}).toMillis()<now)))throw new Error(`「${t.title}」安排超过原截止日期，请先处理冲突`);
    const past=t.due&&(t.due.length===10?t.due<today:DateTime.fromISO(t.due,{zone:cfg.timezone}).toMillis()<now);
    if(past&&!['partial','unfinished'].includes(t.progress))throw new Error(`请先确认「${t.title}」是否完成`);
    seen.add(key);totals.set(s.date,(totals.get(s.date)||0)+s.minutes);
    const rows=perTask.get(s.id)||[];rows.push(s);perTask.set(s.id,rows);
  }
  for(const [date,total] of totals)if(capacities.has(date)&&total>capacities.get(date))throw new Error(`${date} 共安排 ${total} 分钟，超过可用 ${capacities.get(date)} 分钟（含已确认安排）`);
  for(const [id,rows] of perTask){const t=store.get(id),remaining=t.remaining_minutes??t.effort_minutes;
    if(rows.length>1&&t.splittable!==true)throw new Error(`请先确认「${t.title}」可以跨天拆分`);
    if(remaining!==undefined&&remaining!==null&&rows.reduce((n,s)=>n+s.minutes,0)>remaining)throw new Error(`「${t.title}」安排超过已记录的剩余工作量`);
  }
  return previous;
}
export function describeSchedule(store,plan){
  const lines=plan.slots.map(s=>`${s.date} · ${store.get(s.id)?.title||s.id} · ${s.minutes} 分钟：${s.step}`);
  return `${plan.reason}\n${lines.join('\n')}\n可用时间（请核对）：${plan.capacity.map(c=>`${c.date} ${c.minutes}分钟`).join('；')}\n这是所列任务的计划草案，可能只覆盖部分工作量；未列任务继续保留。确认后替换这些任务的执行日安排，原截止日期和提醒不变。`;
}
export function saveSchedule(store,plan,cfg,now){
  const before=validateSchedule(store,plan,cfg,now);
  for(const id of new Set(plan.slots.map(s=>s.id)))store.db.prepare('DELETE FROM allocations WHERE task_id=?').run(id);
  for(const s of plan.slots)store.db.prepare('INSERT INTO allocations VALUES (?,?,?,?)').run(s.id,s.date,s.minutes,s.step);
  const after=store.db.prepare('SELECT * FROM allocations ORDER BY task_id,date').all();
  store.db.prepare('INSERT INTO audit(task_id,action,before_json,created) VALUES (NULL,?,?,?)').run('schedule',JSON.stringify({before,after,capacity:plan.capacity}),now);
  return '已确认执行计划：\n'+plan.slots.map(s=>`${s.date} · ${store.get(s.id).title} · ${s.minutes}分钟：${s.step}`).join('\n')+'\n原截止日期和提醒不变。回复“撤销计划”可撤销最近一次安排。';
}
export function undoSchedule(store,now){
  const row=store.db.prepare("SELECT * FROM audit WHERE action='schedule' ORDER BY id DESC LIMIT 1").get();
  if(!row)return '暂无可撤销的执行计划。';
  const {before,after}=JSON.parse(row.before_json),current=store.db.prepare('SELECT * FROM allocations ORDER BY task_id,date').all();
  if(JSON.stringify(current)!==JSON.stringify(after))return '计划已有其他变更，请重新描述需要调整的事情。';
  store.db.exec('DELETE FROM allocations');
  for(const s of before)store.db.prepare('INSERT INTO allocations VALUES (?,?,?,?)').run(s.task_id,s.date,s.minutes,s.step);
  store.db.prepare("UPDATE audit SET action='schedule_undone' WHERE id=?").run(row.id);
  return '已撤销最近一次执行计划，任务、截止日期和提醒保持不变。';
}
