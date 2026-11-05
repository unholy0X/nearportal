import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestedBranch} from '../bounty-detail-model.mjs';
test('branch names include the assigned GitHub user, title and unique assignment',()=>{
 const b={title:'Test deadline',code:'NP-15CEBD8443',market:{assignment:{login:'demo-developer',marker:'NP-15CEBD8443-A1'}}};
 assert.equal(suggestedBranch(b),'dev/demo-developer/test-deadline-np-15cebd8443-a1');
 assert.notEqual(suggestedBranch(b),suggestedBranch({...b,market:{assignment:{...b.market.assignment,marker:'NP-15CEBD8443-A2'}}}));
});
test('titles become bounded Git-safe slugs and unclaimed tasks have no branch',()=>{
 const b={title:'Réparer ../ weird~^:?*[branch] @{test} '+ 'long '.repeat(50),code:'NP-ABC',task:{policy:{developerLogin:'Some-Dev'}}};
 const name=suggestedBranch(b);assert.match(name,/^dev\/some-dev\/[a-z0-9-]+$/);assert.ok(name.length<120);assert.equal(suggestedBranch({...b,task:null}),null);
});
