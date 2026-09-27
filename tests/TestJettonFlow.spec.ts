import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, storeMessage, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import { ChatPool, storeAdminInitVoucher, storeClaimVoucher, storeDepositVoucher, storeJettonTransferNotification } from '../wrappers/ChatPool';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from './helpers/vouchers';

// End-to-end wiring test: real jetton minter -> real jetton wallets -> real
// ChatPool, mirroring scripts/deployTestJetton.ts + scripts/deposit.ts byte
// for byte (including the ref-wrapped forward payload region).
describe('TestJetton flow', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let master: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let minter: SandboxContract<TestJettonMinter>;
    let pool: SandboxContract<ChatPool>;

    const CHAT_ID = 1001234567890n;
    const TIER = 1n;
    const FEE_TON = toNano('0.05');
    const AMOUNT = toNano('100');
    const farFuture = BigInt(Math.floor(Date.now() / 1000) + 3600);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        master = await blockchain.treasury('master');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        pool = blockchain.openContract(
            await ChatPool.fromInit(master.address, CHAT_ID, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        const depPool = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(depPool.transactions).toHaveTransaction({
            from: admin.address,
            to: pool.address,
            deploy: true,
            success: true,
        });

        const content = beginCell().storeUint(0, 8).storeStringTail('test').endCell();
        minter = blockchain.openContract(await TestJettonMinter.fromInit(admin.address, content));
        const depMinter = await minter.send(
            admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(depMinter.transactions).toHaveTransaction({ to: minter.address, deploy: true, success: true });

        const mintRes = await minter.send(admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'Mint',
            amount: toNano('1000'),
            recipient: admin.address,
        });
        expect(mintRes.transactions).toHaveTransaction({ to: minter.address, success: true });
    });

    async function setAdmin(
        target: SandboxContract<ChatPool>,
        chatId: bigint,
        claimer: SandboxContract<TreasuryContract>,
    ) {
        const voucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId,
                    master: master.address,
                    admin: claimer.address,
                    expiry: farFuture,
                }),
            )
            .endCell();
        const signature = signatureCell(signVoucher(voucher, backend, TAG.Admin, target.address));
        return target.send(
            claimer.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetAdmin', voucherCell: voucher, signature },
        );
    }

    function dump(res: { transactions: any[] }, title: string) {
        console.log('==== ' + title);
        const j = (v: any) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1);
        for (const tx of res.transactions) {
            const d = tx.description;
            if (d.aborted) {
                console.log('--- aborted tx full description:');
                console.log(j(d));
            }
        }
    }

    it('deposits through real wallets (reproduce testnet flow)', async () => {
        await setAdmin(pool, CHAT_ID, admin); // deposits are refunded until then
        const adminWalletAddr = await minter.getGetWalletAddress(admin.address);
        const poolWalletAddr = await minter.getGetWalletAddress(pool.address);

        const voucher = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster: minter.address,
                    expectedJettonWallet: poolWalletAddr,
                    tier: TIER,
                    feeTon: FEE_TON,
                    expiry: farFuture,
                }),
            )
            .endCell();
        const signature = signVoucher(voucher, backend, TAG.Deposit, pool.address);
        const payloadCell = beginCell().storeRef(voucher).storeBuffer(signature).endCell();
        const forwardPayload = beginCell().storeUint(1, 1).storeRef(payloadCell).endCell();

        const forwardTonAmount = FEE_TON + toNano('0.15');
        const adminWallet = blockchain.openContract(TestJettonWallet.fromAddress(adminWalletAddr));
        const res = await adminWallet.send(
            admin.getSender(),
            { value: forwardTonAmount + toNano('0.1') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount: AMOUNT,
                destination: pool.address,
                responseDestination: admin.address,
                customPayload: null,
                forwardTonAmount,
                forwardPayload,
            },
        );

        dump(res, 'deposit flow');
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: adminWalletAddr, success: true });
        expect(res.transactions).toHaveTransaction({ from: adminWalletAddr, to: poolWalletAddr, success: true, deploy: true });
        expect(res.transactions).toHaveTransaction({ from: poolWalletAddr, to: pool.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: pool.address, to: master.address, success: true });

        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT);
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        expect(await pool.getCurrentTier()).toEqual(TIER);
        expect((await pool.getJettonWallet(minter.address))!.equals(poolWalletAddr)).toBe(true);
    });

    it('accepts a verbatim ref-wrapped payload (stock wallet behavior)', async () => {
        await setAdmin(pool, CHAT_ID, admin);
        const poolWalletAddr = await minter.getGetWalletAddress(pool.address);

        const voucher = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster: minter.address,
                    expectedJettonWallet: poolWalletAddr,
                    tier: TIER,
                    feeTon: FEE_TON,
                    expiry: farFuture,
                }),
            )
            .endCell();
        const signature = signVoucher(voucher, backend, TAG.Deposit, pool.address);
        const payloadCell = beginCell().storeRef(voucher).storeBuffer(signature).endCell();
        // What a stock TEP-74 wallet forwards verbatim: [1 bit][ref payloadCell].
        const verbatimPayload = beginCell().storeUint(1, 1).storeRef(payloadCell).endCell();

        const notification = beginCell()
            .store(
                storeJettonTransferNotification({
                    $$type: 'JettonTransferNotification',
                    queryId: 0n,
                    amount: AMOUNT,
                    sender: admin.address,
                    forwardPayload: verbatimPayload,
                }),
            )
            .endCell();

        // The cooperating test wallet unwraps the payload at the notification
        // hop, so a stock-style delivery is simulated with a raw message from
        // the pool's own jetton wallet address.
        const msgCell = beginCell()
            .store(
                storeMessage({
                    info: {
                        type: 'internal',
                        ihrDisabled: true,
                        bounce: true,
                        bounced: false,
                        src: poolWalletAddr,
                        dest: pool.address,
                        value: { coins: toNano('0.3') },
                        ihrFee: 0n,
                        forwardFee: 0n,
                        createdAt: 0,
                        createdLt: 0n,
                    },
                    body: notification,
                }),
            )
            .endCell();

        const res = await blockchain.sendMessage(msgCell);
        dump(res, 'verbatim deposit');
        expect(res.transactions).toHaveTransaction({
            from: poolWalletAddr,
            to: pool.address,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({ from: pool.address, to: master.address, success: true });

        expect(await pool.getBalanceOf(minter.address)).toEqual(AMOUNT);
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        expect(await pool.getCurrentTier()).toEqual(TIER);
        expect((await pool.getJettonWallet(minter.address))!.equals(poolWalletAddr)).toBe(true);
    });

    it('keeps two chats on the same jetton isolated (balances, admins, nonces)', async () => {
        const CHAT_ID_B = CHAT_ID + 1n;
        const adminB = await blockchain.treasury('adminB');
        const clientA = await blockchain.treasury('clientA');
        const clientB = await blockchain.treasury('clientB');

        await minter.send(
            admin.getSender(),
            { value: toNano('0.2') },
            { $$type: 'Mint', amount: toNano('500'), recipient: adminB.address },
        );

        const poolB = blockchain.openContract(
            await ChatPool.fromInit(master.address, CHAT_ID_B, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        const depB = await poolB.send(
            admin.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );
        expect(depB.transactions).toHaveTransaction({ to: poolB.address, deploy: true, success: true });

        async function depositTo(
            pool: SandboxContract<ChatPool>,
            chatId: bigint,
            depositor: SandboxContract<TreasuryContract>,
            amount: bigint,
        ) {
            const depositorWallet = blockchain.openContract(
                TestJettonWallet.fromAddress(await minter.getGetWalletAddress(depositor.address)),
            );
            const voucher = beginCell()
                .store(
                    storeDepositVoucher({
                        $$type: 'DepositVoucher',
                        chatId,
                        jettonMaster: minter.address,
                        expectedJettonWallet: await minter.getGetWalletAddress(pool.address),
                        tier: TIER,
                        feeTon: FEE_TON,
                        expiry: farFuture,
                    }),
                )
                .endCell();
            const signature = signVoucher(voucher, backend, TAG.Deposit, pool.address);
            const forwardPayload = beginCell()
                .storeUint(1, 1)
                .storeRef(beginCell().storeRef(voucher).storeBuffer(signature).endCell())
                .endCell();
            const forwardTonAmount = FEE_TON + toNano('0.15');
            return depositorWallet.send(
                depositor.getSender(),
                { value: forwardTonAmount + toNano('0.1') },
                {
                    $$type: 'JettonTransfer',
                    queryId: 0n,
                    amount,
                    destination: pool.address,
                    responseDestination: depositor.address,
                    customPayload: null,
                    forwardTonAmount,
                    forwardPayload,
                },
            );
        }

        async function claimFrom(
            pool: SandboxContract<ChatPool>,
            chatId: bigint,
            recipient: SandboxContract<TreasuryContract>,
            amount: bigint,
            nonce: bigint,
        ) {
            const voucher = beginCell()
                .store(
                    storeClaimVoucher({
                        $$type: 'ClaimVoucher',
                        chatId,
                        recipient: recipient.address,
                        jettonMaster: minter.address,
                        amount,
                        nonce,
                        expiry: farFuture,
                    }),
                )
                .endCell();
            const signature = signatureCell(signVoucher(voucher, backend, TAG.Claim, pool.address));
            return pool.send(
                recipient.getSender(),
                { value: toNano('0.15') },
                { $$type: 'Claim', voucherCell: voucher, signature },
            );
        }

        await setAdmin(pool, CHAT_ID, admin);
        await setAdmin(poolB, CHAT_ID_B, adminB);
        await depositTo(pool, CHAT_ID, admin, toNano('100'));
        await depositTo(poolB, CHAT_ID_B, adminB, toNano('500'));
        // lift the default 10%/day claim budget so the whole balance can move
        for (const [p, a] of [[pool, admin], [poolB, adminB]] as const) {
            await p.send(a.getSender(), { value: toNano('0.05') }, {
                $$type: 'SetClaimLimit',
                jettonMaster: minter.address,
                dailyLimit: toNano('1000'),
            });
        }

        // Same jetton master feeds two pools; ledgers, admins and pool
        // jetton wallets are fully independent.
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('100'));
        expect(await poolB.getBalanceOf(minter.address)).toEqual(toNano('500'));
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        expect((await poolB.getPoolAdmin())!.equals(adminB.address)).toBe(true);
        const poolWalletA = (await pool.getJettonWallet(minter.address))!;
        const poolWalletB = (await poolB.getJettonWallet(minter.address))!;
        expect(poolWalletA.equals(poolWalletB)).toBe(false);

        // Nonce 1 is a once-per-pool identifier: it is valid in both chats.
        await claimFrom(pool, CHAT_ID, clientA, toNano('40'), 1n);
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('60'));
        expect(await poolB.getBalanceOf(minter.address)).toEqual(toNano('500'));

        await claimFrom(poolB, CHAT_ID_B, clientB, toNano('500'), 1n);
        expect(await poolB.getBalanceOf(minter.address)).toEqual(0n);
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('60'));
    });
});

