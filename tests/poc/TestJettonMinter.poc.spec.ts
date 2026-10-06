import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { TestJettonMinter, TestJettonWallet } from '../../wrappers/TestJetton';
import { ChatPool } from '../../wrappers/ChatPool';
import '@ton/test-utils';

// Security PoCs for TestJettonMinter (contracts/test_jetton.tact:33-77).
describe('TestJettonMinter PoC', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TestJettonMinter>;
    const content = beginCell().storeUint(0, 8).storeStringTail('test').endCell();

    async function balanceOf(addr: Address): Promise<bigint> {
        const w = blockchain.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(addr)));
        const st = await blockchain.getContract(w.address);
        if (st.accountState?.type !== 'active') return 0n;
        return w.getWalletBalance();
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        alice = await blockchain.treasury('alice');
        attacker = await blockchain.treasury('attacker');
        minter = blockchain.openContract(await TestJettonMinter.fromInit(owner.address, content));
        await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    });

    it('TJM-1: no get_jetton_data (TEP-74) on master, no get_wallet_data on wallet', async () => {
        await minter.send(owner.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: 1n, recipient: alice.address });
        let masterErr: any = null;
        try {
            const r = await blockchain.runGetMethod(minter.address, 'get_jetton_data');
            masterErr = r.exitCode;
        } catch (e: any) {
            masterErr = e.exitCode ?? String(e);
        }
        console.log('get_jetton_data ->', masterErr);
        expect(masterErr).toEqual(11);
        const walletAddr = await minter.getGetWalletAddress(alice.address);
        let walletErr: any = null;
        try {
            const r = await blockchain.runGetMethod(walletAddr, 'get_wallet_data');
            walletErr = r.exitCode;
        } catch (e: any) {
            walletErr = e.exitCode ?? String(e);
        }
        console.log('get_wallet_data ->', walletErr);
        expect(walletErr).toEqual(11);
        // provide_wallet_address (TEP-89, op 0x2c76b973) is not handled either -> 130
        const r = await alice.send({
            to: minter.address,
            value: toNano('0.1'),
            body: beginCell().storeUint(0x2c76b973, 32).storeUint(0, 64).storeAddress(alice.address).storeBit(false).endCell(),
        });
        expect(r.transactions).toHaveTransaction({ from: alice.address, to: minter.address, success: false, exitCode: 130 });
    });

    it('OK: get_wallet_address equals the actually deployed wallet and the sibling derivation', async () => {
        const r = await minter.send(owner.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: 5n, recipient: alice.address });
        const expected = await minter.getGetWalletAddress(alice.address);
        const fromInit = (await TestJettonWallet.fromInit(alice.address, minter.address)).address;
        expect(expected.equals(fromInit)).toBe(true);
        expect(r.transactions).toHaveTransaction({ from: minter.address, to: expected, deploy: true, success: true });
        const w = blockchain.openContract(TestJettonWallet.fromAddress(expected));
        expect((await w.getMasterAddress()).equals(minter.address)).toBe(true);
        expect((await w.getWalletOwner()).equals(alice.address)).toBe(true);
    });

    it('TJM-2: underfunded Mint inflates totalSupply without crediting any wallet (bounce:false)', async () => {
        const snap = blockchain.snapshot();
        let found: bigint | null = null;
        for (let v = 2_000_000n; v <= 3_200_000n; v += 20_000n) {
            await blockchain.loadFrom(snap);
            const r = await minter.send(owner.getSender(), { value: v }, { $$type: 'Mint', amount: toNano('1000'), recipient: alice.address });
            const minterOk = r.transactions.some(
                (t: any) => t.inMessage?.info.dest?.equals?.(minter.address) && t.description.type === 'generic' &&
                    t.description.computePhase.type === 'vm' && t.description.computePhase.success && !t.description.aborted,
            );
            const total = await minter.getMintedTotal();
            const bal = await balanceOf(alice.address);
            if (minterOk && total !== bal) {
                found = v;
                console.log(`Mint value ${v} nanoTON: mintedTotal=${total} wallet balance=${bal}`);
                expect(r.transactions).toHaveTransaction({ from: minter.address, success: false });
                break;
            }
        }
        expect(found).not.toBeNull();
    });

    it('TJM-3: mint excess TON goes to the recipient, not to the owner who paid', async () => {
        const r = await minter.send(owner.getSender(), { value: toNano('0.5') }, { $$type: 'Mint', amount: 1n, recipient: alice.address });
        const w = await minter.getGetWalletAddress(alice.address);
        expect(r.transactions).toHaveTransaction({ from: w, to: alice.address, op: 0xd53276db, value: (x) => x! > toNano('0.4') });
        expect(r.transactions).not.toHaveTransaction({ from: w, to: owner.address });
    });

    it('TJM-4: owner is immutable (no ChangeOwner), non-owner Mint rejected 132', async () => {
        const co = await owner.send({
            to: minter.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x819dbe99, 32).storeUint(0, 64).storeAddress(alice.address).endCell(),
        });
        expect(co.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: 130 });
        const m = await minter.send(attacker.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: 1n, recipient: attacker.address });
        expect(m.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: 132 });
        expect(await minter.getMintedTotal()).toEqual(0n);
    });

    it('OK: totalSupply coins overflow reverts atomically (no wallet credit, bounce to owner)', async () => {
        const MAX = (1n << 120n) - 1n;
        await minter.send(owner.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: MAX, recipient: alice.address });
        expect(await minter.getMintedTotal()).toEqual(MAX);
        const r = await minter.send(owner.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: 1n, recipient: attacker.address });
        expect(r.transactions).toHaveTransaction({ to: minter.address, success: false });
        expect(r.transactions).not.toHaveTransaction({ from: minter.address, to: await minter.getGetWalletAddress(attacker.address) });
        expect(await minter.getMintedTotal()).toEqual(MAX);
    });

    it('TJM-5: anyone deploys an identical-code minter and mints unlimited supply', async () => {
        const evil = blockchain.openContract(await TestJettonMinter.fromInit(attacker.address, content));
        await evil.send(attacker.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        const MAX = (1n << 120n) - 1n;
        await evil.send(attacker.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: MAX, recipient: attacker.address });
        const ew = blockchain.openContract(TestJettonWallet.fromAddress(await evil.getGetWalletAddress(attacker.address)));
        expect(await ew.getWalletBalance()).toEqual(MAX);
        // same code hash as the "official" test minter
        const a = (await blockchain.getContract(minter.address)).accountState as any;
        const b = (await blockchain.getContract(evil.address)).accountState as any;
        expect(a.state.code.hash().equals(b.state.code.hash())).toBe(true);
    });

    it('TJM-6: Mint straight to a ChatPool credits its jetton wallet with no ledger entry; Excesses to pool fail with 130', async () => {
        const backend = keyPairFromSeed(Buffer.alloc(32, 7));
        const pool = blockchain.openContract(
            await ChatPool.fromInit(owner.address, 1n, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        await pool.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        const r = await minter.send(owner.getSender(), { value: toNano('0.3') }, { $$type: 'Mint', amount: toNano('10'), recipient: pool.address });
        expect(r.transactions).toHaveTransaction({ to: pool.address, op: 0xd53276db, success: false, exitCode: 130 });
        expect(await balanceOf(pool.address)).toEqual(toNano('10'));
        expect(await pool.getBalanceOf(minter.address)).toEqual(0n);
    });
    it('TJM-2b (cross-ref wallet): inline forward payload burns tokens silently; mintedTotal never decreases', async () => {
        await minter.send(owner.getSender(), { value: toNano('0.2') }, { $$type: 'Mint', amount: 100n, recipient: alice.address });
        const aw = blockchain.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(alice.address)));
        // TEP-74-valid inline (Either bit 0) forward payload with forward_ton_amount > 0
        const r = await aw.send(alice.getSender(), { value: toNano('0.2') }, {
            $$type: 'JettonTransfer', queryId: 0n, amount: 40n, destination: attacker.address,
            responseDestination: alice.address, customPayload: null, forwardTonAmount: toNano('0.01'),
            forwardPayload: beginCell().storeBit(false).endCell(),
        });
        expect(r.transactions).toHaveTransaction({ from: aw.address, success: false, exitCode: 47577 });
        expect(await aw.getWalletBalance()).toEqual(60n);
        expect(await balanceOf(attacker.address)).toEqual(0n);
        expect(await minter.getMintedTotal()).toEqual(100n); // 40 tokens vanished, supply still counts them
    });
});

