// Regressions for the ChatPool findings of docs/security/2026-10-06-contracts-review.md
// (CP-1..CP-14, X-3). Each test asserts the CORRECT behaviour; most started
// out as a PoC in tests/poc/ChatPool.poc.spec.ts that asserted the bug.
import { internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import {
    BACKEND,
    bouncedTransferBody,
    CHAT_ID,
    claim,
    claimMsg,
    DAY,
    depositPayload,
    errorCode,
    expectTx,
    jettonTransfersFrom,
    notify,
    now,
    OP,
    OTHER_KEY,
    PoolEnv,
    proposeAdminMsg,
    provideWalletQuery,
    QUERY,
    registerJetton,
    rentPerYear,
    setAdmin,
    setupPool,
    storageUsed,
    takeWalletAddressBody,
    tonBalance,
} from './helpers/pool';

describe('ChatPool security regressions', () => {
    let env: PoolEnv;
    let jm: SandboxContract<TreasuryContract>; // plays the jetton master (answers TEP-89 by hand)
    let wallet: SandboxContract<TreasuryContract>; // plays the pool's jetton wallet

    beforeEach(async () => {
        env = await setupPool();
        jm = await env.bc.treasury('jetton-master');
        wallet = await env.bc.treasury('pool-jetton-wallet');
    });

    const code = (message: string) => errorCode(env.pool, message);

    async function register() {
        const { reply } = await registerJetton(env, jm, wallet.address);
        expectTx(reply!, { from: jm.address, to: env.pool.address, success: true });
    }

    function deposit(amount: bigint, from: Address = env.admin.address, value = toNano('0.15')) {
        return notify(env, wallet, { amount, sender: from, forwardPayload: depositPayload(env, jm.address), value });
    }

    async function funded(amount: bigint) {
        await register();
        const r = await deposit(amount);
        expectTx(r, { from: wallet.address, to: env.pool.address, success: true });
        expect(await env.pool.getBalanceOf(jm.address)).toEqual(amount);
    }

    // what the pool's wallet sends back when it rejects a JettonTransfer
    function bounce(queryId: bigint, amount: bigint, from: Address = wallet.address) {
        return env.bc.sendMessage(
            internal({
                from,
                to: env.pool.address,
                value: toNano('0.05'),
                body: bouncedTransferBody(queryId, amount, env.user.address),
                bounced: true,
            }),
        );
    }

    // the refund the pool sends to the notifying wallet for `depositor`
    function expectRefund(res: Parameters<typeof jettonTransfersFrom>[0], amount: bigint, depositor: Address) {
        const out = jettonTransfersFrom(res, env.pool.address);
        expect(out).toHaveLength(1);
        expect(out[0].queryId).toEqual(QUERY.Refund);
        expect(out[0].amount).toEqual(amount);
        expect(out[0].destination.equals(depositor)).toBe(true);
    }

    // ---- CP-9: deposits are credited only from the current admin ----

    describe('CP-9 deposits', () => {
        it('credits a deposit only when its original sender is the current admin', async () => {
            await register();
            const stranger = await deposit(toNano('1000'), env.user.address);
            expectRefund(stranger, toNano('1000'), env.user.address);
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);

            const own = await deposit(toNano('1000'));
            expect(jettonTransfersFrom(own, env.pool.address)).toHaveLength(0);
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
        });

        it("refunds the creator's deposit into a pool whose admin slot someone else holds", async () => {
            // PoC: an attacker took the empty slot with a leaked or replayed
            // init voucher; the creator then tops the pool up.
            const fresh = await setupPool({ withAdmin: false });
            const attacker = await fresh.bc.treasury('attacker');
            const creator = await fresh.bc.treasury('creator');
            const freshJm = await fresh.bc.treasury('jetton-master');
            const freshWallet = await fresh.bc.treasury('pool-jetton-wallet');
            expectTx(await setAdmin(fresh, attacker, attacker.address), { to: fresh.pool.address, success: true });
            await registerJetton(fresh, freshJm, freshWallet.address, attacker);

            const res = await notify(fresh, freshWallet, {
                amount: toNano('1000'),
                sender: creator.address,
                forwardPayload: depositPayload(fresh, freshJm.address),
            });
            const out = jettonTransfersFrom(res, fresh.pool.address);
            expect(out).toHaveLength(1);
            expect(out[0].queryId).toEqual(QUERY.Refund);
            expect(out[0].destination.equals(creator.address)).toBe(true);
            expect(await fresh.pool.getBalanceOf(freshJm.address)).toEqual(0n);

            // nothing in the ledger for the slot holder to withdraw
            const w = await fresh.pool.send(
                attacker.getSender(),
                { value: toNano('0.1') },
                {
                    $$type: 'WithdrawRemainder',
                    jettonMaster: freshJm.address,
                    amount: toNano('1000'),
                    to: attacker.address,
                },
            );
            expectTx(w, { from: attacker.address, to: fresh.pool.address, success: false });
        });

        it("refunds the previous admin's deposits after a rotation", async () => {
            await register();
            const next = await env.bc.treasury('next-admin');
            expectTx(await setAdmin(env, env.admin, next.address), { to: env.pool.address, success: true });
            const res = await deposit(toNano('5'));
            expectRefund(res, toNano('5'), env.admin.address);
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);
        });
    });

    // ---- CP-1 / CP-2: TEP-89 wallet registration ----

    describe('CP-1 / CP-2 jetton registration', () => {
        it('never lets a deposit notification register a wallet (leaked key, forged notifier)', async () => {
            const evil = await env.bc.treasury('evil-wallet');
            const res = await notify(env, evil, {
                amount: toNano('1000000'),
                sender: env.admin.address,
                forwardPayload: depositPayload(env, jm.address /* signed with the leaked key */),
            });
            // refunded to the notifier itself, which can only move its own jettons
            const out = jettonTransfersFrom(res, env.pool.address);
            expect(out).toHaveLength(1);
            expect(out[0].to.equals(evil.address)).toBe(true);
            expect(await env.pool.getJettonWallet(jm.address)).toBeNull();
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);

            // the real wallet can still be registered and used afterwards
            await register();
            expect((await env.pool.getJettonWallet(jm.address))!.equals(wallet.address)).toBe(true);
            await deposit(toNano('500'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('500'));
        });

        it("registers the wallet only from the master's reply to a pending request", async () => {
            const stranger = await env.bc.treasury('stranger');
            const notAdmin = await env.pool.send(
                env.user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: jm.address },
            );
            expectTx(notAdmin, { to: env.pool.address, success: false, exitCode: code('only chat admin') });

            const req = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: jm.address },
            );
            const q = provideWalletQuery(req, env.pool.address, jm.address)!;
            expect(q).not.toBeNull();
            expect(q.owner.equals(env.pool.address)).toBe(true);
            expect(await env.pool.getPendingJettonRegistration(jm.address)).toEqual(q.queryId);

            // a reply from anyone but that master is refused
            const forged = await stranger.send({
                to: env.pool.address,
                value: toNano('0.05'),
                body: takeWalletAddressBody(q.queryId, stranger.address),
            });
            expectTx(forged, {
                to: env.pool.address,
                success: false,
                exitCode: code('unexpected wallet address reply'),
            });
            // so is the master's reply to another query
            const stale = await jm.send({
                to: env.pool.address,
                value: toNano('0.05'),
                body: takeWalletAddressBody(q.queryId + 1n, wallet.address),
            });
            expectTx(stale, {
                to: env.pool.address,
                success: false,
                exitCode: code('unexpected wallet address reply'),
            });
            expect(await env.pool.getJettonWallet(jm.address)).toBeNull();

            const ok = await jm.send({
                to: env.pool.address,
                value: toNano('0.05'),
                body: takeWalletAddressBody(q.queryId, wallet.address),
            });
            expectTx(ok, { to: env.pool.address, success: true });
            // the TON left over goes back to the admin who paid for it
            expectTx(ok, { from: env.pool.address, to: env.admin.address, op: OP.Excesses });
            expect((await env.pool.getJettonWallet(jm.address))!.equals(wallet.address)).toBe(true);
            expect(await env.pool.getPendingJettonRegistration(jm.address)).toEqual(0n);

            // the answered query cannot be answered again
            const replay = await jm.send({
                to: env.pool.address,
                value: toNano('0.05'),
                body: takeWalletAddressBody(q.queryId, stranger.address),
            });
            expectTx(replay, { to: env.pool.address, success: false });
            expect((await env.pool.getJettonWallet(jm.address))!.equals(wallet.address)).toBe(true);
        });

        it('never re-points a registered jetton', async () => {
            await register();
            const again = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: jm.address },
            );
            expectTx(again, { to: env.pool.address, success: false, exitCode: code('jetton already registered') });
        });

        it('registers nothing when the master reports no wallet', async () => {
            const req = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: jm.address },
            );
            const q = provideWalletQuery(req, env.pool.address, jm.address)!;
            const res = await jm.send({
                to: env.pool.address,
                value: toNano('0.05'),
                body: takeWalletAddressBody(q.queryId, null),
            });
            expectTx(res, { to: env.pool.address, success: false, exitCode: code('jetton master reported no wallet') });
            expect(await env.pool.getJettonWallet(jm.address)).toBeNull();
        });

        it('clears the request when the master does not speak TEP-89 (the request bounces)', async () => {
            // a DistributorMaster rejects provide_wallet_address like any non-TEP-89 contract
            const notAJetton = env.master.address;
            const req = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: notAJetton },
            );
            expectTx(req, { from: env.pool.address, to: notAJetton, success: false });
            expectTx(req, { from: notAJetton, to: env.pool.address, inMessageBounced: true, success: true });
            expect(await env.pool.getPendingJettonRegistration(notAJetton)).toEqual(0n);
            expect(await env.pool.getJettonWallet(notAJetton)).toBeNull();
        });

        it('CP-2: a wallet registered for one jetton cannot be registered for another', async () => {
            await funded(toNano('1000'));
            const fakeMaster = await env.bc.treasury('fake-master');
            const { reply } = await registerJetton(env, fakeMaster, wallet.address);
            expectTx(reply!, {
                to: env.pool.address,
                success: false,
                exitCode: code('wallet already registered for another jetton'),
            });
            expect(await env.pool.getJettonWallet(fakeMaster.address)).toBeNull();

            // a bounce from the real wallet restores the real ledger
            await claim(env, { jettonMaster: jm.address, amount: toNano('50'), nonce: 5n });
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('950'));
            await bounce(5n, toNano('50'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            expect(await env.pool.getBalanceOf(fakeMaster.address)).toEqual(0n);
        });

        it('registers and credits through a real TEP-89 jetton master and wallets', async () => {
            const content = beginCell().storeUint(0, 8).storeStringTail('t').endCell();
            const minter = env.bc.openContract(await TestJettonMinter.fromInit(env.admin.address, content));
            await minter.send(env.admin.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
            await minter.send(
                env.admin.getSender(),
                { value: toNano('0.2') },
                { $$type: 'Mint', amount: toNano('1000'), recipient: env.admin.address },
            );
            const res = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'RegisterJetton', jettonMaster: minter.address },
            );
            expectTx(res, { from: minter.address, to: env.pool.address, success: true });
            const poolWallet = await minter.getGetWalletAddress(env.pool.address);
            expect((await env.pool.getJettonWallet(minter.address))!.equals(poolWallet)).toBe(true);

            const adminWallet = env.bc.openContract(
                TestJettonWallet.fromAddress(await minter.getGetWalletAddress(env.admin.address)),
            );
            await adminWallet.send(
                env.admin.getSender(),
                { value: toNano('0.3') },
                {
                    $$type: 'JettonTransfer',
                    queryId: 0n,
                    amount: toNano('100'),
                    destination: env.pool.address,
                    responseDestination: env.admin.address,
                    customPayload: null,
                    forwardTonAmount: toNano('0.15'),
                    forwardPayload: depositPayload(env, minter.address),
                },
            );
            expect(await env.pool.getBalanceOf(minter.address)).toEqual(toNano('100'));
        });
    });

    // ---- CP-11: refunds and strays ----

    describe('CP-11 refunds and stray jettons', () => {
        it('refunds jettons from an unregistered wallet without any voucher', async () => {
            const res = await notify(env, wallet, {
                amount: toNano('7'),
                sender: env.user.address,
                forwardPayload: beginCell().endCell(),
            });
            expectRefund(res, toNano('7'), env.user.address);
        });

        it('keeps an underfunded rejected deposit as untracked, and the admin sweeps it after registering', async () => {
            // too little TON for a refund that would reach the depositor: the
            // pool keeps the jettons instead of sending a transfer that bounces
            const res = await notify(env, wallet, {
                amount: toNano('7'),
                sender: env.user.address,
                forwardPayload: beginCell().endCell(),
                value: toNano('0.01'),
            });
            expectTx(res, { from: wallet.address, to: env.pool.address, success: true });
            expect(jettonTransfersFrom(res, env.pool.address)).toHaveLength(0);

            await register(); // purely to sweep
            const sweep = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SweepUntracked', jettonMaster: jm.address, amount: toNano('7'), to: env.admin.address },
            );
            const out = jettonTransfersFrom(sweep, env.pool.address);
            expect(out).toHaveLength(1);
            expect(out[0].queryId).toEqual(QUERY.SweepUntracked);
            expect(out[0].amount).toEqual(toNano('7'));
            expect(out[0].destination.equals(env.admin.address)).toBe(true);
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);
        });

        it('lets only the admin sweep', async () => {
            await register();
            const res = await env.pool.send(
                env.user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SweepUntracked', jettonMaster: jm.address, amount: 1n, to: env.user.address },
            );
            expectTx(res, { to: env.pool.address, success: false, exitCode: code('only chat admin') });
        });
    });

    // ---- CP-5: tracked withdrawals vs untracked sweeps ----

    describe('CP-5 withdrawals', () => {
        it('WithdrawRemainder moves at most the ledger, and its bounce restores it', async () => {
            await funded(toNano('1000'));
            const over = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                {
                    $$type: 'WithdrawRemainder',
                    jettonMaster: jm.address,
                    amount: toNano('1000') + 1n,
                    to: env.admin.address,
                },
            );
            expectTx(over, {
                to: env.pool.address,
                success: false,
                exitCode: code('amount exceeds the tracked balance'),
            });
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));

            const ok = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'WithdrawRemainder', jettonMaster: jm.address, amount: toNano('400'), to: env.admin.address },
            );
            expect(jettonTransfersFrom(ok, env.pool.address)[0].queryId).toEqual(QUERY.WithdrawTracked);
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('600'));
            await bounce(QUERY.WithdrawTracked, toNano('400'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
        });

        it('SweepUntracked never touches the ledger, not even when it bounces', async () => {
            // PoC: an oversized withdrawal that bounced zeroed the ledger for good
            await funded(toNano('1000'));
            await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SweepUntracked', jettonMaster: jm.address, amount: toNano('5000'), to: env.admin.address },
            );
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            await bounce(QUERY.SweepUntracked, toNano('5000'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            const c = await claim(env, { jettonMaster: jm.address, amount: toNano('1'), nonce: 1n });
            expectTx(c, { from: env.pool.address, to: wallet.address, success: true });
        });
    });

    // ---- CP-3 / CP-4 / CP-6: rolling 24h claim budget ----

    describe('CP-3 / CP-4 / CP-6 claim budget', () => {
        it('CP-3: grants no fresh budget at UTC midnight', async () => {
            await funded(toNano('1000'));
            const midnight = (Math.floor(now(env) / DAY) + 1) * DAY;
            env.bc.now = midnight - 1;
            const a = await claim(env, { jettonMaster: jm.address, amount: toNano('100'), nonce: 1n });
            expectTx(a, { from: env.pool.address, to: wallet.address, success: true });
            env.bc.now = midnight;
            const b = await claim(env, { jettonMaster: jm.address, amount: toNano('90'), nonce: 2n });
            expectTx(b, { to: env.pool.address, success: false, exitCode: code('daily claim limit reached') });
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('900'));
        });

        it('CP-3: frees the budget linearly over the following 24 hours', async () => {
            await funded(toNano('1000'));
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('100'));
            const t = now(env);
            await claim(env, { jettonMaster: jm.address, amount: toNano('100'), nonce: 1n });
            expect(await env.pool.getClaimWindowSpent(jm.address)).toEqual(toNano('100'));
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(0n);

            env.bc.now = t + DAY / 2;
            // half of the charge has decayed; the budget counts it back in
            expect(await env.pool.getClaimWindowSpent(jm.address)).toEqual(toNano('50'));
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('45')); // 10% of (900 + 50) - 50

            env.bc.now = t + DAY - 1;
            expect(await env.pool.getClaimWindowSpent(jm.address)).toBeGreaterThan(0n);
            env.bc.now = t + DAY;
            expect(await env.pool.getClaimWindowSpent(jm.address)).toEqual(0n);
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('90'));
            const c = await claim(env, { jettonMaster: jm.address, amount: toNano('90'), nonce: 2n });
            expectTx(c, { from: env.pool.address, to: wallet.address, success: true });
        });

        it('CP-3: drains at most one budget plus its decay over any stretch of time', async () => {
            await funded(toNano('1000'));
            // a leaked key claims everything it can, every hour, for two days
            const t = now(env);
            let nonce = 1n;
            const claimed: { at: number; amount: bigint }[] = [];
            for (let h = 0; h <= 48; h++) {
                env.bc.now = t + h * 3600;
                const amount = await env.pool.getClaimableToday(jm.address);
                if (amount === 0n) continue;
                const r = await claim(env, { jettonMaster: jm.address, amount, nonce: nonce++ });
                expectTx(r, { from: env.pool.address, to: wallet.address, success: true });
                claimed.push({ at: env.bc.now!, amount });
            }
            // over any 24h: at most the budget at its start plus the budget again
            // (the window's decay), never the 2x-in-two-seconds of a calendar day
            for (const start of claimed) {
                const inWindow = claimed
                    .filter((c) => c.at >= start.at && c.at < start.at + DAY)
                    .reduce((s, c) => s + c.amount, 0n);
                expect(inWindow).toBeLessThanOrEqual(toNano('200'));
            }
            const firstHour = claimed.filter((c) => c.at < t + 3600).reduce((s, c) => s + c.amount, 0n);
            expect(firstHour).toBeLessThanOrEqual(toNano('100'));
        });

        it('CP-6: a tiny first claim does not pin the budget, and a deposit raises it', async () => {
            await funded(toNano('10'));
            await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: 1n });
            await deposit(toNano('10000'));
            expect(await env.pool.getBalanceOf(jm.address)).toBeGreaterThan(toNano('10000'));
            expect(await env.pool.getClaimableToday(jm.address)).toBeGreaterThan(toNano('1000'));
        });

        it('CP-4: a bounce gives back only what its claim still counts in the window', async () => {
            await funded(toNano('1000'));
            const t = now(env);
            await claim(env, { jettonMaster: jm.address, amount: toNano('100'), nonce: 1n });
            env.bc.now = t + DAY + 10; // the claim has left the window
            await claim(env, { jettonMaster: jm.address, amount: toNano('90'), nonce: 2n });
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(0n);
            // the day-old transfer bounces only now: the ledger gets its 100
            // back, the window keeps today's 90
            await bounce(1n, toNano('100'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('910'));
            expect(await env.pool.getClaimWindowSpent(jm.address)).toEqual(toNano('90'));
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('10')); // 10% of (910 + 90) - 90
        });

        it('CP-4: an immediate bounce gives the whole charge back', async () => {
            await funded(toNano('1000'));
            await claim(env, { jettonMaster: jm.address, amount: toNano('60'), nonce: 1n });
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('40'));
            await bounce(1n, toNano('60'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('100'));
        });

        it('lets an explicit limit replace the default share, effective immediately', async () => {
            await funded(toNano('1000'));
            await claim(env, { jettonMaster: jm.address, amount: toNano('90'), nonce: 1n });
            await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetClaimLimit', jettonMaster: jm.address, dailyLimit: toNano('50') },
            );
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(0n);
            await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetClaimLimit', jettonMaster: jm.address, dailyLimit: toNano('500') },
            );
            expect(await env.pool.getClaimableToday(jm.address)).toEqual(toNano('410'));
        });
    });

    // ---- CP-7 / X-3 / CP-10: nonces ----

    describe('CP-7 / X-3 / CP-10 nonces', () => {
        it('rejects claim vouchers that expire more than a day ahead', async () => {
            await funded(toNano('1000'));
            const far = await claim(env, {
                jettonMaster: jm.address,
                amount: toNano('1'),
                nonce: 1n,
                expiry: BigInt(now(env) + DAY + 1),
            });
            expectTx(far, { to: env.pool.address, success: false, exitCode: code('voucher expiry too far ahead') });
            expect(await env.pool.getNonceState(1n)).toEqual(0n);
            const ok = await claim(env, {
                jettonMaster: jm.address,
                amount: toNano('1'),
                nonce: 1n,
                expiry: BigInt(now(env) + DAY),
            });
            expectTx(ok, { from: env.pool.address, to: wallet.address, success: true });
        });

        it('CP-10: a bounced claim burns its nonce for good', async () => {
            await funded(toNano('1000'));
            const body = claimMsg(env, { jettonMaster: jm.address, amount: toNano('40'), nonce: 7n });
            await env.pool.send(env.user.getSender(), { value: toNano('0.15') }, body);
            expect(await env.pool.getNonceState(7n)).toEqual(1n);
            await bounce(7n, toNano('40'));
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            // monotonic: still used, and marked bounced for the backend to reissue
            expect(await env.pool.getIsNonceUsed(7n)).toBe(true);
            expect(await env.pool.getNonceState(7n)).toEqual(2n);
            const replay = await env.pool.send(env.user.getSender(), { value: toNano('0.15') }, body);
            expectTx(replay, { to: env.pool.address, success: false, exitCode: code('voucher already used') });
            expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('1000'));
            // a second bounce-shaped message changes nothing more
            await bounce(7n, toNano('40'));
            expect(await env.pool.getNonceState(7n)).toEqual(2n);
        });

        it('X-3: prunes old nonce entries, raises the floor and keeps the state bounded', async () => {
            await funded(toNano('1000000'));
            await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetClaimLimit', jettonMaster: jm.address, dailyLimit: toNano('1000000') },
            );
            const t = now(env);
            const cells: number[] = [];
            // a claim every 2 hours for 12 days
            for (let i = 1; i <= 144; i++) {
                env.bc.now = t + i * 7200;
                const r = await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: BigInt(i) });
                expectTx(r, { from: env.pool.address, to: wallet.address, success: true });
                if (i % 12 === 0) cells.push((await storageUsed(env.bc, env.pool.address)).cells);
            }
            // entries live a bounded time: the state stops growing once pruning keeps up
            const plateau = cells.slice(5);
            expect(Math.max(...plateau) - Math.min(...plateau)).toBeLessThanOrEqual(6);

            const floor = await env.pool.getNonceFloor();
            expect(floor).toBeGreaterThan(90n);
            // below the floor: still reported used (monotonic), state "retired"
            expect(await env.pool.getIsNonceUsed(1n)).toBe(true);
            expect(await env.pool.getNonceState(1n)).toEqual(3n);
            expect(await env.pool.getNonceState(144n)).toEqual(1n);
            expect(await env.pool.getNonceState(145n)).toEqual(0n);
            const old = await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: 1n });
            expectTx(old, { to: env.pool.address, success: false, exitCode: code('nonce retired') });
        });

        it('rejects a nonce far above the floor, so a leaked key cannot retire every nonce', async () => {
            await funded(toNano('1000'));
            const floor = await env.pool.getNonceFloor();
            const far = await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: floor + (1n << 32n) });
            expectTx(far, { to: env.pool.address, success: false, exitCode: code('nonce too far ahead') });
        });

        it('CP-7: the per-claim storage fee covers its nonce entry for years', async () => {
            await funded(toNano('1000000'));
            await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetClaimLimit', jettonMaster: jm.address, dailyLimit: toNano('1000000') },
            );
            await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: 1n });
            const s0 = await storageUsed(env.bc, env.pool.address);
            const r0 = await rentPerYear(env.bc, env.pool.address);
            const N = 100;
            for (let n = 2; n < 2 + N; n++) {
                await claim(env, { jettonMaster: jm.address, amount: 1n, nonce: BigInt(n) });
            }
            const s1 = await storageUsed(env.bc, env.pool.address);
            const perEntry = Number((await rentPerYear(env.bc, env.pool.address)) - r0) / N;
            const fee = toNano('0.002'); // PoolClaimStorageFee
            const years = Number(fee) / perEntry;
            console.log(
                `CP-7: nonce entry ${((s1.cells - s0.cells) / N).toFixed(2)} cells, ${((s1.bits - s0.bits) / N).toFixed(0)} bits, ` +
                    `${(perEntry / 1e9).toFixed(7)} TON/yr; the fee covers ${years.toFixed(0)} years`,
            );
            // an entry lives about 3 days while the pool is in use; if the pool
            // falls idle its last entries stay, and their own fees pay for them
            expect(years).toBeGreaterThanOrEqual(20);
        });

        it('keeps a TON reserve that pays the pool state for at least 10 years', async () => {
            await funded(toNano('1000'));
            const perYear = await rentPerYear(env.bc, env.pool.address);
            const reserve = toNano('0.1'); // PoolMinTonReserve
            const years = Number(reserve) / Number(perYear);
            console.log(
                `pool rent ${(Number(perYear) / 1e9).toFixed(5)} TON/yr; the reserve covers ${years.toFixed(1)} years`,
            );
            expect(years).toBeGreaterThanOrEqual(10);
        });
    });

    // ---- CP-12: backend-initiated admin recovery with a 7-day timelock ----

    describe('CP-12 admin recovery', () => {
        let recovered: SandboxContract<TreasuryContract>;
        beforeEach(async () => {
            recovered = await env.bc.treasury('recovered-admin');
        });

        it('hands the admin slot over 7 days after a backend-signed proposal', async () => {
            const seq = await env.pool.getAdminProposalSeq();
            const msg = proposeAdminMsg(env, recovered.address, seq);
            const byOther = await env.pool.send(env.user.getSender(), { value: toNano('0.05') }, msg);
            expectTx(byOther, {
                to: env.pool.address,
                success: false,
                exitCode: code('only the proposed admin may submit'),
            });

            const t = now(env);
            const res = await env.pool.send(recovered.getSender(), { value: toNano('0.05') }, msg);
            expectTx(res, { to: env.pool.address, success: true });
            expect((await env.pool.getPendingAdmin())!.equals(recovered.address)).toBe(true);
            expect(await env.pool.getPendingAdminExecutableAt()).toEqual(BigInt(t + 7 * DAY));
            expect((await env.pool.getPoolAdmin())!.equals(env.admin.address)).toBe(true); // not yet

            env.bc.now = t + 7 * DAY - 1;
            const early = await env.pool.send(
                env.user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ExecuteAdminProposal' },
            );
            expectTx(early, {
                to: env.pool.address,
                success: false,
                exitCode: code('admin proposal is still timelocked'),
            });

            env.bc.now = t + 7 * DAY;
            const done = await env.pool.send(
                env.user.getSender(), // anyone may execute
                { value: toNano('0.05') },
                { $$type: 'ExecuteAdminProposal' },
            );
            expectTx(done, { to: env.pool.address, success: true });
            expect((await env.pool.getPoolAdmin())!.equals(recovered.address)).toBe(true);
            expect(await env.pool.getPendingAdmin()).toBeNull();
            expect(await env.pool.getAdminProposalSeq()).toEqual(seq + 1n);
        });

        it('lets only the current admin cancel, and a cancelled voucher stays dead', async () => {
            const msg = proposeAdminMsg(env, recovered.address, await env.pool.getAdminProposalSeq());
            await env.pool.send(recovered.getSender(), { value: toNano('0.05') }, msg);

            const notAdmin = await env.pool.send(
                env.user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'CancelAdminProposal' },
            );
            expectTx(notAdmin, { to: env.pool.address, success: false, exitCode: code('only chat admin') });
            const cancel = await env.pool.send(
                env.admin.getSender(),
                { value: toNano('0.05') },
                { $$type: 'CancelAdminProposal' },
            );
            expectTx(cancel, { to: env.pool.address, success: true });
            expect(await env.pool.getPendingAdmin()).toBeNull();

            const replay = await env.pool.send(recovered.getSender(), { value: toNano('0.05') }, msg);
            expectTx(replay, { to: env.pool.address, success: false, exitCode: code('stale admin proposal') });
            env.bc.now = now(env) + 8 * DAY;
            const exec = await env.pool.send(
                env.user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ExecuteAdminProposal' },
            );
            expectTx(exec, { to: env.pool.address, success: false, exitCode: code('no admin proposal') });
            expect((await env.pool.getPoolAdmin())!.equals(env.admin.address)).toBe(true);
        });

        it('rejects expired, mis-tagged, competing and adminless proposals', async () => {
            const seq = await env.pool.getAdminProposalSeq();
            const send = (m: ReturnType<typeof proposeAdminMsg>) =>
                env.pool.send(recovered.getSender(), { value: toNano('0.05') }, m);

            const expired = await send(proposeAdminMsg(env, recovered.address, seq, { expiry: BigInt(now(env) - 1) }));
            expectTx(expired, { to: env.pool.address, success: false, exitCode: code('voucher expired') });
            const asAdminVoucher = await send(
                proposeAdminMsg(env, recovered.address, seq, { tag: 0x41444d31n /* ADM1 */ }),
            );
            expectTx(asAdminVoucher, {
                to: env.pool.address,
                success: false,
                exitCode: code('bad admin proposal signature'),
            });

            expectTx(await send(proposeAdminMsg(env, recovered.address, seq)), { to: env.pool.address, success: true });
            const second = await send(proposeAdminMsg(env, recovered.address, seq));
            expectTx(second, {
                to: env.pool.address,
                success: false,
                exitCode: code('an admin proposal is already pending'),
            });

            const adminless = await setupPool({ withAdmin: false });
            const r = await adminless.pool.send(
                adminless.admin.getSender(),
                { value: toNano('0.05') },
                proposeAdminMsg(adminless, adminless.admin.address, 0n),
            );
            expectTx(r, {
                to: adminless.pool.address,
                success: false,
                exitCode: errorCode(adminless.pool, 'pool has no admin yet'),
            });
        });

        it('keeps admin-initiated rotation immediate', async () => {
            expectTx(await setAdmin(env, env.admin, recovered.address), { to: env.pool.address, success: true });
            expect((await env.pool.getPoolAdmin())!.equals(recovered.address)).toBe(true);
        });
    });

    // ---- CP-13: the pool's TON ----

    it('CP-13: the admin withdraws TON above the reserve, never below it', async () => {
        await env.admin.send({ to: env.pool.address, value: toNano('1'), bounce: false });
        const notAdmin = await env.pool.send(
            env.user.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawTon', to: env.user.address, amount: toNano('0.5') },
        );
        expectTx(notAdmin, { to: env.pool.address, success: false, exitCode: code('only chat admin') });

        const dest = await env.bc.treasury('ton-destination');
        const before = await tonBalance(env.bc, dest.address);
        const ok = await env.pool.send(
            env.admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawTon', to: dest.address, amount: toNano('0.9') },
        );
        expectTx(ok, { from: env.pool.address, to: dest.address, success: true });
        expect((await tonBalance(env.bc, dest.address)) - before).toBeGreaterThanOrEqual(toNano('0.9'));
        expect(await tonBalance(env.bc, env.pool.address)).toBeGreaterThanOrEqual(toNano('0.1'));

        const left = await tonBalance(env.bc, env.pool.address);
        const tooMuch = await env.pool.send(
            env.admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'WithdrawTon', to: dest.address, amount: left - toNano('0.1') + toNano('0.001') },
        );
        expectTx(tooMuch, { to: env.pool.address, success: false, exitCode: code('would go below the TON reserve') });
    });

    // ---- CP-14: who gets the claim's excess ----

    it('CP-14: sends the claim excess to the submitter, not the recipient', async () => {
        await funded(toNano('1000'));
        const recipient = await env.bc.treasury('recipient');
        const res = await claim(env, {
            jettonMaster: jm.address,
            amount: toNano('10'),
            nonce: 1n,
            recipient: recipient.address,
        });
        const out = jettonTransfersFrom(res, env.pool.address);
        expect(out).toHaveLength(1);
        expect(out[0].destination.equals(recipient.address)).toBe(true);
        expect(out[0].responseDestination!.equals(env.user.address)).toBe(true);
    });

    // the deposit voucher no longer names a wallet: what it names is checked
    // against the registered wallet the jettons came from
    it('refunds a deposit whose voucher names another jetton than the notifying wallet', async () => {
        await register();
        const other = await env.bc.treasury('other-jetton');
        const res = await notify(env, wallet, {
            amount: toNano('3'),
            sender: env.admin.address,
            forwardPayload: depositPayload(env, other.address),
        });
        expectRefund(res, toNano('3'), env.admin.address);
        expect(await env.pool.getBalanceOf(other.address)).toEqual(0n);
        expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);
    });

    it('refunds a deposit with a bad signature or for another chat', async () => {
        await register();
        for (const forwardPayload of [
            depositPayload(env, jm.address, { kp: OTHER_KEY }),
            depositPayload(env, jm.address, { chatId: CHAT_ID + 1n }),
            depositPayload(env, jm.address, { expiry: BigInt(now(env) - 1) }),
        ]) {
            const res = await notify(env, wallet, { amount: toNano('3'), sender: env.admin.address, forwardPayload });
            expectRefund(res, toNano('3'), env.admin.address);
        }
        expect(await env.pool.getBalanceOf(jm.address)).toEqual(0n);
    });

    it('ignores bounce-shaped messages from anyone but a registered wallet', async () => {
        await funded(toNano('1000'));
        // a bounce-shaped message from anyone but a registered wallet changes nothing
        await claim(env, { jettonMaster: jm.address, amount: toNano('10'), nonce: 1n });
        const stranger = await env.bc.treasury('stranger');
        await bounce(1n, toNano('10'), stranger.address);
        expect(await env.pool.getBalanceOf(jm.address)).toEqual(toNano('990'));
        expect(await env.pool.getNonceState(1n)).toEqual(1n);
        expect(await env.pool.getBackendKey()).toEqual(BigInt('0x' + BACKEND.publicKey.toString('hex')));
    });
});
