import test from 'node:test';
import assert from 'node:assert/strict';
import {identity,textContent} from './feishu-core.mjs';
const cfg={app_id:'app',allowed_users:[{open_id:'a'},{open_id:'b'}],allowed_groups:['g']};
const event=(id,chat='g',type='group')=>({sender:{sender_type:'user',sender_id:{open_id:id}},message:{message_id:'m',chat_id:chat,chat_type:type,message_type:'text',content:'{"text":"添加 开会"}'}});
test('Feishu ignores bots, unknown users and unauthorized groups',()=>{
 assert.equal(identity(event('c'),cfg),null);assert.equal(identity(event('a','other'),cfg),null);
 const e=event('a');e.sender.sender_type='app';assert.equal(identity(e,cfg),null);
});
test('Feishu non-mention group text is accepted; accounts and private scopes are distinct',()=>{
 assert.ok(identity(event('a'),cfg));
 assert.notEqual(identity(event('a'),cfg).scope,identity(event('b'),cfg).scope);
 assert.notEqual(identity(event('a'),cfg).scope,identity(event('a','p','p2p'),cfg).scope);
 assert.equal(textContent(event('a').message),'添加 开会');
});
