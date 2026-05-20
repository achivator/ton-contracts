import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair, sign } from '@ton/crypto';
import {
    ChatPool,
    storeDepositVoucher,
    storeClaimVoucher,
} from '../wrappers/ChatPool';
import { DistributorMaster } from '../wrappers/DistributorMaster';
import '@ton/test-utils';

const CHAT_ID = 1001234567890n;

function pubKeyBigInt(kp: KeyPair): bigint {
    return BigInt('0x' + kp.publicKey.toString('hex'));
}

function signCell(cell: Cell, kp: KeyPair): Cell {
    const signature = sign(cell.hash(), kp.secretKey);
    return beginCell().storeBuffer(signature).endCell();
}

function depositForwardPayload(args: {
    chatId: bigint;
    jettonMaster: Address;
    expectedJettonWallet: Address;
    tier: bigint;
    feeTon: bigint;
    expiry: bigint;
    kp: KeyPair;
}): Cell {
    const voucher = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId: args.chatId,
                jettonMaster: args.jettonMaster,
                expectedJettonWallet: args.expectedJettonWallet,
                tier: args.tier,
                feeTon: args.feeTon,
                expiry: args.expiry,
            }),
        )
        .endCell();
    const signature = sign(voucher.hash(), args.kp.secretKey);
    return beginCell().storeRef(voucher).storeBuffer(signature).endCell();
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

    async function deposit(amount: bigint, feeTon: bigint, tier: bigint = 0n) {
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            tier,
            feeTon,
            expiry: farFuture,
            kp: backend,
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

    it('credits a deposit, sets the admin and forwards the TON fee to the master', async () => {
        const res = await deposit(toNano('1000'), toNano('0.1'), 2n);

        expect(res.transactions).toHaveTransaction({
            from: jettonWallet.address,
            to: pool.address,
            success: true,
        });
        // flat TON fee forwarded to the master
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: master.address,
            success: true,
        });

        expect(await pool.getBalanceOf(jettonMaster)).toEqual(toNano('1000'));
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);
        expect(await pool.getCurrentTier()).toEqual(2n);
        expect((await pool.getJettonWallet(jettonMaster))!.equals(jettonWallet.address)).toBe(true);
    });

    it('rejects a deposit notification from an untrusted sender', async () => {
        // voucher names jettonWallet, but a stranger sends the notification
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            tier: 0n,
            feeTon: 0n,
            expiry: farFuture,
            kp: backend,
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
        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: pool.address,
            success: false,
        });
        expect(await pool.getBalanceOf(jettonMaster)).toEqual(0n);
    });

    it('rejects a deposit with a bad signature', async () => {
        const wrongKey = keyPairFromSeed(Buffer.alloc(32, 9));
        const forwardPayload = depositForwardPayload({
            chatId: CHAT_ID,
            jettonMaster,
            expectedJettonWallet: jettonWallet.address,
            tier: 0n,
            feeTon: 0n,
            expiry: farFuture,
            kp: wrongKey,
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
        expect(res.transactions).toHaveTransaction({
            from: jettonWallet.address,
            to: pool.address,
            success: false,
        });
    });

    it('pays out a valid claim and blocks nonce replay', async () => {
        await deposit(toNano('1000'), toNano('0.1'));

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
        const signature = signCell(voucher, backend);

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
        await deposit(toNano('1000'), toNano('0.1'));

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

    it('stores fee tiers, owner only', async () => {
        const bad = await masterC.send(
            stranger.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetFeeTier', tier: 1n, depositFeeTon: toNano('0.6') },
        );
        expect(bad.transactions).toHaveTransaction({ from: stranger.address, to: masterC.address, success: false });

        await masterC.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetFeeTier', tier: 1n, depositFeeTon: toNano('0.6') },
        );
        expect(await masterC.getFeeTier(1n)).toEqual(toNano('0.6'));
    });
});
