import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { flattenTransaction } from '@ton/test-utils';
import { ChatPool, storeAdminInitVoucher, storeClaimVoucher, storeDepositVoucher } from '../wrappers/ChatPool';
import '@ton/test-utils';
import { globalIdOf, signatureCell, signVoucher, TAG } from './helpers/vouchers';
import {
    mintToRealWallet,
    REAL_JETTON_WALLETS,
    realWalletAddress,
    realWalletBalance,
} from './helpers/realJettonWallets';

// Regression: ChatPool's outbound JettonTransfers must be accepted by
// production jetton wallets, which (unlike TestJettonWallet) require the
// TEP-74 forward_payload:(Either Cell ^Cell) to carry at least its Either bit.
// Without it every claim, withdrawal and deposit refund bounces.

const CHAT_ID = 1001234567890n;
const JETTON_TRANSFER_OP = 0x0f8a7ea5;
// chat_pool.tact: PoolMinClaimValue + PoolClaimStorageFee, PoolMinWithdrawValue
const MIN_CLAIM_VALUE = toNano('0.08') + toNano('0.002');
const MIN_WITHDRAW_VALUE = toNano('0.08');
// Headroom a minimum-value claim must leave over what the wallet itself
// needs, so a gas price rise or a heavier wallet does not bounce claims.
const CLAIM_GAS_MARGIN = toNano('0.02');

