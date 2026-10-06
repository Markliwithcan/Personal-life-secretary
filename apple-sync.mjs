import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {CONFIG_DIR,DATA_DIR,readSettings} from './settings.mjs';

export const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
export function snapshot(rows,namespace,timezone,now=Date.now()){
  return {version:1,timezone,generated_at:new Date(now).toISOString(),items:rows.map(t=>{
    const marker=`[secretary:${namespace}:${t.scope}:${t.id}]`;
    // Pending cancellation suppresses alerts but is not treated as completed.
    const active=['open','pending_cancel'].includes(t.state);
    const alarm=active&&t.state==='open'&&t.reminder_explicit&&t.remind_at>now?new Date(t.remind_at).toISOString():'';
    const title=t.title+(t.state==='pending_cancel'?'（拟取消）':'');
    const content={title,alarm,state:t.state};
    const fingerprint=tokenHash(JSON.stringify(content));
    return {marker,fingerprint,title,alarm,active,notes:`${marker}\nversion:${fingerprint}\n完成情况请在飞书确认。`};
  })};
}
export function createSyncServer({clients,namespace,timezone,readRows}){
  if(!/^[a-f0-9]{32}$/.test(namespace)||!Array.isArray(clients)||clients.some(c=>!/^[a-f0-9]{64}$/.test(c.token_hash)||!c.scopes?.length||c.scopes.some(s=>!/^[a-f0-9]{64}$/.test(s))))throw Error('INVALID_SYNC_CONFIG');
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.url!=='/v1/apple-reminders'||req.method!=='GET'){res.writeHead(404);res.end('{"error":"not_found"}');return;}
    const raw=req.headers.authorization||'';
    const hash=tokenHash(raw.startsWith('Bearer ')?raw.slice(7):'');
    const client=raw.startsWith('Bearer ')?clients.find(c=>crypto.timingSafeEqual(Buffer.from(c.token_hash,'hex'),Buffer.from(hash,'hex'))):null;
    if(!client){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
    try{
      const rows=await readRows(client.scopes);
      res.end(JSON.stringify(snapshot(rows,namespace,timezone)));
    }catch{res.writeHead(503);res.end('{"error":"sync_unavailable"}');}
  });
}
export function readScopeRows(scopes,dataDir=DATA_DIR){
  return scopes.flatMap(scope=>{
    const filename=path.join(dataDir,'feishu',scope,'assistant.sqlite3');
    // A missing scope fails the whole snapshot; it must not look like an empty account.
    if(!/^[a-f0-9]{64}$/.test(scope)||!fs.existsSync(filename))throw Error('SCOPE_NOT_FOUND');
    const db=new DatabaseSync(filename,{readOnly:true});
    try{return db.prepare('SELECT id,title,state,remind_at,reminder_explicit FROM tasks ORDER BY id').all().map(t=>({...t,scope}));}
    finally{db.close();}
  });
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const cfg=JSON.parse(fs.readFileSync(path.join(CONFIG_DIR,'apple-sync.local.json'),'utf8').replace(/^\uFEFF/,''));
  if(!cfg.enabled)throw Error('APPLE_SYNC_DISABLED');
  // Loopback only: public access must terminate TLS at a reverse proxy.
  const server=createSyncServer({...cfg,timezone:readSettings().timezone,readRows:scopes=>readScopeRows(scopes)});
  server.listen(cfg.port||8788,'127.0.0.1',()=>console.log('Apple reminder sync listening on loopback'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close());
}
