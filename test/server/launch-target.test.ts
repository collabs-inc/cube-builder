import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveBuilderTarget} from '../../src/server/launch-target.js';
test('automatic Claude launches mint a stable session id and resume keeps it',()=>{
 const first=resolveBuilderTarget({target:'auto',cwd:'/tmp'},command=>command==='claude');
 assert.equal(first.target,'claude');assert.match(first.agentSessionId!,/^[a-f0-9-]{36}$/);
 assert.deepEqual(first.args.slice(-2),['--session-id',first.agentSessionId]);assert.equal(first.resumed,false);
 const resumed=resolveBuilderTarget({target:'claude',cwd:'/tmp',agentSessionId:first.agentSessionId,resume:true},()=>true);
 assert.deepEqual(resumed.args.slice(-2),['--resume',first.agentSessionId]);assert.equal(resumed.resumed,true);
 const shell=resolveBuilderTarget({target:'shell',cwd:'/tmp'},()=>false);
 assert.equal(shell.agentSessionId,undefined);assert.equal(shell.target,'shell');
});
