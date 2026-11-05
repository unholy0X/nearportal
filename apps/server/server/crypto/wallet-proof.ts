import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import type { PortalStore } from '../portal/store.ts';
import { address, CHAIN_ID } from './evm.ts';
const key=(nonce:string)=>'crypto-proof:'+createHash('sha256').update(nonce).digest('hex');
export function createWalletProof(store:PortalStore,userId:number,bountyId:string,policyHash:string,wallet:unknown,origin:string) {
 const destination=address(wallet),nonce=randomBytes(24).toString('hex'),expires=Date.now()+10*60000;
 const message=`NearPortal USDC payout authorization\nOrigin: ${origin}\nGitHub user ID: ${userId}\nBounty: ${bountyId}\nFunding policy: ${policyHash}\nNetwork: Base Sepolia (${CHAIN_ID})\nPayout wallet: ${destination}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nI accept this bounty's funded criteria and automatic payment conditions, with this payout destination. This signature does not transfer funds.`;
 store.meta(key(nonce),JSON.stringify({userId,bountyId,policyHash,destination,expires,message}));
 return {nonce,message,address:destination,expiresAt:new Date(expires).toISOString()};
}
export async function verifyWalletProof(store:PortalStore,userId:number,bountyId:string,policyHash:string,body:Record<string,unknown>) {
 const nonce=String(body.nonce??'');if(!/^[a-f0-9]{48}$/.test(nonce))throw new Error('Request a fresh wallet authorization');
 const saved=store.meta(key(nonce));if(!saved)throw new Error('Wallet authorization expired or already used');
 const proof=JSON.parse(saved);
 if(proof.userId!==userId||proof.bountyId!==bountyId||proof.policyHash!==policyHash||proof.expires<Date.now()||proof.destination!==address(body.walletAddress))throw new Error('Wallet authorization does not match this claim');
 if(typeof body.signature!=='string'||!/^0x[0-9a-f]{130}$/i.test(body.signature)||!await verifyMessage({address:proof.destination,message:proof.message,signature:body.signature as Hex}))throw new Error('Wallet signature could not be verified (EOA wallets supported in this test)');
 return {address:proof.destination as string,consume:()=>{if(store.meta(key(nonce))!==saved)throw new Error('Wallet authorization was already used');store.meta(key(nonce),'');}};
}
