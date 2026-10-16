import { Address, beginCell, toNano, TupleReader } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool, storeJettonTransfer } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { depositVoucherCell, TAG } from '../wrappers/Vouchers';
import { contractVersion, voucherSignerFor } from './network';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, AMOUNT, BACKEND_SECRET
//
// Acts as the chat admin: sends a jetton transfer from the admin's own jetton
// wallet to the pool, carrying a backend-signed DepositVoucher in the forward
// payload. A v3 pool credits it only from its admin and only through a
// registered wallet: register the jetton first (poolControl MODE=register).
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const amount = toNano(reqEnv('AMOUNT')); // assumes 9-decimal jetton
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));

    const admin = provider.sender().address;
    if (!admin) throw new Error('Sender address is not defined');

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);
    // the envelope the pool's version asks for, on this network
    const signFor = await voucherSignerFor(provider, poolAddr);

    const expectedJettonWallet = await jettonWalletOf(provider, jettonMaster, poolAddr);
    const adminJettonWallet = await jettonWalletOf(provider, jettonMaster, admin);

    const version = await contractVersion(provider, poolAddr);
    if (version >= 3) {
        const pool = provider.open(ChatPool.fromAddress(poolAddr));
        const registered = await pool.getJettonWallet(jettonMaster);
        // sent anyway (the e2e scenario checks the refunds), but say why
        if (!registered || !registered.equals(expectedJettonWallet)) {
            console.warn('The pool has not registered this jetton (poolControl MODE=register): it will refund.');
        }
        const poolAdmin = await pool.getPoolAdmin();
        if (!poolAdmin || !poolAdmin.equals(admin)) {
            console.warn('Only the pool admin can deposit: this deposit will be refunded.');
        }
    }

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const voucher = depositVoucherCell(version, { chatId, jettonMaster, expectedJettonWallet, expiry });
    const signature = signFor(voucher, kp, TAG.Deposit);
    // The 513-bit payload (voucher ref + 512-bit signature) cannot ride inline
    // in a transfer body (two addresses + fixed fields leave no room), so it
    // travels ref-wrapped as [1 bit][ref payload]. ChatPool accepts both this
    // verbatim form and an already-unwrapped notification payload.
    const payloadCell = beginCell().storeRef(voucher).storeBuffer(signature).endCell();
    const forwardPayload = beginCell().storeUint(1, 1).storeRef(payloadCell).endCell();

    // forward TON covers the notification gas; the pool returns the rest
    const forwardTonAmount = toNano('0.15');

    const prevLt = await lastTxLt(provider, admin);
    await provider.sender().send({
        to: adminJettonWallet,
        value: forwardTonAmount + toNano('0.1'),
        body: beginCell()
            .store(
                storeJettonTransfer({
                    $$type: 'JettonTransfer',
                    queryId: 0n,
                    amount,
                    destination: poolAddr,
                    responseDestination: admin,
                    customPayload: null,
                    forwardTonAmount,
                    forwardPayload,
                }),
            )
            .endCell(),
    });

    console.log('Deposit sent.');
    console.log('  pool                 :', poolAddr.toString());
    console.log('  pool jetton wallet   :', expectedJettonWallet.toString());
    console.log('  admin jetton wallet  :', adminJettonWallet.toString());
    await confirmSend(provider, admin, prevLt, 'deposit');
}

async function jettonWalletOf(provider: NetworkProvider, jettonMaster: Address, owner: Address): Promise<Address> {
    const res = await provider
        .provider(jettonMaster)
        .get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]);
    return (res.stack as TupleReader).readAddress();
}