describe.each(REAL_JETTON_WALLETS)('ChatPool with the $name', (realWallet) => {
    let blockchain: Blockchain;
    let master: SandboxContract<TreasuryContract>; // stands in for the DistributorMaster address
    let admin: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let jettonMaster: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let pool: SandboxContract<ChatPool>;
    let poolWallet: Address;
    let adminWallet: Address;
    let userWallet: Address;

    const farFuture = BigInt(Math.floor(Date.now() / 1000) + 3600);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        master = await blockchain.treasury('master');
        admin = await blockchain.treasury('admin');
        user = await blockchain.treasury('user');
        jettonMaster = await blockchain.treasury('jetton-master');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));

        pool = blockchain.openContract(
            await ChatPool.fromInit(master.address, CHAT_ID, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        await pool.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });

        const voucher = beginCell()
            .store(
                storeAdminInitVoucher({
                    $$type: 'AdminInitVoucher',
                    chatId: CHAT_ID,
                    master: master.address,
                    admin: admin.address,
                    expiry: farFuture,
                }),
            )
            .endCell();
        await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'SetAdmin',
                voucherCell: voucher,
                signature: signatureCell(
                    signVoucher(voucher, backend, TAG.Admin, pool.address, globalIdOf(blockchain)),
                ),
            },
        );
        expect((await pool.getPoolAdmin())!.equals(admin.address)).toBe(true);

        poolWallet = realWalletAddress(realWallet, pool.address, jettonMaster.address);
        adminWallet = realWalletAddress(realWallet, admin.address, jettonMaster.address);
        userWallet = realWalletAddress(realWallet, user.address, jettonMaster.address);

        const mint = await mintToRealWallet({
            wallet: realWallet,
            jettonMaster,
            owner: admin.address,
            amount: toNano('1000'),
        });
        expect(mint.transactions).toHaveTransaction({ to: adminWallet, deploy: true, success: true });
        expect(await realWalletBalance(blockchain, adminWallet)).toEqual(toNano('1000'));
    });

    // The admin transfers jettons from their real wallet to the pool; the
    // pool's wallet forwards the payload verbatim (shape 2: 1 bit + ref).
    async function deposit(amount: bigint, signer: KeyPair = backend) {
        const voucher = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster: jettonMaster.address,
                    expectedJettonWallet: poolWallet,
                    expiry: farFuture,
                }),
            )
            .endCell();
        const signature = signVoucher(voucher, signer, TAG.Deposit, pool.address, globalIdOf(blockchain));
        const body = beginCell()
            .storeUint(JETTON_TRANSFER_OP, 32)
            .storeUint(0, 64)
            .storeCoins(amount)
            .storeAddress(pool.address)
            .storeAddress(admin.address)
            .storeMaybeRef(null)
            .storeCoins(toNano('0.15'))
            .storeUint(1, 1)
            .storeRef(beginCell().storeRef(voucher).storeBuffer(signature).endCell())
            .endCell();
        const res = await admin.send({ to: adminWallet, value: toNano('0.3'), body });
        expect(res.transactions).toHaveTransaction({ from: adminWallet, to: poolWallet, success: true });
        expect(res.transactions).toHaveTransaction({ from: poolWallet, to: pool.address, success: true });
        return res;
    }

    function claim(amount: bigint, nonce: bigint) {
        const voucher = beginCell()
            .store(
                storeClaimVoucher({
                    $$type: 'ClaimVoucher',
                    chatId: CHAT_ID,
                    recipient: user.address,
                    jettonMaster: jettonMaster.address,
                    amount,
                    nonce,
                    expiry: farFuture,
                }),
            )
            .endCell();
        return {
            $$type: 'Claim' as const,
            voucherCell: voucher,
            signature: signatureCell(signVoucher(voucher, backend, TAG.Claim, pool.address, globalIdOf(blockchain))),
        };
    }

    // The pool's JettonTransfer is accepted by its real wallet (reports the
    // wallet's exit code on failure) and the jettons reach `toWallet`.
    function expectDelivered(res: SendMessageResult, toWallet: Address) {
        const tx = res.transactions
            .map(flattenTransaction)
            .find((t) => t.from?.equals(pool.address) && t.to?.equals(poolWallet));
        expect(tx).toBeDefined();
        expect({ success: tx!.success, exitCode: tx!.exitCode }).toEqual({ success: true, exitCode: 0 });
        expect(res.transactions).toHaveTransaction({ from: poolWallet, to: toWallet, success: true });
        expect(res.transactions).not.toHaveTransaction({ from: poolWallet, to: pool.address, inMessageBounced: true });
    }

    it('credits a deposit made through the real wallet', async () => {
        await deposit(toNano('100'));

        expect(await pool.getBalanceOf(jettonMaster.address)).toEqual(toNano('100'));
        expect((await pool.getJettonWallet(jettonMaster.address))!.equals(poolWallet)).toBe(true);
        expect(await realWalletBalance(blockchain, poolWallet)).toEqual(toNano('100'));
        expect(await realWalletBalance(blockchain, adminWallet)).toEqual(toNano('900'));
    });

    it("delivers a claim to the recipient's real wallet", async () => {
        await deposit(toNano('100'));

        const res = await pool.send(user.getSender(), { value: toNano('0.15') }, claim(toNano('10'), 1n));

        expectDelivered(res, userWallet);
        expect(await realWalletBalance(blockchain, userWallet)).toEqual(toNano('10'));
        expect(await realWalletBalance(blockchain, poolWallet)).toEqual(toNano('90'));
        expect(await pool.getBalanceOf(jettonMaster.address)).toEqual(toNano('90'));
        expect(await pool.getIsNonceUsed(1n)).toBe(true);
    });

    it('delivers a claim sent with the minimum attached value', async () => {
        await deposit(toNano('100'));

        const res = await pool.send(user.getSender(), { value: MIN_CLAIM_VALUE }, claim(toNano('10'), 1n));

        expectDelivered(res, userWallet);
        expect(await realWalletBalance(blockchain, userWallet)).toEqual(toNano('10'));
        expect(await pool.getBalanceOf(jettonMaster.address)).toEqual(toNano('90'));
        expect(await pool.getIsNonceUsed(1n)).toBe(true);
    });

    // The least TON a JettonTransfer to this wallet must carry so that it
    // reaches a fresh recipient wallet (the worst case: it deploys it).
    async function walletTransferFloor(): Promise<bigint> {
        const sender = await blockchain.treasury('floor-probe');
        await mintToRealWallet({ wallet: realWallet, jettonMaster, owner: sender.address, amount: toNano('10') });
        const senderWallet = realWalletAddress(realWallet, sender.address, jettonMaster.address);
        const snapshot = blockchain.snapshot();
        const delivers = async (value: bigint) => {
            await blockchain.loadFrom(snapshot);
            const to = await blockchain.treasury('floor-recipient');
            const body = beginCell()
                .storeUint(JETTON_TRANSFER_OP, 32)
                .storeUint(0, 64)
                .storeCoins(1n)
                .storeAddress(to.address)
                .storeAddress(sender.address)
                .storeMaybeRef(null)
                .storeCoins(0)
                .storeUint(0, 1)
                .endCell();
            const res = await sender.send({ to: senderWallet, value, body });
            const target = realWalletAddress(realWallet, to.address, jettonMaster.address);
            return res.transactions.some(
                (t) => flattenTransaction(t).to?.equals(target) && flattenTransaction(t).success,
            );
        };
        let lo = 0n;
        let hi = toNano('0.2');
        expect(await delivers(hi)).toBe(true);
        while (hi - lo > toNano('0.0005')) {
            const mid = (lo + hi) / 2n;
            if (await delivers(mid)) hi = mid;
            else lo = mid;
        }
        await blockchain.loadFrom(snapshot);
        return hi;
    }

    it('keeps a comfortable gas margin at the minimum claim value', async () => {
        await deposit(toNano('100'));
        const floor = await walletTransferFloor();

        // below the minimum the pool refuses the claim outright
        const under = await pool.send(user.getSender(), { value: MIN_CLAIM_VALUE - 1n }, claim(toNano('10'), 1n));
        expect(under.transactions).toHaveTransaction({ to: pool.address, success: false });

        const res = await pool.send(user.getSender(), { value: MIN_CLAIM_VALUE }, claim(toNano('10'), 1n));
        expectDelivered(res, userWallet);
        const forwarded = res.transactions
            .map(flattenTransaction)
            .find((t) => t.from?.equals(pool.address) && t.to?.equals(poolWallet))!.value!;
        console.log(
            `${realWallet.name}: a minimum-value claim forwards ${Number(forwarded) / 1e9} TON, the wallet needs ${Number(floor) / 1e9} TON`,
        );
        expect(forwarded - floor).toBeGreaterThanOrEqual(CLAIM_GAS_MARGIN);
    });

    it('delivers a WithdrawRemainder to the admin', async () => {
        await deposit(toNano('100'));

        const res = await pool.send(
            admin.getSender(),
            { value: MIN_WITHDRAW_VALUE },
            {
                $$type: 'WithdrawRemainder',
                jettonMaster: jettonMaster.address,
                amount: toNano('100'),
                to: admin.address,
            },
        );

        expectDelivered(res, adminWallet);
        expect(await realWalletBalance(blockchain, adminWallet)).toEqual(toNano('1000'));
        expect(await realWalletBalance(blockchain, poolWallet)).toEqual(0n);
        expect(await pool.getBalanceOf(jettonMaster.address)).toEqual(0n);
    });

    it("refunds a rejected deposit to the depositor's real wallet", async () => {
        const res = await deposit(toNano('100'), keyPairFromSeed(Buffer.alloc(32, 9))); // bad signature

        expectDelivered(res, adminWallet);
        expect(await realWalletBalance(blockchain, adminWallet)).toEqual(toNano('1000'));
        expect(await realWalletBalance(blockchain, poolWallet)).toEqual(0n);
        expect(await pool.getBalanceOf(jettonMaster.address)).toEqual(0n);
    });
});
