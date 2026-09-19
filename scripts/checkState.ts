import { Address, beginCell, TupleReader } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool } from '../wrappers/ChatPool';
import { TestJettonWallet } from '../wrappers/TestJetton';
import { reqEnv } from './env';

// Read-only: prints pool/master/wallet state for E2E verification.
// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, [OWNER], [NONCES=1,2]
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const owner = process.env.OWNER ? Address.parse(process.env.OWNER) : provider.sender().address;
    if (!owner) throw new Error('owner address is not defined');

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);
    const pool = provider.open(ChatPool.fromAddress(poolAddr));

    const poolAdmin = await pool.getPoolAdmin();
    const tier = await pool.getCurrentTier();
    const poolBal = await pool.getBalanceOf(jettonMaster);
    const poolWallet = await pool.getJettonWallet(jettonMaster);

    const poolTon = await tonBalance(provider, poolAddr);
    const masterTon = await tonBalance(provider, masterAddr);

    const ownerWalletAddr = await jettonWalletOf(provider, jettonMaster, owner);
    const ownerWallet = provider.open(TestJettonWallet.fromAddress(ownerWalletAddr));
    const ownerWalletTon = await tonBalance(provider, ownerWalletAddr);
    let ownerJettons: string;
    try {
        ownerJettons = (await ownerWallet.getWalletBalance()).toString();
    } catch {
        ownerJettons = 'n/a (wallet not deployed)';
    }

    console.log('pool         :', poolAddr.toString());
    console.log('  poolAdmin  :', poolAdmin ? poolAdmin.toString() : 'null');
    console.log('  tier       :', tier.toString());
    console.log('  balanceOf  :', poolBal.toString());
    console.log('  jettonWal  :', poolWallet ? poolWallet.toString() : 'null');
    console.log('  TON        :', poolTon.toString());
    console.log('master TON   :', masterTon.toString());
    console.log('owner wallet :', ownerWalletAddr.toString());
    console.log('  jettons    :', ownerJettons);
    console.log('  TON        :', ownerWalletTon.toString());

    for (const n of (process.env.NONCES ?? '').split(',').filter(Boolean)) {
        console.log(`nonce ${n} used :`, await pool.getIsNonceUsed(BigInt(n)));
    }
}

async function tonBalance(provider: NetworkProvider, addr: Address): Promise<bigint> {
    const api = provider.api();
    if ('getAccountLite' in api) {
        const seqno = (await api.getLastBlock()).last.seqno;
        const acc = await api.getAccountLite(seqno, addr);
        return BigInt(acc.account.balance.coins);
    }
    return api.getBalance(addr);
}

async function jettonWalletOf(
    provider: NetworkProvider,
    jettonMaster: Address,
    owner: Address,
): Promise<Address> {
    const res = await provider.provider(jettonMaster).get('get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
    ]);
    return (res.stack as TupleReader).readAddress();
}
