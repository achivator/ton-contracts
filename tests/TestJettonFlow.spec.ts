import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, storeMessage, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import { ChatPool, storeDepositVoucher, storeJettonTransferNotification } from '../wrappers/ChatPool';
import '@ton/test-utils';

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
        const signature = sign(voucher.hash(), backend.secretKey);
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
        const signature = sign(voucher.hash(), backend.secretKey);
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
});
