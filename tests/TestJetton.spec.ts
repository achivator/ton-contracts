import { Blockchain, createShardAccount, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { flattenTransaction } from '@ton/test-utils';
import '@ton/test-utils';
import { TestJettonMinter, TestJettonWallet } from '../wrappers/TestJetton';
import {
    buildOnchainContent,
    burnBody,
    burnNotificationBody,
    changeOwnerBody,
    getJettonData,
    getWalletData,
    internalTransferBody,
    jettonBalance,
    MAX_COINS,
    mintBody,
    OP,
    parseInternalTransfer,
    parseOnchainContent,
    parseTransferNotification,
    provideWalletAddressBody,
    transferBody,
    WALLET_EXIT,
} from './helpers/jettonMessages';

// Regression tests for the TestJettonMinter / TestJettonWallet findings of
// docs/security/2026-10-06-contracts-review.md (TJM-*, TJW-*). They replace
// the PoCs that asserted the bugs; everything here asserts the TEP-74 /
// TEP-89 behaviour. Messages are built by hand in the standard wire format.

// TestJettonMinter exit codes
const MINTER_EXIT = {
    notOwner: 132, // @stdlib/ownable
    notAWallet: 74, // burn_notification from something that is not our wallet (reference minter)
    provideValueTooLow: 75, // TEP-89 (stablecoin minter)
    mintValueTooLow: 76,
    mintingClosed: 77,
};
const OP_SET_MINTABLE = 0x534d4e54; // "SMNT"
const MIN_MINT_VALUE = toNano('0.05');
// reference-wallet constants the TestJettonWallet reuses
const WALLET_MIN_STORAGE = toNano('0.01');
const WALLET_GAS = toNano('0.015');

// A contract that throws on every message: replaces a wallet to make it fail.
const THROW_42 = beginCell().storeUint(0xf22a, 16).endCell();

describe('TestJettonMinter / TestJettonWallet', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let carol: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TestJettonMinter>;
    const content = buildOnchainContent({ name: 'Test Jetton', symbol: 'TST', decimals: '9' });

    const walletOf = (who: Address) => minter.getGetWalletAddress(who);
    const balanceOf = async (who: Address) => jettonBalance(blockchain, await walletOf(who));
    const supply = async () => (await getJettonData(blockchain, minter.address)).totalSupply;

    function mint(
        recipient: Address,
        amount: bigint,
        opts: { value?: bigint; queryId?: bigint; via?: SandboxContract<TreasuryContract> } = {},
    ) {
        return (opts.via ?? owner).send({
            to: minter.address,
            value: opts.value ?? toNano('0.1'),
            body: mintBody({ queryId: opts.queryId ?? 0n, amount, recipient }),
        });
    }

    async function transfer(
        from: SandboxContract<TreasuryContract>,
        args: Partial<Parameters<typeof transferBody>[0]> & { value?: bigint },
    ) {
        const { value, ...over } = args;
        return from.send({
            to: await walletOf(from.address),
            value: value ?? toNano('0.2'),
            body: transferBody({
                queryId: 9n,
                amount: toNano('100'),
                destination: bob.address,
                responseDestination: from.address,
                forwardTonAmount: toNano('0.05'),
                forwardPayload: beginCell().storeBit(false).endCell(),
                ...over,
            }),
        });
    }

    // Replace `who`'s wallet with a contract that always throws.
    async function breakWalletOf(who: Address) {
        const address = await walletOf(who);
        await blockchain.setShardAccount(
            address,
            createShardAccount({ address, code: THROW_42, data: Cell.EMPTY, balance: toNano('1') }),
        );
    }

    const notificationsTo = (res: SendMessageResult, to: Address) =>
        res.transactions.map(flattenTransaction).filter((t) => t.to?.equals(to) && t.op === OP.transferNotification);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000; // no storage fees between steps
        owner = await blockchain.treasury('owner');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        carol = await blockchain.treasury('carol');
        attacker = await blockchain.treasury('attacker');
        minter = blockchain.openContract(await TestJettonMinter.fromInit(owner.address, content));
        await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    });

    describe('minter', () => {
        it('TJM-1: get_jetton_data returns supply, mintable, admin, TEP-64 content and the wallet code', async () => {
            await mint(alice.address, toNano('1000'));
            const data = await getJettonData(blockchain, minter.address);
            expect(data.totalSupply).toEqual(toNano('1000'));
            expect(data.mintable).toBe(true);
            expect(data.admin!.equals(owner.address)).toBe(true);
            expect(parseOnchainContent(data.content)).toEqual({ name: 'Test Jetton', symbol: 'TST', decimals: '9' });
            const wallet = (await blockchain.getContract(await walletOf(alice.address))).accountState as any;
            expect(data.walletCode.equals(wallet.state.code)).toBe(true);
        });

        it('TJM-1: TEP-89 provide_wallet_address answers take_wallet_address', async () => {
            for (const includeAddress of [false, true]) {
                const res = await alice.send({
                    to: minter.address,
                    value: toNano('0.05'),
                    body: provideWalletAddressBody({ queryId: 5n, owner: bob.address, includeAddress }),
                });
                const reply = res.transactions
                    .map(flattenTransaction)
                    .find((t) => t.from?.equals(minter.address) && t.to?.equals(alice.address))!;
                expect(reply).toBeDefined();
                const s = reply.body!.beginParse();
                expect(s.loadUint(32)).toEqual(OP.takeWalletAddress);
                expect(s.loadUintBig(64)).toEqual(5n);
                expect(s.loadAddress().equals(await walletOf(bob.address))).toBe(true);
                const included = s.loadMaybeRef();
                if (includeAddress) expect(included!.beginParse().loadAddress().equals(bob.address)).toBe(true);
                else expect(included).toBeNull();
            }
        });

        it('TJM-1: TEP-89 answers addr_none for an owner outside the basechain, and rejects an underfunded query', async () => {
            const masterchainOwner = beginCell()
                .storeAddress(Address.parse(`-1:${'11'.repeat(32)}`))
                .asSlice();
            const res = await alice.send({
                to: minter.address,
                value: toNano('0.05'),
                body: provideWalletAddressBody({ owner: masterchainOwner, includeAddress: false }),
            });
            const reply = res.transactions
                .map(flattenTransaction)
                .find((t) => t.from?.equals(minter.address) && t.to?.equals(alice.address))!;
            const s = reply.body!.beginParse();
            expect(s.loadUint(32)).toEqual(OP.takeWalletAddress);
            s.loadUintBig(64);
            expect(s.loadMaybeAddress()).toBeNull(); // addr_none
            const cheap = await alice.send({
                to: minter.address,
                value: toNano('0.005'),
                body: provideWalletAddressBody({ owner: bob.address, includeAddress: false }),
            });
            expect(cheap.transactions).toHaveTransaction({
                from: alice.address,
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.provideValueTooLow,
            });
        });

        it('OK: get_wallet_address is the address the mint actually deploys', async () => {
            const res = await mint(alice.address, 5n);
            const expected = await walletOf(alice.address);
            expect(res.transactions).toHaveTransaction({
                from: minter.address,
                to: expected,
                deploy: true,
                success: true,
            });
            const data = await getWalletData(blockchain, expected);
            expect(data.owner.equals(alice.address)).toBe(true);
            expect(data.master.equals(minter.address)).toBe(true);
        });

        it('TJM-2: a mint below the minimum value is rejected and changes nothing', async () => {
            const res = await mint(alice.address, toNano('1000'), { value: MIN_MINT_VALUE - 1n });
            expect(res.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.mintValueTooLow,
            });
            expect(res.transactions).not.toHaveTransaction({ from: minter.address, to: await walletOf(alice.address) });
            expect(await supply()).toEqual(0n);
        });

        it('TJM-2: the mint is bounceable and a failed credit rolls the supply back', async () => {
            await mint(bob.address, toNano('5'));
            await breakWalletOf(alice.address);
            const res = await mint(alice.address, toNano('1000'));
            const wallet = await walletOf(alice.address);
            expect(res.transactions).toHaveTransaction({ from: minter.address, to: wallet, success: false });
            expect(res.transactions).toHaveTransaction({
                from: wallet,
                to: minter.address,
                inMessageBounced: true,
                success: true,
            });
            expect(await supply()).toEqual(toNano('5'));
        });

        it('TJM-2: supply always equals the sum of wallet balances', async () => {
            await mint(alice.address, toNano('1000'));
            await mint(bob.address, toNano('10'));
            await transfer(alice, { amount: toNano('40') }); // to bob
            await alice.send({
                to: await walletOf(alice.address),
                value: toNano('0.1'),
                body: burnBody({ amount: toNano('60'), responseDestination: alice.address }),
            });
            await breakWalletOf(carol.address);
            await mint(carol.address, toNano('7')); // bounces
            const total = (await balanceOf(alice.address)) + (await balanceOf(bob.address));
            expect(total).toEqual(toNano('1000') + toNano('10') - toNano('60'));
            expect(await supply()).toEqual(total);
        });

        it('TJM-3: the mint excess goes back to the payer, not to the recipient', async () => {
            const res = await mint(alice.address, 1n, { value: toNano('0.5'), queryId: 77n });
            const wallet = await walletOf(alice.address);
            expect(res.transactions).toHaveTransaction({
                from: wallet,
                to: owner.address,
                op: OP.excesses,
                value: (v) => v! > toNano('0.4'),
                body: (b) => b!.beginParse().skip(32).loadUintBig(64) === 77n,
            });
            expect(res.transactions).not.toHaveTransaction({ to: alice.address });
        });

        it('TJM-8: the mint internal_transfer carries from = the minter, the queryId and an Either bit', async () => {
            const res = await mint(alice.address, toNano('3'), { queryId: 77n });
            const tx = res.transactions
                .map(flattenTransaction)
                .find((t) => t.from?.equals(minter.address) && t.op === OP.internalTransfer)!;
            expect(tx.inMessageBounceable).toBe(true);
            const it = parseInternalTransfer(tx.body!);
            expect(it.queryId).toEqual(77n);
            expect(it.amount).toEqual(toNano('3'));
            expect(it.from!.equals(minter.address)).toBe(true);
            expect(it.responseDestination!.equals(owner.address)).toBe(true);
            expect(it.forwardTonAmount).toEqual(0n);
            expect(it.forwardPayload.equals(beginCell().storeBit(false).endCell())).toBe(true);
        });

        it('TJM-4: the owner can hand the minter over; the old owner can no longer mint', async () => {
            const stranger = await attacker.send({
                to: minter.address,
                value: toNano('0.05'),
                body: changeOwnerBody(attacker.address),
            });
            expect(stranger.transactions).toHaveTransaction({
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.notOwner,
            });

            const res = await owner.send({
                to: minter.address,
                value: toNano('0.05'),
                body: changeOwnerBody(alice.address),
            });
            expect(res.transactions).toHaveTransaction({ to: minter.address, success: true });
            expect((await getJettonData(blockchain, minter.address)).admin!.equals(alice.address)).toBe(true);

            const old = await mint(owner.address, 1n);
            expect(old.transactions).toHaveTransaction({
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.notOwner,
            });
            await mint(bob.address, 5n, { via: alice });
            expect(await balanceOf(bob.address)).toEqual(5n);
        });

        it('TJM-4: closing minting is reported by get_jetton_data and rejects Mint', async () => {
            const setMintable = (via: SandboxContract<TreasuryContract>, mintable: boolean) =>
                via.send({
                    to: minter.address,
                    value: toNano('0.05'),
                    body: beginCell().storeUint(OP_SET_MINTABLE, 32).storeUint(0, 64).storeBit(mintable).endCell(),
                });
            const stranger = await setMintable(attacker, false);
            expect(stranger.transactions).toHaveTransaction({
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.notOwner,
            });

            await setMintable(owner, false);
            expect((await getJettonData(blockchain, minter.address)).mintable).toBe(false);
            const res = await mint(alice.address, 1n);
            expect(res.transactions).toHaveTransaction({
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.mintingClosed,
            });

            await setMintable(owner, true);
            expect((await getJettonData(blockchain, minter.address)).mintable).toBe(true);
            await mint(alice.address, 1n);
            expect(await balanceOf(alice.address)).toEqual(1n);
        });

        it('burn: the burn_notification lowers the supply and the excess goes to the response destination', async () => {
            await mint(alice.address, toNano('1000'));
            const res = await alice.send({
                to: await walletOf(alice.address),
                value: toNano('0.1'),
                body: burnBody({ queryId: 3n, amount: toNano('300'), responseDestination: carol.address }),
            });
            expect(res.transactions).toHaveTransaction({
                from: await walletOf(alice.address),
                to: minter.address,
                op: OP.burnNotification,
                success: true,
            });
            expect(res.transactions).toHaveTransaction({ from: minter.address, to: carol.address, op: OP.excesses });
            expect(await balanceOf(alice.address)).toEqual(toNano('700'));
            expect(await supply()).toEqual(toNano('700'));
        });

        it('burn: a burn_notification that does not come from our wallet is rejected', async () => {
            await mint(alice.address, toNano('1000'));
            const res = await attacker.send({
                to: minter.address,
                value: toNano('0.1'),
                body: burnNotificationBody({
                    amount: toNano('1000'),
                    sender: alice.address,
                    responseDestination: attacker.address,
                }),
            });
            expect(res.transactions).toHaveTransaction({
                to: minter.address,
                success: false,
                exitCode: MINTER_EXIT.notAWallet,
            });
            expect(await supply()).toEqual(toNano('1000'));
        });

        it('OK: a supply overflow reverts the whole mint', async () => {
            await mint(alice.address, MAX_COINS);
            const res = await mint(attacker.address, 1n);
            expect(res.transactions).toHaveTransaction({ to: minter.address, success: false });
            expect(res.transactions).not.toHaveTransaction({
                from: minter.address,
                to: await walletOf(attacker.address),
            });
            expect(await supply()).toEqual(MAX_COINS);
        });

        it('TJM-2b: an inline forward payload is delivered and nothing vanishes from the supply', async () => {
            await mint(alice.address, 100n);
            const res = await transfer(alice, {
                amount: 40n,
                destination: attacker.address,
                forwardTonAmount: toNano('0.01'),
            });
            expect(res.transactions).toHaveTransaction({ from: await walletOf(alice.address), success: true });
            expect(await balanceOf(alice.address)).toEqual(60n);
            expect(await balanceOf(attacker.address)).toEqual(40n);
            expect(await supply()).toEqual(100n);
        });
    });

    describe('wallet', () => {
        beforeEach(async () => {
            await mint(alice.address, toNano('1000'));
        });

        it('TJW-1: tokens come back when the receiving wallet fails', async () => {
            await mint(bob.address, 1n);
            await breakWalletOf(bob.address);
            const res = await transfer(alice, {});
            const aw = await walletOf(alice.address);
            const bw = await walletOf(bob.address);
            expect(res.transactions).toHaveTransaction({ from: aw, to: bw, success: false, exitCode: 42 });
            expect(res.transactions).toHaveTransaction({ from: bw, to: aw, inMessageBounced: true, success: true });
            expect(await balanceOf(alice.address)).toEqual(toNano('1000'));
        });

        const delivered: [string, Cell][] = [
            ['an inline text comment', beginCell().storeBit(false).storeUint(0, 32).storeStringTail('hi').endCell()],
            [
                'a ref-wrapped 900-bit payload',
                beginCell().storeBit(true).storeRef(beginCell().storeUint(0, 900).endCell()).endCell(),
            ],
            [
                'an inline payload with trailing data and a ref',
                beginCell()
                    .storeBit(false)
                    .storeUint(0xbeef, 16)
                    .storeRef(beginCell().storeUint(0xaa, 8).endCell())
                    .endCell(),
            ],
        ];
        for (const [name, payload] of delivered) {
            it(`TJW-1/TJW-5/TJW-8: ${name} reaches the recipient verbatim`, async () => {
                const res = await transfer(alice, { forwardPayload: payload });
                const notes = notificationsTo(res, bob.address);
                expect(notes).toHaveLength(1);
                const n = parseTransferNotification(notes[0].body!);
                expect(n.queryId).toEqual(9n);
                expect(n.amount).toEqual(toNano('100'));
                expect(n.from!.equals(alice.address)).toBe(true);
                expect(n.forwardPayload.equals(payload)).toBe(true);
                expect(await balanceOf(alice.address)).toEqual(toNano('900'));
                expect(await balanceOf(bob.address)).toEqual(toNano('100'));
            });
        }

        it('TJW-6: a forward_payload without the Either bit is rejected before anything moves', async () => {
            const res = await transfer(alice, { forwardPayload: beginCell().endCell() });
            expect(res.transactions).toHaveTransaction({
                from: alice.address,
                success: false,
                exitCode: WALLET_EXIT.badForwardPayload,
            });
            expect(res.transactions).not.toHaveTransaction({
                from: await walletOf(alice.address),
                to: await walletOf(bob.address),
            });
            expect(await balanceOf(alice.address)).toEqual(toNano('1000'));
        });

        it('TJW-6: an Either-right payload with trailing data is rejected (USDT rule)', async () => {
            const res = await transfer(alice, {
                forwardPayload: beginCell().storeBit(true).storeRef(Cell.EMPTY).storeUint(0xbeef, 16).endCell(),
            });
            expect(res.transactions).toHaveTransaction({
                from: alice.address,
                success: false,
                exitCode: WALLET_EXIT.badForwardPayload,
            });
            expect(await balanceOf(alice.address)).toEqual(toNano('1000'));
        });

        it('TJW-2: forward_ton_amount above the attached value is rejected and no token is lost', async () => {
            const res = await transfer(alice, { forwardTonAmount: toNano('1'), value: toNano('0.05') });
            expect(res.transactions).toHaveTransaction({
                from: alice.address,
                success: false,
                exitCode: WALLET_EXIT.valueTooLow,
            });
            expect(await balanceOf(alice.address)).toEqual(toNano('1000'));
            expect(await balanceOf(bob.address)).toEqual(0n);
        });

        it('TJW-3: nobody can drain the TON a receiving wallet holds', async () => {
            await mint(bob.address, 1n);
            const bw = await walletOf(bob.address);
            await owner.send({ to: bw, value: toNano('2'), bounce: false });
            await mint(attacker.address, 1n);
            const before = await attacker.getBalance();
            const tonBefore = (await blockchain.getContract(bw)).balance;
            const res = await transfer(attacker, { amount: 1n, forwardTonAmount: toNano('1.9'), value: toNano('0.1') });
            expect(res.transactions).toHaveTransaction({
                from: attacker.address,
                success: false,
                exitCode: WALLET_EXIT.valueTooLow,
            });
            expect(res.transactions).not.toHaveTransaction({ from: bw });
            expect((await blockchain.getContract(bw)).balance).toBeGreaterThanOrEqual(tonBefore);
            expect(await attacker.getBalance()).toBeLessThan(before);
        });

        it('TJW-4: get_wallet_data returns balance, owner, master and the wallet code', async () => {
            const aw = await walletOf(alice.address);
            const data = await getWalletData(blockchain, aw);
            expect(data.balance).toEqual(toNano('1000'));
            expect(data.owner.equals(alice.address)).toBe(true);
            expect(data.master.equals(minter.address)).toBe(true);
            const state = (await blockchain.getContract(aw)).accountState as any;
            expect(data.walletCode.equals(state.state.code)).toBe(true);
        });

        it('TJW-8: no excess when response_destination is addr_none', async () => {
            const res = await transfer(alice, { responseDestination: null });
            expect(res.transactions).not.toHaveTransaction({ op: OP.excesses });
            expect(await balanceOf(bob.address)).toEqual(toNano('100'));
        });

        it('TJW-8: the excess goes to response_destination, not to the owner', async () => {
            const res = await transfer(alice, { responseDestination: carol.address });
            const bw = await walletOf(bob.address);
            expect(res.transactions).toHaveTransaction({ from: bw, to: carol.address, op: OP.excesses });
            expect(res.transactions).not.toHaveTransaction({ from: bw, to: bob.address, op: OP.excesses });
            expect(res.transactions).not.toHaveTransaction({ from: bw, to: alice.address });
        });

        it('TJW-9: the transfer_notification is not bounceable', async () => {
            const res = await transfer(alice, {});
            const notes = notificationsTo(res, bob.address);
            expect(notes).toHaveLength(1);
            expect(notes[0].inMessageBounceable).toBe(false);
        });

        // receive_tokens of the reference wallet: excess = value - storage top-up
        // to 0.01 TON - 0.015 TON gas - forward_ton_amount - 1.5 * forward fee
        it('TJW-10: the excess follows the reference wallet formula (storage top-up, then refund)', async () => {
            const bw = await walletOf(bob.address);
            for (const fresh of [true, false]) {
                const tonBefore = (await blockchain.getContract(bw)).balance;
                const res = await transfer(alice, { amount: 1n });
                const tx = res.transactions.find((t) => t.inMessage?.info.dest?.toString() === bw.toString())!;
                const info = tx.inMessage!.info as any;
                const fwdFee = (info.forwardFee * 3n) / 2n;
                const topUp = WALLET_MIN_STORAGE - (tonBefore < WALLET_MIN_STORAGE ? tonBefore : WALLET_MIN_STORAGE);
                expect(topUp).toEqual(fresh ? WALLET_MIN_STORAGE : 0n);
                const expected = info.value.coins - topUp - WALLET_GAS - toNano('0.05') - fwdFee;
                expect(res.transactions).toHaveTransaction({
                    from: bw,
                    to: alice.address,
                    op: OP.excesses,
                    value: expected,
                });
                expect((await blockchain.getContract(bw)).balance).toBeGreaterThanOrEqual(WALLET_MIN_STORAGE);
            }
        });

        it('sanity: an internal_transfer from something that is not a sibling wallet is rejected', async () => {
            const bw = await walletOf(bob.address);
            const res = await attacker.send({
                to: bw,
                value: toNano('0.1'),
                init: (await TestJettonWallet.fromInit(bob.address, minter.address)).init!,
                body: internalTransferBody({ amount: toNano('1000000'), from: bob.address, responseDestination: null }),
            });
            expect(res.transactions).toHaveTransaction({
                to: bw,
                success: false,
                exitCode: WALLET_EXIT.untrustedSender,
            });
        });
    });
});
