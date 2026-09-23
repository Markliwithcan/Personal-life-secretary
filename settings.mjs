import fs from 'node:fs';
import path from 'node:path';
import {DateTime} from 'luxon';
import {fileURLToPath} from 'node:url';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_DIR=path.resolve(process.env.ASSISTANT_CONFIG_DIR||ROOT);
export const DATA_DIR=path.resolve(process.env.ASSISTANT_DATA_DIR||path.join(ROOT,'data'));
export const PYTHON_BIN=process.env.ASSISTANT_PYTHON||(process.platform==='win32'?path.join(ROOT,'.venv','Scripts','python.exe'):'python3');
export function readSettings(){
  const cfg=JSON.parse(fs.readFileSync(path.join(CONFIG_DIR,'assistant.local.json'),'utf8').replace(/^\uFEFF/,''));
  cfg.morning_digest_time??='09:30';
  if(!DateTime.now().setZone(cfg.timezone).isValid)throw new Error('配置中的 timezone 无效');
  for(const key of ['evening_digest_time','default_reminder_time','morning_digest_time'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg[key]))throw new Error(`${key} 应为 HH:mm`);
  for(const key of ['start','end'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.quiet_hours?.[key]))throw new Error('quiet_hours 应为 HH:mm');
  return {...cfg,store_chat_days:Math.max(1,Math.min(365,Number(cfg.store_chat_days)||30)),max_output_tokens:Math.max(500,Math.min(8000,Number(cfg.max_output_tokens)||2000))};
}
export function modelReady(cfg){return Boolean(cfg.model?.base_url?.trim()&&cfg.model?.api_key?.trim()&&cfg.model?.name?.trim());}
