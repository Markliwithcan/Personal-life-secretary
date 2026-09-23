import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {normalizeTask,nextOccurrence} from './time.mjs';
export class Store{
  constructor(filename){
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL,due TEXT,remind_at INTEGER,priority TEXT NOT NULL,recurrence TEXT,notes TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',revision INTEGER NOT NULL DEFAULT 1,source TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,task_id INTEGER,revision INTEGER,kind TEXT NOT NULL,payload TEXT,run_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,response TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS voices(id INTEGER PRIMARY KEY,message_id TEXT UNIQUE,original TEXT NOT NULL,corrected TEXT,created INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS message_tasks(message_id TEXT,task_id INTEGER,PRIMARY KEY(message_id,task_id));
      CREATE TABLE IF NOT EXISTS review_runs(id TEXT PRIMARY KEY,day TEXT,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS review_cache(fingerprint TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_candidates(id INTEGER PRIMARY KEY,fingerprint TEXT UNIQUE,task TEXT NOT NULL,evidence TEXT NOT NULL,source_ids TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,frame TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,task_id INTEGER,action TEXT,before_json TEXT,created INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_details(task_id INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocations(task_id INTEGER,date TEXT,minutes INTEGER,step TEXT,PRIMARY KEY(task_id,date));
      CREATE TABLE IF NOT EXISTS briefings(id TEXT PRIMARY KEY,body TEXT NOT NULL,snapshot TEXT NOT NULL,created INTEGER NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='awaiting_completion'))this.db.exec('ALTER TABLE tasks ADD COLUMN awaiting_completion INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='reminder_explicit')){
      this.db.exec("ALTER TABLE tasks ADD COLUMN reminder_explicit INTEGER NOT NULL DEFAULT 0; UPDATE tasks SET reminder_explicit=1 WHERE remind_at IS NOT NULL AND (due IS NULL OR length(due)>10)");
    }
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.inTransaction=false;}}
  enrich(t){return t?{...t,...JSON.parse(this.db.prepare('SELECT body FROM task_details WHERE task_id=?').get(t.id)?.body||'{}')}:t;}
  details(id,input){const keys=['effort_minutes','remaining_minutes','progress','next_action','splittable','fixed'];const old=JSON.parse(this.db.prepare('SELECT body FROM task_details WHERE task_id=?').get(id)?.body||'{}');for(const k of keys)if(Object.hasOwn(input,k))old[k]=input[k];this.db.prepare('INSERT INTO task_details VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(old));}
  all(){return this.db.prepare('SELECT * FROM tasks ORDER BY id').all().map(t=>this.enrich(t));}
  open(){return this.db.prepare("SELECT * FROM tasks WHERE state IN ('open','pending_cancel') ORDER BY COALESCE(remind_at,9223372036854775807),id").all().map(t=>this.enrich(t));}
  ensureCancellation(){
    const columns=this.db.prepare('PRAGMA table_info(tasks)').all();
    for(const name of ['cancel_requested_at','cancel_notified_at'])if(!columns.some(c=>c.name===name))this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} INTEGER`);
  }
  pendingCancellations(){this.ensureCancellation();return this.db.prepare("SELECT * FROM tasks WHERE state='pending_cancel' ORDER BY id").all();}
  restore(id,cfg,now=Date.now()){
    this.ensureCancellation();const old=this.get(id);if(!old||old.state!=='pending_cancel')throw new Error('该事项没有处于拟取消状态');
    this.logChange(old,'restore',now);this.db.prepare("UPDATE tasks SET state='open',cancel_requested_at=NULL,cancel_notified_at=NULL,revision=revision+1,updated=? WHERE id=?").run(now,id);
    const task=this.get(id);this.schedule(task,now);return task;
  }
  get(id){return this.enrich(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));}
  config(cfg){for(const row of this.db.prepare('SELECT * FROM preferences').all())cfg={...cfg,[row.key]:row.value};return cfg;}
  logChange(task,action,now){this.db.prepare('INSERT INTO audit(task_id,action,before_json,created) VALUES (?,?,?,?)').run(task?.id||null,action,task?JSON.stringify(task):null,now);}
  schedule(task,now){
    this.db.prepare("UPDATE jobs SET state='cancelled' WHERE task_id=? AND state='pending'").run(task.id);
    if(task.state==='open'&&task.remind_at)this.db.prepare('INSERT OR IGNORE INTO jobs(id,task_id,revision,kind,run_at) VALUES (?,?,?,?,?)').run(`task:${task.id}:${task.revision}`,task.id,task.revision,'task',Math.max(task.remind_at,now));
  }
  create(input,source,cfg,now=Date.now()){
    const t=normalizeTask(input,cfg,now);
    const id=Number(this.db.prepare('INSERT INTO tasks(title,due,remind_at,priority,recurrence,notes,source,created,updated) VALUES (?,?,?,?,?,?,?,?,?)').run(t.title,t.due,t.remind_at,t.priority,t.recurrence,t.notes,source,now,now).lastInsertRowid);
    this.db.prepare('UPDATE tasks SET reminder_explicit=? WHERE id=?').run(input.remind_at||input.due?.length>10?1:0,id);
    this.details(id,input);
    const task=this.get(id);this.schedule(task,now);this.logChange(task,'create',now);return task;
  }
  update(id,patch,cfg,now=Date.now()){
    let old=this.get(id);if(old?.state==='pending_cancel'){this.restore(id,cfg,now);old=this.get(id);}if(!old||old.state!=='open')throw new Error(`待办 #${id} 不存在或已结束`);
    const base={...old,remind_at:old.remind_at?new Date(old.remind_at).toISOString():null};
    if(Object.hasOwn(patch,'due')&&!Object.hasOwn(patch,'remind_at'))base.remind_at=null;
    const t=normalizeTask({...base,...patch},cfg,now);
    const explicit=('remind_at' in patch||'due' in patch)?(patch.remind_at||patch.due?.length>10?1:0):old.reminder_explicit;
    this.logChange(old,'update',now);
    this.db.prepare('UPDATE tasks SET title=?,due=?,remind_at=?,priority=?,recurrence=?,notes=?,awaiting_completion=?,revision=revision+1,updated=? WHERE id=?').run(t.title,t.due,t.remind_at,t.priority,t.recurrence,t.notes,('due' in patch||'remind_at' in patch||'recurrence' in patch)?0:old.awaiting_completion,now,id);
    this.db.prepare('UPDATE tasks SET reminder_explicit=? WHERE id=?').run(explicit,id);
    this.details(id,patch);
    const task=this.get(id);if(['due','remind_at','recurrence'].some(k=>Object.hasOwn(patch,k)))this.schedule(task,now);
    else this.db.prepare("UPDATE jobs SET revision=? WHERE task_id=? AND kind='task' AND state='pending'").run(task.revision,id);
    return task;
  }
  finish(id,cancel,cfg,now=Date.now()){
    if(cancel&&cfg.soft_cancel){
      this.ensureCancellation();const old=this.get(id);
      if(old?.state==='pending_cancel')return old;
      if(!old||old.state!=='open')throw new Error(`待办 #${id} 不存在或已结束`);
      this.logChange(old,'propose_cancel',now);
      this.db.prepare("UPDATE tasks SET state='pending_cancel',cancel_requested_at=?,cancel_notified_at=NULL,revision=revision+1,updated=? WHERE id=?").run(now,now,id);
      const task=this.get(id);this.schedule(task,now);return task;
    }
    const task=this.get(id);if(!task||task.state!=='open')throw new Error(`待办 #${id} 不存在或已结束`);
    this.logChange(task,cancel?'cancel':'complete',now);
    if(task.recurrence&&!cancel){
      this.details(id,{progress:'unknown',remaining_minutes:null});
      if(task.awaiting_completion){
        this.db.prepare('UPDATE tasks SET awaiting_completion=0,updated=? WHERE id=?').run(now,id);
        return this.get(id);
      }
      const next=nextOccurrence(task,now,cfg.timezone);
      this.db.prepare('UPDATE tasks SET due=?,remind_at=?,revision=revision+1,updated=? WHERE id=?').run(next.due,next.remind_at,now,id);
    }else this.db.prepare('UPDATE tasks SET state=?,revision=revision+1,updated=? WHERE id=?').run(cancel?'cancelled':'done',now,id);
    const updated=this.get(id);this.schedule(updated,now);return updated;
  }
  receipt(id){return this.db.prepare('SELECT response FROM receipts WHERE id=?').get(id)?.response;}
  rememberReceipt(id,response,now){this.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(id,response,now);}
  history(){return this.db.prepare('SELECT role,content FROM (SELECT id,role,content FROM history ORDER BY id DESC LIMIT 16) ORDER BY id').all();}
  addHistory(role,content,now){this.db.prepare('INSERT INTO history(role,content,created) VALUES (?,?,?)').run(role,content.slice(0,6000),now);}
  cleanup(now,days){this.db.prepare('DELETE FROM history WHERE created<?').run(now-days*86400000);this.db.prepare('DELETE FROM pending WHERE created<?').run(now-86400000);}
  close(){this.db.close();}
}