describe('TestJetton TEP-74 getters', () => {
    it('exposes get_jetton_data / get_wallet_data with a flat stack and TEP-64 decimals', async () => {
        const { Dictionary } = await import('@ton/core');
        const { sha256_sync } = await import('@ton/crypto');
        const { onchainJettonContent, TEST_JETTON_CONTENT } = await import('../wrappers/TestJetton');

        const blockchain = await Blockchain.create();
        const owner = await blockchain.treasury('owner');
        const minter = blockchain.openContract(
            await TestJettonMinter.fromInit(owner.address, onchainJettonContent(TEST_JETTON_CONTENT)),
        );
        await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        await minter.send(owner.getSender(), { value: toNano('0.2') }, {
            $$type: 'Mint',
            amount: toNano('123'),
            recipient: owner.address,
        });

        const data = await blockchain.runGetMethod(minter.address, 'get_jetton_data');
        expect(data.exitCode).toBe(0);
        expect(data.stack).toHaveLength(5);
        const r = data.stackReader;
        expect(r.readBigNumber()).toBe(toNano('123'));
        expect(r.readBigNumber()).toBe(-1n); // mintable
        expect(r.readAddress().equals(owner.address)).toBe(true);
        const content = r.readCell().beginParse();
        expect(content.loadUint(8)).toBe(0);
        const dict = content.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        const decimals = dict.get(BigInt('0x' + sha256_sync('decimals').toString('hex')))!.beginParse();
        expect(decimals.loadUint(8)).toBe(0);
        expect(decimals.loadStringTail()).toBe('9');

        const walletAddr = await minter.getGetWalletAddress(owner.address);
        const wdata = await blockchain.runGetMethod(walletAddr, 'get_wallet_data');
        expect(wdata.exitCode).toBe(0);
        expect(wdata.stack).toHaveLength(4);
        expect(wdata.stackReader.readBigNumber()).toBe(toNano('123'));
    });
});
