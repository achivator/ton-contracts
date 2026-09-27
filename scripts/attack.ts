import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import {
    ChatPool,
    storeAdminInitVoucher,
    storeClaim,
    storeClaimVoucher,
    storeDepositVoucher,
    storeJettonTransfer,
    storeJettonTransferNotification,
    storeSetAdmin,
} from '../wrappers/ChatPool';
import { NetworkProvider } from '@ton/blueprint';
import { signVoucher, TAG } from '../wrappers/Vouchers';
import { confirmSend, jettonWalletOf, lastTxLt, sleep } from './actors';
import { reqEnv } from './env';

// Adversarial submissions, each expected to be rejected on-chain.
// Env: MODE, MASTER_ADDRESS, JETTON_MASTER, CHAT_ID, BACKEND_SECRET
// Modes and their extra env:
//   bad_signature  - valid shape, signed with a foreign key        (AMOUNT, NONCE)
//   tampered       - signature over AMOUNT, submits TAMPER_AMOUNT  (AMOUNT, TAMPER_AMOUNT, NONCE)
//   expired        - validly signed, EXPIRY in the past            (AMOUNT, NONCE, EXPIRY)
//   replay         - valid signature over an already-used nonce    (AMOUNT, NONCE, EXPIRY)
//   cross_chat     - chat2 voucher submitted to the CHAT_ID pool   (VOUCHER_CHAT_ID, AMOUNT, NONCE)
//   fake_notify    - forged JettonTransferNotification to the pool (AMOUNT, FEE_TON, TIER)
//   junk_deposit   - junk ref payload in a real jetton transfer    (AMOUNT, FORWARD_TON)
//   withdraw       - non-admin WithdrawRemainder                   (AMOUNT, TO)
//   set_admin      - backend-signed AdminInitVoucher sent from the wrong
//                    wallet: on an empty slot the sender must be the named
//                    admin; on a taken slot only the current admin may rotate.
//                    ADMIN (voucher's admin, default: sender) and
//                    SIG_KEY=foreign (sign with seed 7 instead of the backend
//                    key) shape the two forgery flavours.
// Common optional: RECIPIENT (default: the connected wallet), EXPIRY (default now+3600)
export async function run(provider: NetworkProvider) {
    const mode = reqEnv('MODE');
    const masterAddr = Address.parse(reqEnv('MASTER_ADDRESS'));
    const jettonMaster = Address.parse(reqEnv('JETTON_MASTER'));
    const chatId = BigInt(reqEnv('CHAT_ID'));
    const kp = keyPairFromSeed(Buffer.from(reqEnv('BACKEND_SECRET'), 'hex'));

    const sender = provider.sender().address;
    if (!sender) throw new Error('Sender address is not defined');
    const recipient = process.env.RECIPIENT ? Address.parse(process.env.RECIPIENT) : sender;
    const expiry = process.env.EXPIRY
        ? BigInt(process.env.EXPIRY)
        : BigInt(Math.floor(Date.now() / 1000) + 3600);

    const master = provider.open(DistributorMaster.fromAddress(masterAddr));
    const poolAddr = await master.getPoolAddress(chatId);
    const pool = provider.open(ChatPool.fromAddress(poolAddr));
    const poolJw = await jettonWalletOf(provider, jettonMaster, poolAddr);

    const buildClaimBody = (amount: bigint, nonce: bigint, vChatId: bigint, cellExpiry: bigint, sigKp: typeof kp) => {
        const voucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: vChatId,
                    recipient,
                    jettonMaster,
                    amount,
                    nonce,
                    expiry: cellExpiry,
                }),
            )
            .endCell();
        const signature = beginCell().storeBuffer(signVoucher(voucher, sigKp, TAG.Claim, poolAddr)).endCell();
        return beginCell().store(storeClaim({ $$type: 'Claim', voucherCell: voucher, signature })).endCell();
    };

    const prevLt = await lastTxLt(provider, sender);
    const poolPrevLt = await lastTxLt(provider, poolAddr);

    switch (mode) {
        case 'bad_signature': {
            const amount = toNano(reqEnv('AMOUNT'));
            const nonce = BigInt(reqEnv('NONCE'));
            const wrongKp = keyPairFromSeed(Buffer.alloc(32, 7));
            const body = buildClaimBody(amount, nonce, chatId, expiry, wrongKp);
            await provider.sender().send({ to: poolAddr, value: toNano('0.15'), body });
            break;
        }
        case 'tampered': {
            const amount = toNano(reqEnv('AMOUNT'));
            const tamper = toNano(reqEnv('TAMPER_AMOUNT'));
            const nonce = BigInt(reqEnv('NONCE'));
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
            const signature = signVoucher(voucher, kp, TAG.Claim, poolAddr);
            const submitted = beginCell()
                .store(
                    storeClaimVoucher({
                        $$type: 'ClaimVoucher',
                        chatId,
                        recipient,
                        jettonMaster,
                        amount: tamper,
                        nonce,
                        expiry,
                    }),
                )
                .endCell();
            const body = beginCell()
                .store(
                    storeClaim({
                        $$type: 'Claim',
                        voucherCell: submitted,
                        signature: beginCell().storeBuffer(signature).endCell(),
                    }),
                )
                .endCell();
            await provider.sender().send({ to: poolAddr, value: toNano('0.15'), body });
            break;
        }
        case 'expired': {
            const amount = toNano(reqEnv('AMOUNT'));
            const nonce = BigInt(reqEnv('NONCE'));
            const body = buildClaimBody(amount, nonce, chatId, expiry, kp);
            await provider.sender().send({ to: poolAddr, value: toNano('0.15'), body });
            break;
        }
        case 'replay': {
            // Same voucher cell as a claim that already landed: only the nonce
            // check can reject it, so this isolates replay protection.
            const amount = toNano(reqEnv('AMOUNT'));
            const nonce = BigInt(reqEnv('NONCE'));
            const body = buildClaimBody(amount, nonce, chatId, expiry, kp);
            await provider.sender().send({ to: poolAddr, value: toNano('0.15'), body });
            break;
        }
        case 'cross_chat': {
            const voucherChatId = BigInt(reqEnv('VOUCHER_CHAT_ID'));
            const amount = toNano(reqEnv('AMOUNT'));
            const nonce = BigInt(reqEnv('NONCE'));
            const body = buildClaimBody(amount, nonce, voucherChatId, expiry, kp);
            await provider.sender().send({ to: poolAddr, value: toNano('0.15'), body });
            break;
        }
        case 'fake_notify': {
            const amount = toNano(reqEnv('AMOUNT'));
            const feeTon = toNano(process.env.FEE_TON ?? '0.1');
            const tier = BigInt(process.env.TIER ?? '0');
            const voucher = beginCell()
                .store(
                    storeDepositVoucher({
                        $$type: 'DepositVoucher',
                        chatId,
                        jettonMaster,
                        expectedJettonWallet: poolJw,
                        tier,
                        feeTon,
                        expiry,
                    }),
                )
                .endCell();
            const signature = signVoucher(voucher, kp, TAG.Deposit, poolAddr);
            const payloadCell = beginCell().storeRef(voucher).storeBuffer(signature).endCell();
            const forwardPayload = beginCell().storeUint(1, 1).storeRef(payloadCell).endCell();
            const body = beginCell()
                .store(
                    storeJettonTransferNotification({
                        $$type: 'JettonTransferNotification',
                        queryId: 0n,
                        amount,
                        sender: poolJw,
                        forwardPayload,
                    }),
                )
                .endCell();
            await provider.sender().send({ to: poolAddr, value: toNano('0.1'), body });
            break;
        }
        case 'junk_deposit': {
            const amount = toNano(reqEnv('AMOUNT'));
            const forwardTon = toNano(process.env.FORWARD_TON ?? '0.05');
            const selfJw = await jettonWalletOf(provider, jettonMaster, sender);
            const garbage = beginCell().storeUint(0xdeadbeef, 32).endCell();
            const forwardPayload = beginCell().storeUint(1, 1).storeRef(garbage).endCell();
            const body = beginCell()
                .store(
                    storeJettonTransfer({
                        $$type: 'JettonTransfer',
                        queryId: 0n,
                        amount,
                        destination: poolAddr,
                        responseDestination: sender,
                        customPayload: null,
                        forwardTonAmount: forwardTon,
                        forwardPayload,
                    }),
                )
                .endCell();
            await provider.sender().send({ to: selfJw, value: toNano('0.2'), body });
            break;
        }
        case 'withdraw': {
            const amount = toNano(reqEnv('AMOUNT'));
            const to = process.env.TO ? Address.parse(process.env.TO) : sender;
            await pool.send(provider.sender(), { value: toNano('0.15') }, { $$type: 'WithdrawRemainder', jettonMaster, amount, to });
            break;
        }
        case 'set_admin': {
            const namedAdmin = process.env.ADMIN ? Address.parse(process.env.ADMIN) : sender;
            const signKp = process.env.SIG_KEY === 'foreign'
                ? keyPairFromSeed(Buffer.alloc(32, 7))
                : kp;
            const voucher = beginCell()
                .store(
                    storeAdminInitVoucher({
                        $$type: 'AdminInitVoucher',
                        chatId,
                        master: masterAddr,
                        admin: namedAdmin,
                        expiry,
                    }),
                )
                .endCell();
            const signature = beginCell().storeBuffer(signVoucher(voucher, signKp, TAG.Admin, poolAddr)).endCell();
            const body = beginCell()
                .store(storeSetAdmin({ $$type: 'SetAdmin', voucherCell: voucher, signature }))
                .endCell();
            await provider.sender().send({ to: poolAddr, value: toNano('0.05'), body });
            break;
        }
        default:
            throw new Error(`Unknown MODE "${mode}"`);
    }

    await confirmSend(provider, sender, prevLt, `attack ${mode}`);
    await reportReject(provider, poolAddr, poolPrevLt, mode);
    // Deposit-shaped attacks (fake_notify, junk_deposit) are not thrown any more:
    // the pool refunds them (exit 0, one outbound transfer) without crediting
    // the ledger. scenarioVerify checks the ledger, which is what matters.
    console.log(`ATTACK ${mode} sent (expected on-chain rejection or refund)`);
}

// Waits for the pool's next transaction and prints its compute-phase result,
// so the on-chain rejection (and its exit code) is directly visible.
async function reportReject(
    provider: NetworkProvider,
    poolAddr: Address,
    poolPrevLt: string,
    mode: string,
): Promise<void> {
    const api: any = provider.api();
    for (let i = 0; i < 12; i++) {
        const txs = await api.getTransactions(poolAddr, { limit: 1 });
        if (txs && txs.length > 0 && txs[0].lt.toString() !== poolPrevLt) {
            const d: any = txs[0].description;
            let exit = 'n/a';
            let aborted = 0;
            if (d && d.type === 'generic') {
                aborted = d.aborted ? 1 : 0;
                if (d.computePhase && d.computePhase.type === 'vm') {
                    exit = String(d.computePhase.exitCode);
                } else if (d.computePhase && d.computePhase.type === 'skipped') {
                    exit = 'skipped:' + d.computePhase.reason.type;
                }
            }
            console.log(`ATTACK ${mode} tx exit=${exit} aborted=${aborted} out=${txs[0].outMessagesCount}`);
            return;
        }
        await sleep(2500);
    }
    console.log(`ATTACK ${mode} tx not observed`);
}
