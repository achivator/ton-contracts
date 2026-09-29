import { Blockchain, internal, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import {
    ChatPool,
    storeAdminInitVoucher,
    storeDepositVoucher,
    storeClaimVoucher,
    storeJettonTransfer,
} from '../wrappers/ChatPool';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from './helpers/vouchers';

const CHAT_ID = 1001234567890n;
const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const EXCESSES_OP = 0xd53276db;
const REFUND_QUERY = 0x8000000000000003n;
const WITHDRAW_TRACKED_QUERY = 0x8000000000000001n;
const WITHDRAW_UNTRACKED_QUERY = 0x8000000000000002n;

function pubKeyBigInt(kp: KeyPair): bigint {
    return BigInt('0x' + kp.publicKey.toString('hex'));
}


function depositForwardPayload(args: {
    chatId: bigint;
    jettonMaster: Address;
    expectedJettonWallet: Address;
    expiry: bigint;
    kp: KeyPair;
    pool: Address;
}): Cell {
    const voucher = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId: args.chatId,
                jettonMaster: args.jettonMaster,
                expectedJettonWallet: args.expectedJettonWallet,
                expiry: args.expiry,
            }),
        )
        .endCell();
    const signature = signVoucher(voucher, args.kp, TAG.Deposit, args.pool);
    return beginCell().storeRef(voucher).storeBuffer(signature).endCell();
}

function setAdminVoucher(args: {
    chatId: bigint;
    master: Address;
    admin: Address;
    expiry: bigint;
    kp: KeyPair;
    pool: Address;
}): { voucherCell: Cell; signature: Cell } {
    const voucher = beginCell()
        .store(
            storeAdminInitVoucher({
                $$type: 'AdminInitVoucher',
                chatId: args.chatId,
                master: args.master,
                admin: args.admin,
                expiry: args.expiry,
            }),
        )
        .endCell();
    const signature = signVoucher(voucher, args.kp, TAG.Admin, args.pool);
    return { voucherCell: voucher, signature: signatureCell(signature) };
}

