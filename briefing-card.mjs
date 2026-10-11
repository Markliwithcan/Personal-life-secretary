import {DateTime} from 'luxon';
import crypto from 'node:crypto';
import {digestData} from './scheduler.mjs';

const markdown=content=>({tag:'markdown',content});
const safe=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])).replace(/[\\`*_\[\]]/g,'\\$&');
const fold=(title,content)=>({tag:'collapsible_panel',expanded:false,header:{title:{tag:'plain_text',content:title}},elements:[markdown(content)]});

// Presentation uses the existing task state; no model-generated task statistics.
export function dailyCard(store,cfg,now,kind='evening',advice=''){
  const d=digestData(store,cfg,now,kind),title=kind==='morning'?'今日安排':'明日安排';
  const targetIds=new Set(d.targetTasks.map(t=>t.id)),unknownIds=new Set(d.unknown.map(t=>t.id));
  const missingIds=new Set(d.missing.map(t=>t.id));
  const slots=new Map(d.slots.map(s=>[s.task_id,s]));
  // Cancellations stay visible so the 24h clock cannot start for an omitted item.
  const unique=new Map();
  for(const t of [...d.cancelling,...d.targetTasks,...d.slots.map(s=>store.get(s.task_id)),...d.unfinished,...d.unknown,...d.missing])if(t)unique.set(t.id,t);
  const all=[...unique.values()],shown=all.slice(0,80),cancelIds=new Set(d.cancelling.map(t=>t.id));
  if(!all.length&&!d.completed.length)return '';
  const counts=[d.targetTasks.length?`${kind==='morning'?'今日':'明日'} ${d.targetTasks.length} 项`:null,d.completed.length?`已完成 ${d.completed.length} 项`:null,d.unknown.length?`进度待确认 ${d.unknown.length} 项`:null,d.missing.length?`时间待定 ${d.missing.length} 项`:null,d.cancelling.length?`拟取消 ${d.cancelling.length} 项`:null].filter(Boolean);
  const elements=[markdown(counts.join('　·　')||`待处理 ${all.length} 项`)];
  const rows=shown.map(t=>{
    const status=[];
    const add=(text,color)=>status.push({text,color});
    if(cancelIds.has(t.id))add('拟取消','orange');
    else{
      if(targetIds.has(t.id))add(kind==='morning'?'今日':'明日','blue');
      if(t.progress==='partial')add('部分完成','orange');
      else if(t.progress==='unfinished')add('未完成','orange');
      else if(unknownIds.has(t.id))add('进度待确认','purple');
      if(missingIds.has(t.id))add('时间待定','grey');
      if(slots.has(t.id))add('已安排','blue');
    }
    let time='待安排';
    if(t.remind_at){const dt=DateTime.fromMillis(t.remind_at,{zone:cfg.timezone});time=(dt.toISODate()===d.target?dt.toFormat('HH:mm'):dt.toFormat('MM-dd HH:mm'))+(t.reminder_explicit?'':'（待确认）');}
    else if(t.due)time=t.due.length===10?t.due:DateTime.fromISO(t.due).setZone(cfg.timezone).toFormat('MM-dd HH:mm');
    const allocation=slots.get(t.id);
    const detail=allocation?`${allocation.minutes}分钟 · ${allocation.step}`:t.remaining_minutes!=null?`剩余 ${t.remaining_minutes} 分钟`:'';
    return {task:t.title+(detail?'\n'+detail:''),time,status};
  });
  if(rows.length)elements.push({tag:'table',page_size:5,row_height:'auto',row_max_height:'72px',header_style:{background_style:'grey',bold:true},columns:[{name:'task',display_name:'事项',data_type:'text',width:'50%'},{name:'time',display_name:'时间',data_type:'text',width:'25%'},{name:'status',display_name:'状态',data_type:'options',width:'25%'}],rows});
  const completed=d.completed.filter(t=>!unique.has(t.id));
  if(completed.length)elements.push(fold(`今天已完成 · ${completed.length} 项`,completed.slice(0,10).map(t=>'✓ '+safe(t.title)).join('\n')+(completed.length>10?`\n另有 ${completed.length-10} 项`:'')));
  if(d.cancelling.length)elements.push(markdown('表内拟取消事项本次通知成功后，满24小时未修改将正式取消。'));
  const suggestion=advice.trim();
  if(suggestion){
    if(suggestion.length<=240)elements.push(markdown('**秘书建议**\n'+suggestion));
    else elements.push(fold('秘书建议 · 展开查看',suggestion));
  }
  const card={schema:'2.0',header:{template:kind==='morning'?'blue':'indigo',title:{tag:'plain_text',content:`${title} · ${d.target}`},subtitle:{tag:'plain_text',content:cfg.timezone}},body:{elements}};
  // Leave room for the recipient mention and transport fields under Feishu's size limit.
  while(rows.length>1&&Buffer.byteLength(JSON.stringify(card))>24000){rows.pop();shown.pop();}
  if(all.length>shown.length)elements.push(markdown(`另有 ${all.length-shown.length} 项未展开，可在聊天查询完整待办。`));
  return {type:'daily_card',cancel_ids:shown.filter(t=>cancelIds.has(t.id)).map(t=>t.id),card};
}

export async function sendFeishuMessage(client,event,payload,key){
  const group=event.message.chat_type==='group',user=event.sender.sender_id.open_id;
  const request=(type,content,suffix)=>client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:event.message.chat_id,msg_type:type,content:JSON.stringify(content),...(key?{uuid:crypto.createHash('md5').update(key+suffix).digest('hex')}:{})}});
  if(payload?.type==='daily_card'){
    const card=structuredClone(payload.card);
    if(group)card.body.elements.unshift(markdown(`<at id="${user}"></at>`));
    const result=await request('interactive',card,'');
    if(result.code)throw Error('FEISHU_SEND_'+result.code);
    return;
  }
  const prefix=group?`<at user_id="${user}"></at>\n`:'';
  for(let i=0;i<payload.length;i+=1500){const result=await request('text',{text:prefix+payload.slice(i,i+1500)},':'+i);if(result.code)throw Error('FEISHU_SEND_'+result.code);}
}
