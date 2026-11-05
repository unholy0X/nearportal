import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePullRequest} from '../bounty-detail-model.mjs';
test('PR input accepts the repository link, PR tabs, or a number',()=>{for(const input of ['11','#11',' https://github.com/hellonearportal-dotcom/test/pull/11 ','https://github.com/HelloNearPortal-Dotcom/TEST/pull/11/files?x=1#diff-a'])assert.equal(parsePullRequest(input,'hellonearportal-dotcom/test'),11);});
test('PR input rejects other repositories, invalid numbers and deceptive links',()=>{for(const input of ['','0','-1','1.5','9007199254740992','https://github.com/other/repo/pull/11','https://github.com.evil.test/hellonearportal-dotcom/test/pull/11','http://github.com/hellonearportal-dotcom/test/pull/11','https://user@github.com/hellonearportal-dotcom/test/pull/11','https://github.com/hellonearportal-dotcom/test/issues/11'])assert.throws(()=>parsePullRequest(input,'hellonearportal-dotcom/test'));});
