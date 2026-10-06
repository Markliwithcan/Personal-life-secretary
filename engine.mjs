import crypto from 'node:crypto';
import {DateTime} from 'luxon';
import {Plan,understand} from './model.mjs';
import {line,digest} from './scheduler.mjs';
import {taskDate,clockTime,normalizeTask} from './time.mjs';
import {validateSchedule,describeSchedule,saveSchedule,undoSchedule} from './planning.mjs';
export const HELP=`可以自然聊天，也可以用以下指令（无需模型）：
添加 买牙膏
提醒 10分钟 喝水
待办 / 明天 / 逾期 / 记忆
完成 1 / 取消 买牛奶 / 不取消 买牛奶 / 推迟 1 30分钟
晚间清单 21:30
今日清单 / 执行计划 / 撤销计划
可以说“我有半小时，接下来做什么”“报告做了一半，还剩45分钟”
语音记录 / 修改语音 正确全文 / 修改语音 3 正确全文
补时间 1 2026-09-18 09:00
漏记候选 / 补记 1 / 忽略 1
测试提醒（10 秒）
发送 .xlsx 或 .csv 计划表，先预览再确认导入。
循环任务完成只确认本次，取消才停止循环。电脑关机时无法提醒，重连后补发。
回复“帮助”可再次查看。`;
const cleanTask=title=>({title,due:null,remind_at:null,priority:'normal',recurrence:null,notes:''});
export class Engine{
  constructor(store,settings,model=understand){this.store=store;this.settings=settings;this.model=model;}
  cfg(){return this.store.config(this.settings());}
  list(scope,cfg,now){
    let tasks=this.store.open();
    const local=DateTime.fromMillis(now,{zone:cfg.timezone});
    if(scope==='tomorrow')tasks=tasks.filter(t=>taskDate(t,cfg.timezone)===local.plus({days:1}).toISODate());
    if(scope==='overdue')tasks=tasks.filter(t=>t.due&&(t.due.length===10?t.due<local.toISODate():DateTime.fromISO(t.due).toMillis()<now));
    return tasks.length?tasks.slice(0,60).map(t=>line(t,cfg)).join('\n')+(tasks.length>60?`\n共 ${tasks.length} 项，当前显示前 60 项。`:''):'暂无符合条件的待办。';
  }
  apply(actions,source,cfg,now){
    const responses=[];
    for(const a of actions){
      switch(a.op){
        case 'schedule':responses.push(saveSchedule(this.store,a,cfg,now));break;
        case 'create':responses.push('已记下：'+line(this.store.create(a.task,source,cfg,now),cfg));break;
        case 'update':responses.push('已修改：'+line(this.store.update(a.id,a.patch,cfg,now),cfg));break;
        case 'complete':{const t=this.store.finish(a.id,false,cfg,now);responses.push(t.recurrence?`已完成本次，保留下次提醒：${line(t,cfg)}`:`已完成 #${a.id} ${t.title}`);break;}
        case 'cancel':{const t=this.store.finish(a.id,true,cfg,now);responses.push(t.state==='pending_cancel'?`已拟取消「${t.title}」，暂停事项提醒。晚间清单会再确认，成功推送后满 24 小时未修改才正式取消。说“不取消 ${t.title}”即可恢复。`:`已取消 #${a.id} ${t.title}，相关提醒已停止。`);break;}
        case 'restore':{const t=this.store.restore(a.id,cfg,now);responses.push(`已恢复「${t.title}」，继续保留待办和提醒。`);break;}
        case 'query':responses.push(this.list(a.scope,cfg,now));break;
        case 'remember':this.store.db.prepare('INSERT INTO memories VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(a.key,a.value);responses.push(`已记住：${a.key} — ${a.value}`);break;
        case 'forget':this.store.db.prepare('DELETE FROM memories WHERE key=?').run(a.key);responses.push(`已移除长期记忆：${a.key}`);break;
        case 'preference':this.store.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(a.key,a.value);responses.push(`已设置${a.key==='evening_digest_time'?'晚间清单时间':'新增待办的默认提醒时间'}：${a.value}（${cfg.timezone}）`);break;
      }
      if(['create','update','complete','cancel','restore'].includes(a.op)){
        const taskId=a.op==='create'?this.store.db.prepare('SELECT MAX(id) id FROM tasks').get().id:a.id;
        this.store.db.prepare('INSERT OR IGNORE INTO message_tasks VALUES (?,?)').run(source,taskId);
      }
    }
    return responses.join('\n\n');
  }
  stage(kind,payload,now){
    const id=crypto.randomBytes(3).toString('hex');
    this.store.db.prepare('INSERT INTO pending VALUES (?,?,?,?)').run(id,kind,JSON.stringify(payload),now);return id;
  }
  async process(id,text,now=Date.now()){
    const previous=this.store.receipt(id);if(previous!==undefined)return previous;
    if(text.length>12000)return this.commit(id,text,'消息较长，请拆成几段发送；本条尚未建立待办。',now);
    const cfg=this.cfg();let actions=null,response=null,plan=null;
    let m;
    const descriptive=text.match(/^(不取消|恢复|保留|取消)\s*(.+)$/s);
    const candidates=descriptive&&!/^#?\d+$/.test(descriptive[2])?this.store.open().filter(t=>(descriptive[1]==='取消'||t.state==='pending_cancel')&&(t.title===descriptive[2].trim()||t.title.includes(descriptive[2].trim()))):[];
    if(candidates.length===1)actions=[{op:descriptive[1]==='取消'?'cancel':'restore',id:candidates[0].id}];
    else if(candidates.length>1)response='你指的是哪件事？请补充名称：\n'+candidates.map(t=>t.title).join('\n');
    else if(text==='帮助')response=HELP;
    else if(text==='语音记录'){
      const rows=this.store.db.prepare('SELECT * FROM voices ORDER BY id DESC LIMIT 10').all();
      response=rows.length?rows.map(v=>`V${v.id}：${v.corrected||v.original}`).join('\n')+'\n回复“修改语音 编号 正确全文”。':'暂无已保存的语音转写。';
    }
    else if((m=text.match(/^修改语音\s+(?:[Vv]?(\d+)\s+)?(.+)$/s)))return this.correctVoice(id,m[1]?Number(m[1]):null,m[2].trim(),now);
    else if((m=text.match(/^补时间\s*#?(\d+)\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/))){actions=[{op:'update',id:Number(m[1]),patch:{remind_at:`${m[2]}T${m[3]}:00`}}];}
    else if(text==='漏记候选'){
      const rows=this.store.db.prepare("SELECT * FROM review_candidates WHERE state='pending' ORDER BY id").all();
      response=rows.length?rows.map(r=>`R${r.id} ${JSON.parse(r.task).title}\n原话：${r.evidence}`).join('\n')+'\n回复“补记 编号”或“忽略 编号”。':'暂无待确认的漏记候选。';
    }
    else if((m=text.match(/^(补记|忽略)\s*[Rr]?(\d+)$/))){
      const row=this.store.db.prepare("SELECT * FROM review_candidates WHERE id=? AND state='pending'").get(Number(m[2]));
      if(!row)response='候选不存在或已处理。';
      else return this.store.tx(()=>{
        const task=JSON.parse(row.task);
        if(m[1]==='忽略'){this.store.db.prepare("UPDATE review_candidates SET state='ignored' WHERE id=?").run(row.id);response='已忽略，不会再次提议同一候选。';}
        else if(this.store.all().some(t=>t.title.trim()===task.title.trim())){this.store.db.prepare("UPDATE review_candidates SET state='duplicate' WHERE id=?").run(row.id);response='已有同名事项，未重复建立。';}
        else{response=this.apply([{op:'create',task}],id,cfg,now);this.store.db.prepare("UPDATE review_candidates SET state='accepted' WHERE id=?").run(row.id);}
        return this.commit(id,text,response,now);
      });
    }
    else if(['待办','明天','逾期'].includes(text))response=this.list({待办:'all',明天:'tomorrow',逾期:'overdue'}[text],cfg,now);
    else if(text==='明日清单'||text==='今日清单')response=digest(this.store,cfg,now,text==='今日清单'?'morning':'evening')||'当前没有需要提醒或确认的事项。';
    else if(text==='执行计划'){const rows=this.store.db.prepare('SELECT * FROM allocations WHERE date>=? ORDER BY date,task_id').all(DateTime.fromMillis(now,{zone:cfg.timezone}).toISODate());response=rows.filter(r=>this.store.get(r.task_id)?.state==='open').map(r=>`${r.date} · ${this.store.get(r.task_id).title} · ${r.minutes}分钟：${r.step}`).join('\n')||'暂无已确认执行计划。可以告诉我接下来几天各有多少空闲时间。';}
    else if(text==='撤销计划')return this.store.tx(()=>this.commit(id,text,undoSchedule(this.store,now),now));
    else if(text==='记忆'){const rows=this.store.db.prepare('SELECT * FROM memories').all();response=rows.length?rows.map(r=>`${r.key}：${r.value}`).join('\n'):'暂无长期记忆。';}
    else if((m=text.match(/^添加\s+(.+)$/s)))actions=[{op:'create',task:cleanTask(m[1].trim())}];
    else if((m=text.match(/^提醒\s+(\d+)\s*(秒|分钟|小时|天)\s+(.+)$/s))){
      const ms=Number(m[1])*{秒:1000,分钟:60000,小时:3600000,天:86400000}[m[2]];
      if(ms<=0||ms>366*86400000)response='提醒间隔须大于 0，且不超过 366 天。';
      else actions=[{op:'create',task:{...cleanTask(m[3].trim()),remind_at:new Date(now+ms).toISOString()}}];
    }
    else if((m=text.match(/^(完成|取消)\s*#?(\d+)$/)))actions=[{op:m[1]==='完成'?'complete':'cancel',id:Number(m[2])}];
    else if((m=text.match(/^推迟\s*#?(\d+)\s+(\d+)\s*(分钟|小时|天)$/))){
      const ms=Number(m[2])*{分钟:60000,小时:3600000,天:86400000}[m[3]];
      if(ms<=0||ms>366*86400000)response='推迟间隔须大于 0，且不超过 366 天。';
      else actions=[{op:'update',id:Number(m[1]),patch:{remind_at:new Date(now+ms).toISOString()}}];
    }
    else if((m=text.match(/^晚间清单\s+(\d\d:\d\d)$/))&&clockTime.test(m[1]))actions=[{op:'preference',key:'evening_digest_time',value:m[1]}];
    else if(text==='测试提醒'){
      return this.store.tx(()=>{this.store.db.prepare('INSERT OR IGNORE INTO jobs(id,kind,run_at) VALUES (?,?,?)').run(`test:${id}`,'test',now+10000);return this.commit(id,text,'已设置测试提醒，约 10 秒后发送；即使程序重启也会保留。',now);});
    }
    else if((m=text.match(/^预览\s+([a-f0-9]{6})$/i))){
      const pending=this.store.db.prepare('SELECT * FROM pending WHERE id=?').get(m[1].toLowerCase());
      if(!pending||now-pending.created>86400000)response='预览编号不存在或已过期。';
      else{
        const p=JSON.parse(pending.payload);
        response=pending.kind==='import'?p.tasks.map((t,i)=>`${i+1}. ${t.title}｜截止 ${t.due||'待安排'}｜提醒 ${t.remind_at||'按默认规则'}｜${t.recurrence||'不重复'}\n${t.notes||''}`).join('\n'):JSON.stringify((p.plan||p).actions,null,2);
      }
    }
    else if((m=text.match(/^确认\s+([a-f0-9]{6})$/i))){
      const pending=this.store.db.prepare('SELECT * FROM pending WHERE id=?').get(m[1].toLowerCase());
      if(!pending||now-pending.created>86400000)response='确认编号不存在或已过期，请重新发送原请求或文件。';
      else{
        const payload=JSON.parse(pending.payload);
        try{return this.store.tx(()=>{
          if(pending.kind==='import'&&this.store.db.prepare('SELECT hash FROM imports WHERE hash=?').get(payload.hash))response='这份表格已经导入，无需重复操作。';
          else{
            if(pending.kind==='import'){
              const selected=[],skipped=[];
              const titles=new Set(this.store.all().map(t=>t.title.trim()));
              for(const row of payload.tasks){if(titles.has(row.title.trim()))skipped.push(row.title);else{selected.push({op:'create',task:row});titles.add(row.title.trim());}}
              const detail=this.apply(selected,payload.source,cfg,now);
              this.store.db.prepare('INSERT INTO imports VALUES (?,?)').run(payload.hash,now);
              response=`已导入 ${selected.length} 项；跳过 ${skipped.length} 项同名待办，避免重复或覆盖。${skipped.length?'\n同名项需要单独核对并修改。':''}\n${detail}`;
            }else{
              for(const [taskId,revision] of Object.entries(payload.revisions||{}))if(this.store.get(Number(taskId))?.revision!==revision)throw new Error('预览后相关待办已发生变化，请重新发送原请求');
              response=this.apply(Plan.parse(payload.plan||payload).actions,id,cfg,now);
            }
          }
          this.store.db.prepare('DELETE FROM pending WHERE id=?').run(pending.id);
          return this.commit(id,text,response,now);
        });}catch(e){response=`本次没有执行变更：${e.message}`;}
      }
    }
    else if((m=text.match(/^放弃\s+([a-f0-9]{6})$/i))){this.store.db.prepare('DELETE FROM pending WHERE id=?').run(m[1].toLowerCase());response='已放弃该批操作。';}
    else{
      try{plan=Plan.parse(await this.model(text,this.store,cfg,now));}
      catch(e){
        response=e.message==='MODEL_NOT_CONFIGURED'?'模型还未配置，本条尚未建立待办。可先用“添加 买牙膏”“提醒 10分钟 喝水”等指令；回复“帮助”查看。':`模型暂时不可用（${/^MODEL_[A-Z0-9_]+$/.test(e.message)?e.message:'MODEL_RESPONSE_INVALID'}），本条没有变更待办。请稍后重发，或使用明确指令。`;
      }
      if(plan){
        if(plan.clarification)response=plan.clarification;
        else if(plan.actions.some(a=>a.op==='schedule')){
          try{
            if(plan.actions.length!==1)throw new Error('请先记录进度，再单独生成执行计划');
            const proposal=plan.actions[0];validateSchedule(this.store,proposal,cfg,now);
            const revisions=Object.fromEntries(proposal.slots.map(s=>[s.id,this.store.get(s.id).revision]));
            const pendingId=this.stage('actions',{plan,revisions},now);
            response=describeSchedule(this.store,proposal)+`\n回复“确认 ${pendingId}”采用，或直接告诉我怎么改。回复“放弃 ${pendingId}”放弃。`;
          }catch(e){response=`尚未更改计划：${e.message}。\n${plan.reply||''}`;}
        }
        else if(plan.actions.filter(a=>!['query'].includes(a.op)).length>5||plan.actions.filter(a=>a.op==='cancel'||a.op==='forget').length>1){
          const revisions={};for(const action of plan.actions)if(action.id)revisions[action.id]=this.store.get(action.id)?.revision??null;
          const pendingId=this.stage('actions',{plan,revisions},now);
          response=`这次涉及批量操作，请核对：\n${plan.actions.map(a=>`${a.op} ${a.id?'#'+a.id:''} ${a.task?.title||a.patch?.title||a.key||''}`).join('\n')}\n回复“预览 ${pendingId}”查看全部变更。确认执行请回复“确认 ${pendingId}”，放弃请回复“放弃 ${pendingId}”。`;
        }else if(plan.actions.length)actions=plan.actions;
        else response=plan.reply||'这条消息暂未提取到明确待办。';
      }
    }
    if(actions){
      try{return this.store.tx(()=>{const valid=Plan.parse({reply:'',clarification:null,actions});return this.commit(id,text,[this.apply(valid.actions,id,cfg,now),plan?.reply].filter(Boolean).join('\n\n'),now);});}
      catch(e){response=`本次没有执行变更：${e.message}`;}
    }
    return this.commit(id,text,response||'请再说具体一点，我还没确定要记录什么。',now);
  }
  async daily(kind,now=Date.now()){
    const cfg=this.cfg(),day=DateTime.fromMillis(now,{zone:cfg.timezone}).toISODate(),key=`${kind}:${day}`;
    const snapshot=JSON.stringify({format:2,tasks:this.store.all(),allocations:this.store.db.prepare('SELECT * FROM allocations ORDER BY task_id,date').all()});
    const existing=this.store.db.prepare('SELECT body,snapshot FROM briefings WHERE id=?').get(key);if(existing?.snapshot===snapshot)return existing.body;
    let body=digest(this.store,cfg,now,kind);
    if(!body)return '';
    if(this.store.open().some(t=>t.state==='open')){
      try{
        const plan=Plan.parse(await this.model(`请对${kind==='morning'?'今天':'明天'}给出简短秘书建议。先回顾已确认完成、明确未完成/部分完成、完成情况待确认。只读分析，不创建/修改/完成任务。若已知用户各日可用时间、剩余量、可拆分性，可返回唯一 schedule 草案；否则仅在有额外建议时用一两句话给出下一步或必要问题，可返回空 reply。不重复清单，不写操作示例、回复指南、空栏目或“暂无”，不虚构可用时间。不确定项早晚继续询问，未答不改状态，不评判任务价值。`,this.store,cfg,now));
        if(plan.actions.length===1&&plan.actions[0].op==='schedule'&&!plan.clarification){
          const p=plan.actions[0];validateSchedule(this.store,p,cfg,now);
          const revisions=Object.fromEntries(p.slots.map(s=>[s.id,this.store.get(s.id).revision]));
          const id=this.stage('actions',{plan,revisions},now);body+='\n\n秘书建议（待确认）：\n'+describeSchedule(this.store,p)+`\n回复“确认 ${id}”采用，或直接告诉我怎么调整。`;
        }else if(!plan.actions.length&&(plan.clarification||plan.reply)?.trim())body+='\n\n'+(plan.clarification||plan.reply).trim();
      }catch{/* The deterministic briefing remains usable without model advice. */}
    }
    this.store.db.prepare('INSERT INTO briefings VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,snapshot=excluded.snapshot,created=excluded.created').run(key,body,snapshot,now);
    this.store.addHistory('assistant',body,now);return body;
  }
  commit(id,input,response,now){
    if(!this.store.inTransaction)return this.store.tx(()=>this.commit(id,input,response,now));
    this.store.rememberReceipt(id,response,now);this.store.addHistory('user',input,now);this.store.addHistory('assistant',response,now);this.store.cleanup(now,this.cfg().store_chat_days);return response;
  }
  async processVoice(id,text,now=Date.now()){
    this.store.db.prepare('INSERT OR IGNORE INTO voices(message_id,original,created) VALUES (?,?,?)').run(id,text,now);
    const voice=this.store.db.prepare('SELECT * FROM voices WHERE message_id=?').get(id);
    const response=await this.process(id,text,now);
    return `语音转写 V${voice.id}：“${voice.corrected||voice.original}”\n${response}\n如听错，回复“修改语音 ${voice.id} 正确的完整内容”。`;
  }
  async correctVoice(id,voiceId,corrected,now){
    const voice=voiceId?this.store.db.prepare('SELECT * FROM voices WHERE id=?').get(voiceId):this.store.db.prepare('SELECT * FROM voices ORDER BY id DESC LIMIT 1').get();
    if(!voice)return this.commit(id,'修改语音 '+corrected,'没有找到语音记录，请先发送语音或使用“语音记录”查看。',now);
    const linked=this.store.db.prepare('SELECT task_id FROM message_tasks WHERE message_id=?').all(voice.message_id).map(r=>r.task_id);
    let plan;
    try{
      const request=`用户正在纠正语音 V${voice.id}，原转写=${JSON.stringify(voice.corrected||voice.original)}；正确完整转写=${JSON.stringify(corrected)}。原语音关联的任务 ID=${JSON.stringify(linked)}。仅修正这些关联任务，不操作其他任务；尽量 update 现有任务，不能重复 create 同一事项。相对日期按原语音时间 ${DateTime.fromMillis(voice.created,{zone:this.cfg().timezone}).toISO()} 理解。不明确请 clarification。`;
      plan=Plan.parse(await this.model(request,this.store,this.cfg(),now));
      if(plan.actions.some(a=>!['create','update','cancel'].includes(a.op)||a.id&&!linked.includes(a.id)))throw new Error('不允许修改无关任务');
      if(linked.length&&plan.actions.some(a=>a.op==='create'))throw new Error('已有关联待办，请明确要改哪一项；尚未创建新待办');
    }catch{return this.commit(id,'修改语音 '+corrected,'暂时无法可靠处理这次更正，原语音和待办均未修改。请稍后重试，或直接说“把第 X 项改成……” 。',now);}
    if(plan.clarification)return this.commit(id,'修改语音 '+corrected,plan.clarification+'\n原记录暂未更改。',now);
    try{return this.store.tx(()=>{
      const result=this.apply(plan.actions,voice.message_id,this.cfg(),now);
      this.store.db.prepare('UPDATE voices SET corrected=?,revision=revision+1 WHERE id=?').run(corrected,voice.id);
      this.store.db.prepare("UPDATE history SET content=? WHERE role='user' AND created=? AND content=?").run(`[语音 V${voice.id} 已更正] ${corrected}`,voice.created,voice.corrected?`[语音 V${voice.id} 已更正] ${voice.corrected}`:voice.original);
      return this.commit(id,`语音 V${voice.id} 更正为：${corrected}`,`已更正语音 V${voice.id}：“${corrected}”\n${result||'没有变更待办。'}`,now);
    });}catch{return this.commit(id,'修改语音 '+corrected,'更正未执行，关联待办可能已完成或取消。请用“待办”查看后指定要修改的任务。',now);}
  }
  previewImport(id,result,hash,source,now=Date.now()){
    const prior=this.store.receipt(id);if(prior!==undefined)return prior;
    return this.store.tx(()=>{
      let response;
      if(this.store.db.prepare('SELECT hash FROM imports WHERE hash=?').get(hash))response='这份文件已经导入，不会重复建立待办。';
      else if(!result.tasks.length)response=`没有找到可导入的事项。${result.warnings.join('\n')}`;
      else{
        const validated=[];
        for(const task of result.tasks){try{normalizeTask(task,this.cfg(),now);validated.push(task);}catch(e){result.warnings.push(`${task.title} 未加入预览：${e.message}`);}}
        result.tasks=validated;
        if(!result.tasks.length)return this.commit(id,`[收到计划表：${source}]`,'没有可导入事项：'+result.warnings.join('\n'),now);
        const pending=this.stage('import',{tasks:result.tasks,hash,source},now);
        response=`识别到 ${result.tasks.length} 项，尚未导入：\n${result.tasks.slice(0,15).map(t=>`${t.title}｜${t.due||'待安排'}${t.remind_at?'｜提醒 '+t.remind_at:''}`).join('\n')}${result.tasks.length>15?'\n（预览前 15 项）':''}\n${result.warnings.slice(0,10).join('\n')}\n回复“预览 ${pending}”查看完整内容；“确认 ${pending}”导入；“放弃 ${pending}”取消。同名待办会跳过，不覆盖原计划。`;
      }
      return this.commit(id,`[收到计划表：${source}]`,response,now);
    });
  }
}
