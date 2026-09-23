import test from 'node:test';
import assert from 'node:assert/strict';
import {requestJSON,requestPlan,Plan,anchorClockReply} from './model.mjs';
const cfg={max_output_tokens:2000,model:{base_url:'https://model.example.invalid',api_key:'synthetic-test-key',name:'test-model',json_mode:true}};
function fake(t,outputs){const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));const value=outputs.shift();return new Response(JSON.stringify(value),{status:200});};t.after(()=>globalThis.fetch=original);return calls;}
const response=(content,finish_reason='stop')=>({choices:[{message:{content},finish_reason}]});
test('whitespace response retries once outside JSON mode and preserves clarification',async t=>{
 const expected={reply:'',clarification:'明天的作业是18点还是19点提醒？',actions:[]};
 const calls=fake(t,[response('     '),response(JSON.stringify(expected))]);
 assert.deepEqual(Plan.parse(await requestJSON([{role:'user',content:'作业晚上六七点提醒一下'}],cfg)),expected);
 assert.equal(calls.length,2);assert.ok(calls[0].response_format);assert.equal(calls[1].response_format,undefined);
});
test('repeated empty responses stop after two calls',async t=>{
 const calls=fake(t,[response(''),response('  ')]);await assert.rejects(()=>requestJSON([],cfg),/MODEL_EMPTY_RESPONSE/);assert.equal(calls.length,2);
});
test('truncated output is never accepted even if it contains syntactically valid JSON',async t=>{
 const calls=fake(t,[response('{"actions":[]}','length'),response('{"actions":[]}')]);assert.deepEqual(await requestJSON([],cfg),{actions:[]});assert.equal(calls[1].max_tokens,4000);
});
test('valid JSON does not retry; unsupported actions remain rejected',async t=>{
 const calls=fake(t,[response('{"reply":"","clarification":null,"actions":[{"op":"invented"}]}')]);const value=await requestJSON([],cfg);assert.throws(()=>Plan.parse(value));assert.equal(calls.length,1);
});
test('clock-only clarification keeps original reminder date while explicit date changes remain possible',()=>{
 const store={get:()=>({remind_at:Date.parse('2026-09-24T09:00:00+09:00')})};
 const make=()=>({reply:'',clarification:null,actions:[{op:'update',id:3,patch:{remind_at:'2026-09-23T18:30:00+09:00'}}]});
 assert.equal(anchorClockReply(make(),'六点半吧',store,{timezone:'Asia/Seoul'}).actions[0].patch.remind_at,'2026-09-24T18:30:00.000+09:00');
 assert.equal(anchorClockReply(make(),'今天18:30提醒我',store,{timezone:'Asia/Seoul'}).actions[0].patch.remind_at,'2026-09-23T18:30:00+09:00');
});
test('schema mismatch can be repaired once but never bypasses operation validation',async()=>{
 let calls=0;const result=await requestPlan([],cfg,async()=>++calls===1?{reply:null,actions:[]}:{reply:'',clarification:'请确认时间',actions:[]});
 assert.equal(calls,2);assert.equal(result.clarification,'请确认时间');
 calls=0;await assert.rejects(()=>requestPlan([],cfg,async()=>{calls++;return {reply:'',clarification:null,actions:[{op:'invented'}]};}),/MODEL_SCHEMA_INVALID/);assert.equal(calls,2);
});
