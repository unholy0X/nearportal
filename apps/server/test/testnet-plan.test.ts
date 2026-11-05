import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('fresh deployment defaults to a stable offline plan; an unreviewed apply creates no keys',t=>{
 const dir=mkdtempSync(join(tmpdir(),'np-plan-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const wasm=join(dir,'fixture.wasm');writeFileSync(wasm,Buffer.from([0,97,115,109,1,0,0,0]));
 const deployment=join(dir,'deployment');
 const server=resolve(import.meta.dirname,'..');
 const args=['--import',join(server,'test/loopback-only.mjs'),'--import','tsx','scripts/testnet-deploy.ts',`--wasm=${wasm}`,`--directory=${deployment}`,'--root=np-fixture.testnet'];
 const run=(more:string[]=[])=>spawnSync(process.execPath,[...args,...more],{cwd:server,encoding:'utf8',env:{PATH:process.env.PATH,HOME:dir,ENV_FILE:'/dev/null',NEAR_NETWORK:'testnet',NEAR_RPC:'http://blocked.invalid',GITHUB_USE_CLI:'0'}});
 const first=run();assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/No keys generated/);assert.equal(existsSync(join(deployment,'keys')),false);
 const plan=JSON.parse(readFileSync(join(deployment,'deployment.json'),'utf8'));
 assert.deepEqual(plan.plan.verifierMethods,['assign_developer','record_submission','expire_assignment','withdraw_assignment','settle_bounty','open_dispute','retry_address_check','retry_payout_signature']);
 assert(!plan.plan.verifierMethods.includes('resolve_dispute'));
 assert.equal(run().status,0);
 assert.equal(JSON.parse(readFileSync(join(deployment,'deployment.json'),'utf8')).digest,plan.digest);
 assert.notEqual(run(['--apply','--confirm=wrong']).status,0);assert.equal(existsSync(join(deployment,'keys')),false);
 writeFileSync(wasm,Buffer.from([0,97,115,109,1,0,0,0,0]));
 assert.notEqual(run().status,0,'a different artifact cannot reuse an approved plan');
});
