import { Address, beginCell, toNano, TupleReader } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { storeDepositVoucher, storeJettonTransfer } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';

// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, AMOUNT, BACKEND_SECRET
//      FEE_TON (default 0.1), TIER (default 0)
//
// Acts as the chat admin: sends a jetton transfer from the admin's own jetton
// wallet to the pool, carrying a backend-signed DepositVoucher in the forward
// payload.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const amount = toNano(reqEnv('AMOUNT')); // assumes 9-decimal jetton
    const feeTon = toNano(process.env.FEE_TON ?? '0.1');
    const tier = BigInt(process.env.TIER ?? '0');
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
                tier,
                feeTon,
                expiry,
            }),
        )
        .endCell();
    const signature = sign(voucher.hash(), kp.secretKey);
    // The 513-bit payload (voucher ref + 512-bit signature) cannot ride inline
    // in a transfer body (two addresses + fixed fields leave no room), so it
    // travels ref-wrapped as [1 bit][ref payload]; the jetton wallet unwraps it
    // at the notification hop, which ChatPool parses inline.
    const payloadCell = beginCell().storeRef(voucher).storeBuffer(signature).endCell();
    const forwardPayload = beginCell().storeUint(1, 1).storeRef(payloadCell).endCell();

    // forward TON must cover the fee forwarded to the master plus notification gas
    const forwardTonAmount = feeTon + toNano('0.15');

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
