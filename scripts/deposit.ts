import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { storeDepositVoucher, storeJettonTransfer } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { signVoucher, TAG } from '../wrappers/Vouchers';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';
import { jettonDecimals, jettonWalletAddress as jettonWalletOf, parseJettonAmount } from './jetton';

// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, AMOUNT, BACKEND_SECRET
// AMOUNT is in whole tokens, scaled by the decimals in the jetton's
// get_jetton_data metadata (JETTON_DECIMALS for off-chain metadata).
//
// Acts as the chat admin: sends a jetton transfer from the admin's own jetton
// wallet to the pool, carrying a backend-signed DepositVoucher in the forward
// payload.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const amount = parseJettonAmount(reqEnv('AMOUNT'), await jettonDecimals(provider, jettonMaster));
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));

    const admin = provider.sender().address;
    if (!admin) throw new Error('Sender address is not defined');

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);

    const expectedJettonWallet = await jettonWalletOf(provider, jettonMaster, poolAddr);
    const adminJettonWallet = await jettonWalletOf(provider, jettonMaster, admin);

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const voucher = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId,
                jettonMaster,
                expectedJettonWallet,
                expiry,
            }),
        )
        .endCell();
    const signature = signVoucher(voucher, kp, TAG.Deposit, poolAddr);
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
