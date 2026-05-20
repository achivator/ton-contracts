import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool, storeClaimVoucher } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { reqEnv } from './env';

// Env: MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, AMOUNT, NONCE, BACKEND_SECRET
//      RECIPIENT (default: the connected wallet)
//
// Submits a backend-signed ClaimVoucher to the pool. The sender pays the gas.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const amount = toNano(reqEnv('AMOUNT'));
    const nonce = BigInt(reqEnv('NONCE'));
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const recipient = process.env.RECIPIENT ? Address.parse(process.env.RECIPIENT) : sender;

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);

    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const voucher = beginCell()
        .store(
            storeClaimVoucher({
                $$type: 'ClaimVoucher',
                chatId,
                recipient,
                jettonMaster,
                amount,
                nonce,
                expiry,
            }),
        )
        .endCell();
    const signature = beginCell().storeBuffer(sign(voucher.hash(), kp.secretKey)).endCell();

    const pool = provider.open(ChatPool.fromAddress(poolAddr));
    await pool.send(
        provider.sender(),
        { value: toNano('0.15') },
        { $$type: 'Claim', voucherCell: voucher, signature },
    );

    console.log('Claim sent:', amount.toString(), 'to', recipient.toString(), 'nonce', nonce.toString());
}
