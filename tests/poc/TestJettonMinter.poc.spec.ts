import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { onchainJettonContent, TestJettonMinter, TestJettonWallet } from '../../wrappers/TestJetton';
import { ChatPool } from '../../wrappers/ChatPool';
import '@ton/test-utils';

// Security PoCs for TestJettonMinter (contracts/test_jetton.tact) that are
// documented-only (informational, testnet jetton). The fixed TJM-* findings
// are covered by tests/TestJetton.spec.ts instead.
describe('TestJettonMinter PoC', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TestJettonMinter>;
    const content = onchainJettonContent({ name: 'test', decimals: '9' });

    async function balanceOf(addr: Address): Promise<bigint> {
        const w = blockchain.openContract(TestJettonWallet.fromAddress(await minter.getGetWalletAddress(addr)));
        const st = await blockchain.getContract(w.address);
        if (st.accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        attacker = await blockchain.treasury('attacker');
        minter = blockchain.openContract(await TestJettonMinter.fromInit(owner.address, content));
        await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
    });

    it('TJM-5: anyone deploys an identical-code minter and mints unlimited supply', async () => {
        const evil = blockchain.openContract(await TestJettonMinter.fromInit(attacker.address, content));
        await evil.send(attacker.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 0n });
        const MAX = (1n << 120n) - 1n;
        await evil.send(
            attacker.getSender(),
            { value: toNano('0.2') },
            { $$type: 'Mint', queryId: 0n, amount: MAX, recipient: attacker.address },
        );
        const ew = blockchain.openContract(
            TestJettonWallet.fromAddress(await evil.getGetWalletAddress(attacker.address)),
        );
        expect((await ew.getGetWalletData()).balance).toEqual(MAX);
        // same code hash as the "official" test minter
        const a = (await blockchain.getContract(minter.address)).accountState as any;
        const b = (await blockchain.getContract(evil.address)).accountState as any;
        expect(a.state.code.hash().equals(b.state.code.hash())).toBe(true);
    });

    // Mint sends no transfer_notification, so a contract recipient never learns
    // about minted tokens. (The mint excess now goes to the payer, not the pool.)
    it('TJM-6: Mint straight to a ChatPool credits its jetton wallet with no ledger entry', async () => {
        const backend = keyPairFromSeed(Buffer.alloc(32, 7));
        const pool = blockchain.openContract(
            await ChatPool.fromInit(owner.address, 1n, BigInt('0x' + backend.publicKey.toString('hex'))),
        );
        await pool.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });
        const r = await minter.send(
            owner.getSender(),
            { value: toNano('0.3') },
            { $$type: 'Mint', queryId: 0n, amount: toNano('10'), recipient: pool.address },
        );
        expect(r.transactions).not.toHaveTransaction({ to: pool.address });
        expect(await balanceOf(pool.address)).toEqual(toNano('10'));
        expect(await pool.getBalanceOf(minter.address)).toEqual(0n);
    });
});