describe('Token Distribution', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let master: SandboxContract<TreasuryContract>; // stands in for the DistributorMaster address
    let admin: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let jettonWallet: SandboxContract<TreasuryContract>; // the pool's jetton wallet
    let backend: KeyPair;
    let pool: SandboxContract<ChatPool>;

    const jettonMaster = new Address(0, Buffer.alloc(32, 3));
    const farFuture = BigInt(Math.floor(Date.now() / 1000) + 3600);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        master = await blockchain.treasury('master');
        admin = await blockchain.treasury('admin');
        user = await blockchain.treasury('user');
        jettonWallet = await blockchain.treasury('jettonWallet');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        pool = blockchain.openContract(
            await ChatPool.fromInit(master.address, CHAT_ID, pubKeyBigInt(backend)),
        );

        const dep = await pool.send(
            deployer.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(dep.transactions).toHaveTransaction({
            from: deployer.address,
            to: pool.address,
            deploy: true,
            success: true,
        });
    });

    // Deposits are refunded until the pool has an admin.
    async function initAdmin() {
        const v = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        return pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetAdmin', ...v });
    }

    async function deposit(amount: bigint) {
        if ((await pool.getPoolAdmin()) === null) await initAdmin();
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        return pool.send(
            jettonWallet.getSender(),
            { value: toNano('0.5') },
            {
                $$type: 'JettonTransferNotification',
                queryId: 0n,
                amount,
                sender: admin.address,
                forwardPayload,
            },
        );
    }

    // A rejected deposit is returned to the depositor instead of being stuck
    // uncredited on the pool's jetton wallet.
    function expectRefund(res: SendMessageResult, amount: bigint) {
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            op: JETTON_TRANSFER_OP,
            body: (b) => {
                const cs = b!.beginParse();
                cs.skip(32);
                return cs.loadUintBig(64) === REFUND_QUERY && cs.loadCoins() === amount && cs.loadAddress().equals(admin.address);
            },
        });
        // nothing ever goes to the master
        expect(res.transactions).not.toHaveTransaction({ from: pool.address, to: master.address });
    }

    function claimVoucher(args: {
        amount: bigint;
        nonce: bigint;
        target?: Address;
        tag?: bigint;
        chatId?: bigint;
        expiry?: bigint;
    }) {
        const voucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: args.chatId ?? CHAT_ID,
                    recipient: user.address,
                    jettonMaster,
                    amount: args.amount,
                    nonce: args.nonce,
                    expiry: args.expiry ?? farFuture,
                }),
            )
            .endCell();
        const signature = signatureCell(
            signVoucher(voucher, backend, args.tag ?? TAG.Claim, args.target ?? pool.address),
        );
        return { $$type: 'Claim' as const, voucherCell: voucher, signature };
    }

    it('credits a deposit, takes no fee and returns the forwarded TON', async () => {
        await initAdmin();
        const poolBefore = (await blockchain.getContract(pool.address)).balance;
        const res = await deposit(toNano('1000'));

        expect(res.transactions).toHaveTransaction({
            from: jettonWallet.address,
            to: pool.address,
            success: true,
        });
        // nothing goes to the master
        expect(res.transactions).not.toHaveTransaction({ from: pool.address, to: master.address });
        // the forwarded 0.5 TON minus gas goes back to the depositor
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: admin.address,
            op: EXCESSES_OP,
            value: (v) => v! > toNano('0.45'),
        });
        // the pool keeps its balance, not the depositor's TON
        const poolAfter = (await blockchain.getContract(pool.address)).balance;
        expect(poolAfter).toBeLessThanOrEqual(poolBefore);
        expect(poolBefore - poolAfter).toBeLessThan(toNano('0.001'));

        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        expect((await pool.getJettonWallet(jettonMaster))!.equals(jettonWallet.address)).toBe(true);
    });

    it('rejects a deposit notification from an untrusted sender', async () => {
        await initAdmin();
        // voucher names jettonWallet, but a stranger sends the notification
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const res = await pool.send(
            user.getSender(),
            { value: toNano('0.5') },
            {
                $$type: 'JettonTransferNotification',
                queryId: 0n,
                amount: toNano('1000'),
                sender: admin.address,
                forwardPayload,
            },
        );
        // not credited; the transfer request goes back to the notifier itself,
        // which can only ever move its own jettons
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: user.address,
            op: JETTON_TRANSFER_OP,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
        expect(await pool.getJettonWallet(jettonMaster)).toBeNull();
    });

    it('rejects a deposit with a bad signature', async () => {
        await initAdmin();
        const wrongKey = keyPairFromSeed(Buffer.alloc(32, 9));
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: wrongKey,
            pool: pool.address,
        });
        const res = await pool.send(
            jettonWallet.getSender(),
            { value: toNano('0.5') },
            {
                $$type: 'JettonTransferNotification',
                queryId: 0n,
                amount: toNano('1000'),
                sender: admin.address,
                forwardPayload,
            },
        );
        expectRefund(res, toNano('1000'));
    });

    it('pays out a valid claim and blocks nonce replay', async () => {
        await deposit(toNano('1000'));

        const voucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient: user.address,
                    jettonMaster,
                    amount: toNano('40'),
                    nonce: 1n,
                    expiry: farFuture,
                }),
            )
            .endCell();
        const signature = signatureCell(signVoucher(voucher, backend, TAG.Claim, pool.address));

        const res = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Claim', voucherCell: voucher, signature },
        );
        // pool instructs its jetton wallet to transfer to the recipient
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            success: true,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('960'));
        expect(await pool.getIsNonceUsed(1n)).toBe(true);

        // replay with the same nonce must fail
        const replay = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Claim', voucherCell: voucher, signature },
        );
        expect(replay.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            success: false,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('960'));
    });

    it('lets only the admin withdraw the remainder', async () => {
        // withdrawals are rejected while the slot is empty
        const noAdmin = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('100'), to: admin.address },
        );
        expect(noAdmin.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            success: false,
        });
        await deposit(toNano('1000'));

        const { voucherCell, signature } = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            voucherCell,
            signature,
        });

        // non-admin is rejected
        const bad = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('100'), to: user.address },
        );
        expect(bad.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            success: false,
        });

        // admin sweeps out via the registered jetton wallet
        const ok = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('1000'), to: admin.address },
        );
        expect(ok.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            success: true,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });

    it('lets the wallet named in the admin voucher claim an empty slot', async () => {
        const { voucherCell, signature } = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const poolBefore = (await blockchain.getContract(pool.address)).balance;
        const res = await pool.send(
            admin.getSender(),
            { value: toNano('0.5') },
            { $$type: 'SetAdmin', voucherCell, signature },
        );
        expect(res.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            success: true,
        });
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        // the attached TON beyond the gas comes back; the pool keeps nothing
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: admin.address,
            op: EXCESSES_OP,
            value: (v) => v! > toNano('0.45'),
        });
        const poolAfter = (await blockchain.getContract(pool.address)).balance;
        expect(poolAfter - poolBefore).toBeLessThan(toNano('0.001'));

        // The freshly initialized admin controls WithdrawRemainder.
        await deposit(toNano('1000'));
        const sweep = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('1000'), to: admin.address },
        );
        expect(sweep.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            success: true,
        });
    });

    it('rejects an init where the sender is not the wallet named in the voucher', async () => {
        // A leaked init voucher is useless to anyone but its named wallet.
        const { voucherCell, signature } = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const res = await pool.send(
            user.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', voucherCell, signature },
        );
        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            success: false,
        });
        expect(await pool.getPoolAdmin()).toBeNull();
    });

    it('rotates the admin with the current admin consent, and only then', async () => {
        await deposit(toNano('1000'));

        // init to `admin`
        const init = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            voucherCell: init.voucherCell,
            signature: init.signature,
        });

        // a stranger cannot rotate, even holding a valid voucher naming itself
        const evil = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: user.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const bad = await pool.send(user.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            voucherCell: evil.voucherCell,
            signature: evil.signature,
        });
        expect(bad.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            success: false,
        });
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);

        // current admin hands over to user
        const handover = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: user.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const ok = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            voucherCell: handover.voucherCell,
            signature: handover.signature,
        });
        expect(ok.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            success: true,
        });
        expect((await pool.getPoolAdmin())!.equals(user.address)).toBe(true);

        // the old admin loses withdrawal rights...
        const stale = await pool.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'WithdrawRemainder',
            jettonMaster,
            amount: toNano('1000'),
            to: admin.address,
        });
        expect(stale.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            success: false,
        });

        // ...and cannot re-grab the slot by replaying the init voucher.
        const replay = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            voucherCell: init.voucherCell,
            signature: init.signature,
        });
        expect(replay.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            success: false,
        });
        expect((await pool.getPoolAdmin())!.equals(user.address)).toBe(true);

        // the new admin can withdraw.
        const sweep = await pool.send(user.getSender(), { value: toNano('0.1') }, {
            $$type: 'WithdrawRemainder',
            jettonMaster,
            amount: toNano('1000'),
            to: user.address,
        });
        expect(sweep.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            success: true,
        });
    });

    it('rejects expired, cross-chat, cross-master and badly signed admin vouchers', async () => {
        const past = BigInt(Math.floor(Date.now() / 1000) - 60);
        const good = {
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        };

        // expired
        const expired = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            ...setAdminVoucher({ ...good, expiry: past }),
        });
        expect(expired.transactions).toHaveTransaction({
            from: admin.address, to: pool.address, success: false,
        });

        // voucher for another chat
        const crossChat = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            ...setAdminVoucher({ ...good, chatId: CHAT_ID + 1n }),
        });
        expect(crossChat.transactions).toHaveTransaction({
            from: admin.address, to: pool.address, success: false,
        });

        // voucher for another master
        const crossMaster = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            ...setAdminVoucher({ ...good, master: user.address }),
        });
        expect(crossMaster.transactions).toHaveTransaction({
            from: admin.address, to: pool.address, success: false,
        });

        // signature by a different key
        const wrongKey = keyPairFromSeed(Buffer.alloc(32, 9));
        const badSig = await pool.send(admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetAdmin',
            ...setAdminVoucher({ ...good, kp: wrongKey }),
        });
        expect(badSig.transactions).toHaveTransaction({
            from: admin.address, to: pool.address, success: false,
        });

        expect(await pool.getPoolAdmin()).toBeNull();
    });

    // ---- audit regressions ----

    it('refunds a deposit whose forward TON does not cover the gas, instead of paying it from the pool', async () => {
        await initAdmin();
        const poolBefore = (await blockchain.getContract(pool.address)).balance;
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const res = await pool.send(
            jettonWallet.getSender(),
            { value: toNano('0.01') },
            { $$type: 'JettonTransferNotification', queryId: 0n, amount: toNano('1000'), sender: admin.address, forwardPayload },
        );
        expectRefund(res, toNano('1000'));
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
        expect((await blockchain.getContract(pool.address)).balance).toBeGreaterThanOrEqual(poolBefore - toNano('0.001'));
    });

    it('refunds a deposit voucher signed for another pool or as another voucher kind', async () => {
        await initAdmin();
        const other = await blockchain.treasury('otherPool');
        const base = {
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: backend,
        };
        for (const forwardPayload of [
            depositForwardPayload({ ...base, pool: other.address }),
            (() => {
                // correct target, but signed as a claim voucher
                const voucher = beginCell()
                    .store(storeDepositVoucher({ $$type: 'DepositVoucher', ...base }))
                    .endCell();
                const sig = signVoucher(voucher, backend, TAG.Claim, pool.address);
                return beginCell().storeRef(voucher).storeBuffer(sig).endCell();
            })(),
        ]) {
            const res = await pool.send(
                jettonWallet.getSender(),
                { value: toNano('0.5') },
                { $$type: 'JettonTransferNotification', queryId: 0n, amount: toNano('5'), sender: admin.address, forwardPayload },
            );
            expectRefund(res, toNano('5'));
        }
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });

    it('never re-points a registered jetton to another wallet', async () => {
        await deposit(toNano('10'));
        const rogueWallet = await blockchain.treasury('rogueWallet');
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: rogueWallet.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        await pool.send(
            rogueWallet.getSender(),
            { value: toNano('0.5') },
            { $$type: 'JettonTransferNotification', queryId: 0n, amount: toNano('1000000'), sender: admin.address, forwardPayload },
        );
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('10'));
        expect((await pool.getJettonWallet(jettonMaster))!.equals(jettonWallet.address)).toBe(true);
    });

    it('rejects claim vouchers signed for another pool or as another kind', async () => {
        await deposit(toNano('1000'));
        const other = await blockchain.treasury('otherPool');
        for (const body of [
            claimVoucher({ amount: toNano('1'), nonce: 1n, target: other.address }),
            claimVoucher({ amount: toNano('1'), nonce: 1n, tag: TAG.Admin }),
            claimVoucher({ amount: toNano('1'), nonce: 1n, tag: TAG.Register }),
        ]) {
            const res = await pool.send(user.getSender(), { value: toNano('0.1') }, body);
            expect(res.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
        }
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
    });

    it('rejects claims without enough gas, with zero amount or an out-of-range nonce', async () => {
        await deposit(toNano('1000'));
        const cases: [ReturnType<typeof claimVoucher>, bigint][] = [
            [claimVoucher({ amount: toNano('1'), nonce: 1n }), toNano('0.01')],
            [claimVoucher({ amount: 0n, nonce: 2n }), toNano('0.1')],
            [claimVoucher({ amount: toNano('1'), nonce: 0n }), toNano('0.1')],
            [claimVoucher({ amount: toNano('1'), nonce: 0x8000000000000001n }), toNano('0.1')],
        ];
        for (const [body, value] of cases) {
            const res = await pool.send(user.getSender(), { value }, body);
            expect(res.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
        }
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
    });

    it('restores the ledger and releases the nonce when a claim transfer bounces', async () => {
        await deposit(toNano('1000'));
        const body = claimVoucher({ amount: toNano('40'), nonce: 7n });
        await pool.send(user.getSender(), { value: toNano('0.1') }, body);
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('960'));
        expect(await pool.getIsNonceUsed(7n)).toBe(true);

        // the pool's jetton wallet rejects the transfer and bounces it
        const transfer = beginCell()
            .store(
                storeJettonTransfer({
                    $$type: 'JettonTransfer',
                    queryId: 7n,
                    amount: toNano('40'),
                    destination: user.address,
                    responseDestination: user.address,
                    customPayload: null,
                    forwardTonAmount: 0n,
                    forwardPayload: beginCell().endCell(),
                }),
            )
            .endCell();
        const bouncedBody = beginCell()
            .storeUint(0xffffffff, 32)
            .storeBits(transfer.beginParse().loadBits(256))
            .endCell();
        await blockchain.sendMessage(
            internal({ from: jettonWallet.address, to: pool.address, value: toNano('0.05'), body: bouncedBody, bounced: true }),
        );
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
        expect(await pool.getIsNonceUsed(7n)).toBe(false);

        // a bounce-shaped message from an unregistered contract changes nothing
        await blockchain.sendMessage(
            internal({ from: user.address, to: pool.address, value: toNano('0.05'), body: bouncedBody, bounced: true }),
        );
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
    });

    it('rejects withdrawals without enough gas', async () => {
        await deposit(toNano('1000'));
        const { voucherCell, signature } = setAdminVoucher({
            chatId: CHAT_ID,
            master: master.address,
            admin: admin.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetAdmin', voucherCell, signature });
        const res = await pool.send(
            admin.getSender(),
            { value: toNano('0.01') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('1'), to: admin.address },
        );
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: pool.address, success: false });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));

        const ok = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('1'), to: admin.address },
        );
        expect(ok.transactions).toHaveTransaction({
            from: pool.address,
            to: jettonWallet.address,
            body: (b) => {
                const cs = b!.beginParse();
                cs.skip(32);
                return cs.loadUintBig(64) === WITHDRAW_TRACKED_QUERY;
            },
        });
    });

    // ---- leaked-key blast radius ----

    it('refunds deposits while the pool has no admin (nothing for a leaked key to take over)', async () => {
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            expiry: farFuture,
            kp: backend,
            pool: pool.address,
        });
        const res = await pool.send(
            jettonWallet.getSender(),
            { value: toNano('0.5') },
            { $$type: 'JettonTransferNotification', queryId: 0n, amount: toNano('1000'), sender: admin.address, forwardPayload },
        );
        expectRefund(res, toNano('1000'));
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });

    it('caps claims at 10% of the balance per day by default', async () => {
        await deposit(toNano('1000'));
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(toNano('100'));

        const ok = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('60'), nonce: 1n }));
        expect(ok.transactions).toHaveTransaction({ from: pool.address, to: jettonWallet.address, success: true });
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(toNano('40'));

        // a stolen key could sign this, but the pool refuses to go over budget
        const over = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('41'), nonce: 2n }));
        expect(over.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('940'));

        // next UTC day the budget renews (10% of the new balance)
        blockchain.now = Math.floor(Date.now() / 1000) + 86400;
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(toNano('94'));
        const tomorrow = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('41'), nonce: 2n, expiry: farFuture + 86400n }));
        expect(tomorrow.transactions).toHaveTransaction({ from: pool.address, to: jettonWallet.address, success: true });
    });

    it('lets only the admin set an explicit daily limit, effective immediately', async () => {
        await deposit(toNano('1000'));
        const bad = await pool.send(user.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetClaimLimit', jettonMaster, dailyLimit: toNano('1000'),
        });
        expect(bad.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });

        await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('90'), nonce: 1n }));
        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimLimit', jettonMaster, dailyLimit: toNano('500') });
        expect(await pool.getClaimLimit(jettonMaster)).toEqual(toNano('500'));
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(toNano('410'));

        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimLimit', jettonMaster, dailyLimit: toNano('50') });
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(0n);
        const blocked = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('1'), nonce: 2n }));
        expect(blocked.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });

        // 0 restores the default share
        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimLimit', jettonMaster, dailyLimit: 0n });
        expect(await pool.getClaimLimit(jettonMaster)).toEqual(0n);
        expect(await pool.getClaimableToday(jettonMaster)).toEqual(toNano('1'));
    });

    it('lets the admin pause claims and move the pool to a new backend key', async () => {
        await deposit(toNano('1000'));

        const strangerPause = await pool.send(user.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimsPaused', paused: true });
        expect(strangerPause.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });

        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimsPaused', paused: true });
        expect(await pool.getClaimsPaused()).toBe(true);
        const paused = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('1'), nonce: 1n }));
        expect(paused.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });

        // rotate to a fresh key: old-key vouchers die, new-key vouchers work
        const fresh = keyPairFromSeed(Buffer.alloc(32, 11));
        const strangerKey = await pool.send(user.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetPoolBackendKey', backendPubKey: pubKeyBigInt(fresh),
        });
        expect(strangerKey.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetPoolBackendKey', backendPubKey: pubKeyBigInt(fresh) });
        expect(await pool.getBackendKey()).toEqual(pubKeyBigInt(fresh));
        await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetClaimsPaused', paused: false });

        const oldKey = await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('1'), nonce: 1n }));
        expect(oldKey.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });

        const voucher = claimVoucher({ amount: toNano('1'), nonce: 1n });
        voucher.signature = signatureCell(signVoucher(voucher.voucherCell, fresh, TAG.Claim, pool.address));
        const newKey = await pool.send(user.getSender(), { value: toNano('0.1') }, voucher);
        expect(newKey.transactions).toHaveTransaction({ from: pool.address, to: jettonWallet.address, success: true });
    });

    it('keeps a storage fee per claim so nonce entries never eat the pool balance', async () => {
        await deposit(toNano('1000'));
        const before = (await blockchain.getContract(pool.address)).balance;
        for (let n = 1n; n <= 5n; n++) {
            await pool.send(user.getSender(), { value: toNano('0.1') }, claimVoucher({ amount: toNano('1'), nonce: n }));
        }
        const after = (await blockchain.getContract(pool.address)).balance;
        expect(after - before).toBeGreaterThanOrEqual(toNano('0.009'));
    });

    // ---- audit regressions: withdrawal and voucher strictness ----

    it('rejects a zero withdrawal', async () => {
        await deposit(toNano('1000'));
        const res = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'WithdrawRemainder', jettonMaster, amount: 0n, to: admin.address },
        );
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: pool.address, success: false });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
    });

    it('restores the ledger when a tracked withdrawal bounces, but not for an untracked one', async () => {
        await deposit(toNano('1000'));

        // tracked: amount <= balance, ledger debited to 900
        await pool.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('100'), to: admin.address,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('900'));

        // the jetton wallet rejects the transfer and bounces it
        const tracked = beginCell()
            .store(storeJettonTransfer({
                $$type: 'JettonTransfer',
                queryId: WITHDRAW_TRACKED_QUERY,
                amount: toNano('100'),
                destination: admin.address,
                responseDestination: admin.address,
                customPayload: null,
                forwardTonAmount: 0n,
                forwardPayload: beginCell().endCell(),
            }))
            .endCell();
        const bouncedTracked = beginCell()
            .storeUint(0xffffffff, 32)
            .storeBits(tracked.beginParse().loadBits(256))
            .endCell();
        await blockchain.sendMessage(
            internal({ from: jettonWallet.address, to: pool.address, value: toNano('0.05'), body: bouncedTracked, bounced: true }),
        );
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));

        // untracked: amount > balance zeroes the ledger; its bounce must not
        // credit anything back (the jettons never were in the ledger)
        await pool.send(admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'WithdrawRemainder', jettonMaster, amount: toNano('2000'), to: admin.address,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
        const untracked = beginCell()
            .store(storeJettonTransfer({
                $$type: 'JettonTransfer',
                queryId: WITHDRAW_UNTRACKED_QUERY,
                amount: toNano('2000'),
                destination: admin.address,
                responseDestination: admin.address,
                customPayload: null,
                forwardTonAmount: 0n,
                forwardPayload: beginCell().endCell(),
            }))
            .endCell();
        const bouncedUntracked = beginCell()
            .storeUint(0xffffffff, 32)
            .storeBits(untracked.beginParse().loadBits(256))
            .endCell();
        await blockchain.sendMessage(
            internal({ from: jettonWallet.address, to: pool.address, value: toNano('0.05'), body: bouncedUntracked, bounced: true }),
        );
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });

    it('rejects admin vouchers signed as another kind or for another pool', async () => {
        const other = await blockchain.treasury('otherPool');
        const voucher = beginCell()
            .store(storeAdminInitVoucher({
                $$type: 'AdminInitVoucher',
                chatId: CHAT_ID,
                master: master.address,
                admin: admin.address,
                expiry: farFuture,
            }))
            .endCell();
        const cases = [
            // right target, wrong tag
            { voucherCell: voucher, signature: signatureCell(signVoucher(voucher, backend, TAG.Claim, pool.address)) },
            // right tag, wrong target
            { voucherCell: voucher, signature: signatureCell(signVoucher(voucher, backend, TAG.Admin, other.address)) },
        ];
        for (const v of cases) {
            const res = await pool.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetAdmin', ...v });
            expect(res.transactions).toHaveTransaction({ from: admin.address, to: pool.address, success: false });
        }
        expect(await pool.getPoolAdmin()).toBeNull();
    });

    it('rejects claim vouchers with trailing data without burning the nonce', async () => {
        await deposit(toNano('1000'));
        const voucher = beginCell()
            .store(storeClaimVoucher({
                $$type: 'ClaimVoucher',
                chatId: CHAT_ID,
                recipient: user.address,
                jettonMaster,
                amount: toNano('1'),
                nonce: 1n,
                expiry: farFuture,
            }))
            .storeUint(1, 16)
            .endCell();
        const res = await pool.send(user.getSender(), { value: toNano('0.1') }, {
            $$type: 'Claim',
            voucherCell: voucher,
            signature: signatureCell(signVoucher(voucher, backend, TAG.Claim, pool.address)),
        });
        expect(res.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
        expect(await pool.getIsNonceUsed(1n)).toBe(false);
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
    });

    it('aborts a deposit whose voucher carries trailing data (backend-signed, so a throw, not a refund)', async () => {
        await initAdmin();
        const voucher = beginCell()
            .store(storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId: CHAT_ID,
                jettonMaster,
                expectedJettonWallet: jettonWallet.address,
                expiry: farFuture,
            }))
            .storeUint(1, 16)
            .endCell();
        const forwardPayload = beginCell()
            .storeRef(voucher)
            .storeBuffer(signVoucher(voucher, backend, TAG.Deposit, pool.address))
            .endCell();
        const res = await pool.send(
            jettonWallet.getSender(),
            { value: toNano('0.5') },
            { $$type: 'JettonTransferNotification', queryId: 0n, amount: toNano('1000'), sender: admin.address, forwardPayload },
        );
        expect(res.transactions).toHaveTransaction({ from: jettonWallet.address, to: pool.address, success: false });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });
});

