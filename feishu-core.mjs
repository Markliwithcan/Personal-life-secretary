import crypto from 'node:crypto';
export function identity(event,cfg){
 const m=event?.message,u=event?.sender;
 if(!m?.message_id||u?.sender_type!=='user'||!u.sender_id?.open_id)return null;
 const member=cfg.allowed_users.find(x=>x.open_id===u.sender_id.open_id);
 if(!member||!['p2p','group'].includes(m.chat_type))return null;
 if(m.chat_type==='group'&&!cfg.allowed_groups.includes(m.chat_id))return null;
 return {member,scope:crypto.createHash('sha256').update(JSON.stringify([cfg.app_id,m.chat_type==='group'?m.chat_id:'private',member.open_id])).digest('hex')};
}
export function textContent(message){
 const content=JSON.parse(message.content);
 if(message.message_type!=='text')return null;
 let text=content.text||'';
 for(const mention of message.mentions||[])text=text.replaceAll(mention.key,mention.name==='提醒助手'?'':mention.name||'');
 return text.trim();
}
