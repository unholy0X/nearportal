import test from 'node:test';
import assert from 'node:assert/strict';
import {bountyMilestones} from '../bounty-detail-model.mjs';
test('merged PR with missing acceptance preserves pending checks and unpaid reward',()=>{
 const steps=bountyMilestones({task:{funded:true,policy:{developerId:2,developerLogin:'dev'},prNumber:9,evidence:{merged:true},verdict:{status:'pending',reasons:['Waiting for acceptance on the submitted commit.']},payment:{state:'NotRequested'}}});
 assert.deepEqual(steps.map(s=>s.done),[true,true,false,true,false]);assert.equal(steps[2].detail,'Verification pending');
});
test('payment progress never claims completion before Processed',()=>{
 for(const state of ['Authorized','Signing','Signed','Submitted','NeedsAttention'])assert.equal(bountyMilestones({task:{payment:{state}}})[4].done,false);
 assert.equal(bountyMilestones({task:{payment:{state:'Processed'}}})[4].done,true);
});
