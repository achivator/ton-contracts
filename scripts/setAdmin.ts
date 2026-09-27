import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import { ChatPool, storeAdminInitVoucher } from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { signVoucher, TAG } from '../wrappers/Vouchers';
import { reqEnv } from './env';
import { confirmSend, lastTxLt } from './actors';

// Env: MASTER_ADDRESS, CHAT_ID, BACKEND_SECRET
//      ADMIN (default: the connected wallet) - the wallet the voucher names
//      EXPIRY (default now+3600)
//
// Submits a backend-signed AdminInitVoucher via SetAdmin. Init (slot empty):
// the connected wallet must equal ADMIN - it claims its own slot. Rotation
// (slot taken): the connected wallet must be the current pool admin; ADMIN
// names the successor. The sender pays the gas.
export async function run(provider: NetworkProvider) {
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const admin = process.env.ADMIN ? Address.parse(process.env.ADMIN) : sender;

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);

    const expiry = process.env.EXPIRY
        ? BigInt(process.env.EXPIRY)
        : BigInt(Math.floor(Date.now() / 1000) + 3600);
    const voucher = beginCell()
        .store(
            storeAdminInitVoucher({
                $$type: 'AdminInitVoucher',
                chatId,
                master: masterAddr,
                admin,
                expiry,
            }),
        )
        .endCell();
    const signature = beginCell().storeBuffer(signVoucher(voucher, kp, TAG.Admin, poolAddr)).endCell();

    const pool = provider.open(ChatPool.fromAddress(poolAddr));
    const prevLt = await lastTxLt(provider, sender);
    await pool.send(
        provider.sender(),
        { value: toNano('0.05') },
        { $$type: 'SetAdmin', voucherCell: voucher, signature },
    );

    console.log('SetAdmin sent: voucher names', admin.toString(), 'from', sender.toString());
    await confirmSend(provider, sender, prevLt, 'setAdmin');
}
