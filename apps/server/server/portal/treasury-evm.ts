import { createPublicClient, createWalletClient, http, erc20Abi, encodeFunctionData, keccak256, decodeEventLog, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { depositReference, InvalidTreasuryReceipt, type TreasuryGateway, type TreasuryTarget } from './treasury-core.ts';
// Verified against https://api.monerium.dev/tokens. Never accepts a client-supplied token or chain.
export const DEMO_TOKEN = '0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85' as Address; // gitleaks:allow (public token contract address)
const SCALE = 10n ** 16n;
export function verifyTreasuryLogs(logs: {
    address: string;
    data: Hex;
    topics: readonly Hex[];
    logIndex: number | null;
}[], source: string, target: TreasuryTarget) {
    const matches = [];
    for (const log of logs) {
        if (log.address.toLowerCase() !== DEMO_TOKEN.toLowerCase())
            continue;
        try {
            const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics as [
                    Hex,
                    ...Hex[]
                ] });
            if (event.args.from.toLowerCase() === source.toLowerCase() && event.args.to.toLowerCase() === target.address.toLowerCase() && event.args.value === BigInt(target.amountCents) * SCALE)
                matches.push(log);
        }
        catch { }
    }
    if (matches.length !== 1 || matches[0]!.logIndex === null)
        throw new InvalidTreasuryReceipt('The transfer receipt does not contain one exact EURe deposit to this escrow');
    return matches[0]!.logIndex!;
}
export function evmGateway(key: Hex, rpc = 'https://sepolia.base.org'): TreasuryGateway & {
    address: Address;
} {
    const account = privateKeyToAccount(key), publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc, { timeout: 10000, retryCount: 1 }) }), wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc, { timeout: 10000, retryCount: 0 }) });
    async function network() { if (await publicClient.getChainId() !== 84532)
        throw new Error('Demo wallet RPC must be Base Sepolia'); const decimals = await publicClient.readContract({ address: DEMO_TOKEN, abi: erc20Abi, functionName: 'decimals' }); if (decimals !== 18)
        throw new Error('Unexpected sandbox EURe contract'); }
    return { address: account.address,
        async balance() { await network(); const [tokens, gas] = await Promise.all([publicClient.readContract({ address: DEMO_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), publicClient.getBalance({ address: account.address })]); return { balanceCents: Number(tokens / SCALE), gasWei: String(gas) }; },
        async prepare(address, cents) {
            await network();
            const destination = address as Address;
            const balance = await publicClient.readContract({ address: DEMO_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [destination] });
            if (balance !== 0n)
                throw new Error('Escrow already has EURe; reconcile existing deposits before wallet funding');
            const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
            const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, BigInt(cents) * SCALE] });
            await publicClient.simulateContract({ account, address: DEMO_TOKEN, abi: erc20Abi, functionName: 'transfer', args: [destination, BigInt(cents) * SCALE] });
            const request = await wallet.prepareTransactionRequest({ type: 'eip1559', account, chain: baseSepolia, to: DEMO_TOKEN, data, value: 0n, nonce });
            const raw = await account.signTransaction(request);
            return { raw, hash: keccak256(raw) };
        },
        async broadcast(raw) { await network(); await publicClient.sendRawTransaction({ serializedTransaction: raw as Hex }); },
        async receipt(hash, target) {
            await network();
            let receipt;
            try {
                receipt = await publicClient.getTransactionReceipt({ hash: hash as Hex });
            }
            catch (error) {
                if ((error as Error).name === 'TransactionReceiptNotFoundError')
                    return null;
                throw error;
            }
            if (receipt.status !== 'success')
                throw new InvalidTreasuryReceipt('Demo wallet transaction reverted. No escrow deposit was credited');
            if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
                throw new InvalidTreasuryReceipt('Unexpected funding transaction hash');
            if (receipt.from.toLowerCase() !== account.address.toLowerCase() || receipt.to?.toLowerCase() !== DEMO_TOKEN.toLowerCase())
                throw new InvalidTreasuryReceipt('Unexpected funding transaction sender or token');
            const latest = await publicClient.getBlockNumber();
            if (latest - receipt.blockNumber + 1n < 3n)
                return null;
            const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
            if (canonical.hash !== receipt.blockHash)
                return null;
            const index = verifyTreasuryLogs(receipt.logs, account.address, target);
            return { reference: depositReference(hash, index) };
        }
    };
}
