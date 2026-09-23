import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './settings.mjs';
export function healthy(state,now=Date.now()){
 return state?.connection==='connected'&&now-Date.parse(state.updated_at)<60000&&now-Date.parse(state.last_work_completed)<900000;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/healthcheck.mjs')){
 try{const s=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'feishu','state.json'),'utf8'));process.exitCode=healthy(s)?0:1;}catch{process.exitCode=1;}
}
