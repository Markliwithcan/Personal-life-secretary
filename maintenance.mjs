import fs from 'node:fs';
import path from 'node:path';
import {DateTime} from 'luxon';
export function dailyBackup(store,root,zone,now=Date.now()){
  const dir=path.join(root,'data','backups');fs.mkdirSync(dir,{recursive:true});
  const today=DateTime.fromMillis(now,{zone}).toISODate();
  const target=path.join(dir,`assistant-${today}.sqlite3`);
  if(!fs.existsSync(target))store.db.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);
  // Retain 14 daily database snapshots. Never includes API configuration files.
  const files=fs.readdirSync(dir).filter(n=>/^assistant-\d{4}-\d{2}-\d{2}\.sqlite3$/.test(n)).sort();
  for(const name of files.slice(0,-14))fs.unlinkSync(path.join(dir,name));
}
