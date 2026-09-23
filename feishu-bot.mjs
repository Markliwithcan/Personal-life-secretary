import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import {DatabaseSync} from 'node:sqlite';
import {CONFIG_DIR,DATA_DIR,readSettings} from './settings.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {tick} from './scheduler.mjs';
import {scheduleReviews,runReviews} from './review.mjs';
import {dailyBackup} from './maintenance.mjs';
import {parsePlanBuffer} from './importer.mjs';
import {identity,textContent} from './feishu-core.mjs';
import {routeAssignment,rememberQuestion} from './group-assignment.mjs';
const readConfig=()=>JSON.parse(fs.readFileSync(path.join(CONFIG_DIR,'feishu.local.json'),'utf8').replace(/^\uFEFF/,''));
const cfg=readConfig();
if(!cfg.enabled||!cfg.app_id||!cfg.app_secret?.trim())throw new Error('FEISHU_CONFIG_REQUIRED');
const data=path.join(DATA_DIR,'feishu');fs.mkdirSync(data,{recursive:true});
const lock=path.join(data,'process.lock');
if(fs.existsSync(lock)){let alive=false;const oldPid=Number(fs.readFileSync(lock,'utf8'));try{if(oldPid!==process.pid){process.kill(oldPid,0);alive=true;}}catch{}if(alive)throw new Error('FEISHU_ALREADY_RUNNING');fs.unlinkSync(lock);}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
process.on('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
const state={status:'starting',pid:process.pid,received:0,replied:0,unbound:[]};
function status(update={}){Object.assign(state,update,{updated_at:new Date().toISOString()});fs.writeFileSync(path.join(data,'state.json'),JSON.stringify(state,null,2));}
const logger={trace(){},debug(){},info(){},warn(){},error(){status({last_error:'FEISHU_SDK_ERROR'});}};
const base={appId:cfg.app_id,appSecret:cfg.app_secret.trim(),domain:Lark.Domain.Feishu,logger};
const client=new Lark.Client(base),ws=new Lark.WSClient(base);
const queue=new DatabaseSync(path.join(data,'inbox.sqlite3'));
queue.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,body TEXT,state TEXT DEFAULT 'pending',response TEXT,attempts INTEGER DEFAULT 0,next_attempt INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,event TEXT);`);
const engines=new Map(),session=crypto.randomUUID();
function context(event){
 const current=readConfig(),who=identity(event,current);if(!who)return null;
 if(!engines.has(who.scope)){
  const folder=path.join(data,who.scope),store=new Store(path.join(folder,'assistant.sqlite3'));
  const settings=()=>({...readSettings(),soft_cancel:true,...(event.message.chat_type==='group'?{group_owner:who.member.name||who.member.open_id}:{})});
  const engine=new Engine(store,settings);scheduleReviews(store,engine.cfg(),session);
  engines.set(who.scope,{store,engine,folder});
 }
 return {...engines.get(who.scope),...who};
}
async function send(event,text,key){
 const prefix=event.message.chat_type==='group'?`<at user_id="${event.sender.sender_id.open_id}"></at>\n`:'';
 for(let i=0;i<text.length;i+=1500){
  const result=await client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:event.message.chat_id,msg_type:'text',content:JSON.stringify({text:prefix+text.slice(i,i+1500)}),...(key?{uuid:crypto.createHash('md5').update(key+':'+i).digest('hex')}:{})}});
  if(result.code)throw new Error('FEISHU_SEND_'+result.code);
 }
}
async function processMessage(event,ctx){
 const m=event.message,id=m.message_id;
 if(m.message_type==='text'){
  const text=textContent(m);
  const existing=ctx.store.receipt(id);if(existing!==undefined)return existing;
  if(['绑定助手','助手绑定'].includes(text))return ctx.engine.commit(id,text,`已绑定：${ctx.member.name}。本群待办按发送账号分别保存。可直接发送“添加 买牛奶”“待办”“测试提醒”，无需 @。`,Number(m.create_time)||Date.now());
  const now=Number(m.create_time)||Date.now();
  if(m.chat_type==='group'&&readConfig().cross_assign_groups?.includes(m.chat_id)){
   const route=await routeAssignment(text,ctx.store,ctx.engine.cfg(),readConfig().allowed_users,ctx.member,now);
   if(route.route==='clarify'){
    const question=route.question||'这件事具体要给谁添加？请说出名字和事情。';rememberQuestion(ctx.store,text,question,now);
    return ctx.engine.commit(id,text,question,now);
   }
   if(route.route==='assign'){
    const targetEvent={sender:{sender_type:'user',sender_id:{open_id:route.member.open_id}},message:{...m}};
    const target=context(targetEvent),key='assigned:'+id;
    let response=target.store.receipt(key);
    if(response===undefined)response=target.store.tx(()=>{
     const task={...route.task,notes:[route.task.notes,`由${ctx.member.name}在群中添加`].filter(Boolean).join('\n')};
     const result=target.engine.apply([{op:'create',task}],key,target.engine.cfg(),now);
     return target.engine.commit(key,`[${ctx.member.name}明确分配给你] ${text}`,result,now);
    });
    const routeEvent={sender:targetEvent.sender,message:{message_id:id,chat_id:m.chat_id,chat_type:'group'}};
    queue.prepare('INSERT INTO scopes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET event=excluded.event').run(target.scope,JSON.stringify(routeEvent));
    ctx.store.db.prepare('DELETE FROM assignment_question').run();
    return ctx.engine.commit(id,`[已转交给${route.member.name}，非本人待办] ${text}`,`已为${route.member.name}添加（由${ctx.member.name}提出）：\n${response}`,now);
   }
   ctx.store.db.prepare('DELETE FROM assignment_question').run();
  }
  return ctx.engine.process(id,text,Number(m.create_time)||Date.now());
 }
 if(m.message_type==='file'){
  const file=JSON.parse(m.content);
  if(!/\.(xlsx|csv)$/i.test(file.file_name||''))return '请发送 .xlsx 或 .csv 计划表。';
  const res=await client.im.messageResource.get({path:{message_id:id,file_key:file.file_key},params:{type:'file'}});
  const stream=res.getReadableStream(),chunks=[];let size=0;
  try{for await(const chunk of stream){size+=chunk.length;if(size>10*1024*1024)throw new Error('FILE_TOO_LARGE');chunks.push(chunk);}}finally{stream.destroy();}
  const {result,hash}=await parsePlanBuffer(Buffer.concat(chunks),ctx.engine.cfg().default_reminder_time);
  return ctx.engine.previewImport(id,result,hash,'飞书计划表');
 }
 return '当前飞书接入支持文字和 Excel/CSV；语音识别尚未接入，请先转成文字发送。';
}
let busy=false,stopping=false,lastWorkCompleted=Date.now();
async function work(){
 if(busy||stopping)return;busy=true;
 try{
  for(const row of queue.prepare("SELECT * FROM inbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid LIMIT 10").all(Date.now())){
   const event=JSON.parse(row.body),ctx=context(event);if(!ctx)continue;
   try{
    const response=row.response??await processMessage(event,ctx);
    queue.prepare('UPDATE inbox SET response=? WHERE id=?').run(response,row.id);
    await send(event,response,row.id);
    queue.prepare("UPDATE inbox SET state='done',body='{}' WHERE id=?").run(row.id);status({replied:state.replied+1});
   }catch(e){const attempts=row.attempts+1;queue.prepare('UPDATE inbox SET attempts=?,next_attempt=?,state=? WHERE id=?').run(attempts,Date.now()+60000*Math.min(10,attempts),attempts>=3?'failed':'pending',row.id);status({last_error:/^FEISHU_SEND_\d+$/.test(e.message)?e.message:'MESSAGE_PROCESS_FAILED'});}
  }
  for(const row of queue.prepare('SELECT * FROM scopes').all()){
   const event=JSON.parse(row.event),ctx=context(event);if(!ctx)continue;
   await tick(ctx.store,ctx.engine.cfg(),text=>send(event,text),Date.now(),(kind,now)=>ctx.engine.daily(kind,now));
   scheduleReviews(ctx.store,ctx.engine.cfg(),null);await runReviews(ctx.store,ctx.engine.cfg());
   dailyBackup(ctx.store,ctx.folder,ctx.engine.cfg().timezone);
  }
 }finally{busy=false;lastWorkCompleted=Date.now();}
}
const dispatcher=new Lark.EventDispatcher({}).register({'im.message.receive_v1':async event=>{
 if(stopping)throw new Error('SERVICE_STOPPING');
 const who=identity(event,readConfig());
 if(!who){
  if(event.sender?.sender_type==='user'){
   const entry={open_id:event.sender.sender_id?.open_id,chat_id:event.message?.chat_id,chat_type:event.message?.chat_type};
   if(!state.unbound.some(x=>x.open_id===entry.open_id&&x.chat_id===entry.chat_id)){state.unbound.push(entry);state.unbound=state.unbound.slice(-20);status();}
  }
  return;
 }
 const inserted=queue.prepare('INSERT OR IGNORE INTO inbox(id,body) VALUES (?,?)').run(event.message.message_id,JSON.stringify(event));
 const route={sender:event.sender,message:{chat_id:event.message.chat_id,chat_type:event.message.chat_type,message_id:event.message.message_id}};
 queue.prepare('INSERT INTO scopes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET event=excluded.event').run(who.scope,JSON.stringify(route));
 if(inserted.changes)status({received:state.received+1,last_received:{message_id:event.message.message_id,open_id:event.sender.sender_id.open_id,chat_type:event.message.chat_type,has_mentions:Boolean(event.message.mentions?.length)}});
 // Persist and acknowledge immediately; model work runs outside the event callback.
}});
status({status:'connecting'});
await ws.start({eventDispatcher:dispatcher});
status({status:'connection_started'});
const interval=setInterval(()=>work().catch(()=>status({last_error:'WORKER_ERROR'})),5000);
const heartbeat=setInterval(()=>{
 const connection=ws.getConnectionStatus().state;
 status({connection,status:stopping?'stopping':connection,last_work_completed:new Date(lastWorkCompleted).toISOString()});
},10000);
async function stop(){
 if(stopping)return;stopping=true;clearInterval(interval);clearInterval(heartbeat);status({status:'stopping'});ws.close({force:true});
 const timeout=setTimeout(()=>process.exit(1),110000);timeout.unref();
 while(busy)await new Promise(resolve=>setTimeout(resolve,100));
 for(const ctx of engines.values()){ctx.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');ctx.store.close();}
 queue.exec('PRAGMA wal_checkpoint(TRUNCATE)');queue.close();status({status:'stopped'});clearTimeout(timeout);process.exit(0);
}
process.on('SIGTERM',()=>stop().catch(()=>process.exit(1)));
process.on('SIGINT',()=>stop().catch(()=>process.exit(1)));
