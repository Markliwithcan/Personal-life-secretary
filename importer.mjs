import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA_DIR,PYTHON_BIN} from './settings.mjs';
const execute=promisify(execFile);
export async function parsePlanBuffer(content,defaultReminderTime='09:00'){
  if(content.length>10*1024*1024)throw new Error('文件超过 10MB');
  const hash=crypto.createHash('sha256').update(content).digest('hex');
  const folder=path.join(DATA_DIR,'incoming');await fs.mkdir(folder,{recursive:true});
  const temp=path.join(folder,crypto.randomUUID()+'.bin');
  await fs.writeFile(temp,content);
  try{
    let result;
    try{result=await execute(PYTHON_BIN,['-X','utf8',path.join(ROOT,'parse_sheet.py'),temp,defaultReminderTime],{timeout:30000,maxBuffer:2000000,windowsHide:true});}
    catch(e){let safe='文件解析失败；请使用 .xlsx 或 UTF-8 CSV';try{safe=JSON.parse(e.stdout).error||safe;}catch{}throw new Error(safe);}
    return {result:JSON.parse(result.stdout),hash};
  }finally{await fs.unlink(temp).catch(()=>{});}
}
