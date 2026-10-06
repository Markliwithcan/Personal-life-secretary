import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CONFIG_DIR,DATA_DIR} from './settings.mjs';
import {tokenHash,readScopeRows} from './apple-sync.mjs';

// Explicit scope selection prevents accidentally exporting the whole household.
const scopes=[...new Set(process.argv.slice(2))];
if(!scopes.length||scopes.some(s=>!/^[a-f0-9]{64}$/.test(s)))throw Error('Usage: node apple-pair.mjs <scope> [another-scope-of-the-same-user]');
readScopeRows(scopes,DATA_DIR);
const filename=path.join(CONFIG_DIR,'apple-sync.local.json');
const cfg=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{enabled:false,port:8788,namespace:crypto.randomBytes(16).toString('hex'),clients:[]};
const token=crypto.randomBytes(32).toString('base64url'),id=crypto.randomBytes(8).toString('hex');
cfg.clients.push({id,token_hash:tokenHash(token),scopes});
fs.writeFileSync(filename,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
const setup=path.join(CONFIG_DIR,`apple-device-${id}.local.json`);
fs.writeFileSync(setup,JSON.stringify({url:'https://YOUR-SYNC-DOMAIN/v1/apple-reminders',authorization:`Bearer ${token}`,list:'生活秘书'},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log('Device configuration saved to '+setup+'; sync stays disabled until configured.');
