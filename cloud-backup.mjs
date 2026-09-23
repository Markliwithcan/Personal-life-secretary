import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function under(root,relative){const p=path.resolve(root,relative);if(p===root||!p.startsWith(root+path.sep))throw Error('PATH_OUTSIDE_ROOT');return p;}
function databases(root,relative=''){
 const result=[];
 for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  if(item.isSymbolicLink())throw Error('SYMLINK_NOT_SUPPORTED');
  if(item.isDirectory()&&item.name!=='backups')result.push(...databases(root,path.join(relative,item.name)));
  else if(item.isFile()&&item.name.endsWith('.sqlite3'))result.push(path.join(relative,item.name));
 }
 return result;
}
export async function snapshot(source,destination){
 source=path.resolve(source);destination=path.resolve(destination);
 if(destination===source||destination.startsWith(source+path.sep))throw Error('BACKUP_MUST_BE_OUTSIDE_SOURCE');
 const lock=path.join(source,'process.lock');
 if(fs.existsSync(lock)){let live=false;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);live=true;}catch{}if(live)throw Error('STOP_FEISHU_BEFORE_BACKUP');}
 fs.mkdirSync(destination,{recursive:true});if(fs.readdirSync(destination).length)throw Error('DESTINATION_MUST_BE_EMPTY');
 const manifest={version:1,created:new Date().toISOString(),files:[]};
 for(const relative of databases(source)){
  const target=under(destination,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  const db=new DatabaseSync(under(source,relative),{readOnly:true});
  try{await backup(db,target);}finally{db.close();}
  const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('DATABASE_INTEGRITY_FAILED');}finally{check.close();}
  manifest.files.push({path:relative.split(path.sep).join('/'),sha256:hash(target)});
 }
 if(!manifest.files.length)throw Error('NO_DATABASES_FOUND');
 fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2));
 return manifest.files.length;
}
export function restore(source,destination){
 source=path.resolve(source);destination=path.resolve(destination);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('INVALID_MANIFEST');
 for(const file of manifest.files){under(destination,file.path);if(hash(under(source,file.path))!==file.sha256)throw Error('BACKUP_CHECKSUM_FAILED');}
 if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw Error('DESTINATION_MUST_BE_EMPTY');
 fs.mkdirSync(destination,{recursive:true});
 for(const file of manifest.files){const target=under(destination,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(under(source,file.path),target);}
 return manifest.files.length;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,source,destination]=process.argv.slice(2);if(!source||!destination||!['backup','restore'].includes(mode))throw Error('Usage: node cloud-backup.mjs backup|restore SOURCE EMPTY_DESTINATION');console.log(JSON.stringify({databases:mode==='backup'?await snapshot(source,destination):restore(source,destination)}));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