describe('DistributorMaster', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let masterC: SandboxContract<DistributorMaster>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        owner = await blockchain.treasury('owner');
        stranger = await blockchain.treasury('stranger');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        masterC = blockchain.openContract(
            await DistributorMaster.fromInit(owner.address, pubKeyBigInt(backend)),
        );
        const dep = await masterC.send(
            deployer.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(dep.transactions).toHaveTransaction({ to: masterC.address, deploy: true, success: true });
    });

    it('derives a deterministic, chat-specific pool address', async () => {
        const a = await masterC.getPoolAddress(CHAT_ID);
        const aAgain = await masterC.getPoolAddress(CHAT_ID);
        const b = await masterC.getPoolAddress(CHAT_ID + 1n);
        expect(a.equals(aAgain)).toBe(true);
        expect(a.equals(b)).toBe(false);
    });

    it('deploys a pool at the derived address via CreatePool', async () => {
        const expected = await masterC.getPoolAddress(CHAT_ID);
        const res = await masterC.send(
            stranger.getSender(),
            { value: toNano('0.3') },
            { $$type: 'CreatePool', chatId: CHAT_ID },
        );
        expect(res.transactions).toHaveTransaction({
            from: masterC.address,
            to: expected,
            deploy: true,
            success: true,
        });
    });

    it('makes the CreatePool caller pay for the deploy', async () => {
        const before = (await blockchain.getContract(masterC.address)).balance;
        const cheap = await masterC.send(
            stranger.getSender(),
            { value: toNano('0.02') },
            { $$type: 'CreatePool', chatId: CHAT_ID },
        );
        expect(cheap.transactions).toHaveTransaction({ from: stranger.address, to: masterC.address, success: false });
        expect(cheap.transactions).not.toHaveTransaction({ from: masterC.address, deploy: true });
        expect((await blockchain.getContract(masterC.address)).balance).toBeGreaterThanOrEqual(before);

        // a proper activation leaves the deploy value on the pool
        const expected = await masterC.getPoolAddress(CHAT_ID);
        await masterC.send(stranger.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect((await blockchain.getContract(expected)).balance).toBeGreaterThan(toNano('0.09'));
    });

    it('keeps nothing from CreatePool: the pool gets its deploy value, the caller the rest', async () => {
        const before = (await blockchain.getContract(masterC.address)).balance;
        const res = await masterC.send(stranger.getSender(), { value: toNano('1') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect(res.transactions).toHaveTransaction({
            from: masterC.address,
            to: stranger.address,
            op: EXCESSES_OP,
            value: (v) => v! > toNano('0.85'),
        });
        const after = (await blockchain.getContract(masterC.address)).balance;
        expect(after).toBeLessThanOrEqual(before);
        expect(before - after).toBeLessThan(toNano('0.001'));
    });

    it('rotates the backend key, owner only, and returns the attached TON', async () => {
        const next = BigInt('0x' + keyPairFromSeed(Buffer.alloc(32, 8)).publicKey.toString('hex'));
        const bad = await masterC.send(stranger.getSender(), { value: toNano('0.05') }, { $$type: 'RotateBackendKey', backendPubKey: next });
        expect(bad.transactions).toHaveTransaction({ from: stranger.address, to: masterC.address, success: false });

        const before = (await blockchain.getContract(masterC.address)).balance;
        const ok = await masterC.send(owner.getSender(), { value: toNano('0.5') }, { $$type: 'RotateBackendKey', backendPubKey: next });
        expect(ok.transactions).toHaveTransaction({ from: masterC.address, to: owner.address, value: (v) => v! > toNano('0.45') });
        expect(await masterC.getBackendKey()).toEqual(next);
        expect((await blockchain.getContract(masterC.address)).balance - before).toBeLessThan(toNano('0.001'));
    });
});
