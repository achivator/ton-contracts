import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { beginCell, toNano } from '@ton/core';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { DistributorMaster } from '../../wrappers/DistributorMaster';
import '@ton/test-utils';

// Checks from the DistributorMaster security review. The finding PoCs
// (DM-2..DM-9) are fixed; their regressions live in
// tests/DistributorMasterSecurity.spec.ts. What is left here measures.

const CHAT_ID = -1001234567890n;
const pub = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));

async function deployMaster(bc: Blockchain, owner: SandboxContract<TreasuryContract>, key: bigint) {
    const m = bc.openContract(await DistributorMaster.fromInit(owner.address, key));
    const r = await m.send(owner.getSender(), { value: toNano('0.3') }, { $$type: 'Deploy', queryId: 0n });
    expect(r.transactions).toHaveTransaction({ to: m.address, deploy: true, success: true });
    return m;
}

describe('DistributorMaster PoC', () => {
    const backend = keyPairFromSeed(Buffer.alloc(32, 7));

    it('CHECK-2: non-bounceable CreatePool when master balance < accrued storage fee', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        bc.now = Math.floor(Date.now() / 1000) + 200 * 86400;
        const body = beginCell().storeUint(0x69873d03, 32).storeInt(CHAT_ID, 64).endCell();
        const r = await bc.sendMessage(
            internal({ from: user.address, to: m.address, value: toNano('0.3'), body, bounce: false }),
        );
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === m.address.toString());
        const d: any = tx!.description;
        console.log(
            `DM-8 non-bounceable: aborted=${d.aborted} exit=${d.computePhase?.exitCode} storage=${d.storagePhase?.storageFeesCollected} due=${d.storagePhase?.storageFeesDue}`,
        );
        console.log(
            'CHECK-2 refund to user:',
            r.transactions.some((t) => t.inMessage?.info.dest?.toString() === user.address.toString()),
        );
    });

    it('CHECK: CreatePool with exactly 0.2 TON succeeds and the master keeps its balance', async () => {
        const bc = await Blockchain.create();
        const owner = await bc.treasury('owner');
        const user = await bc.treasury('user');
        const m = await deployMaster(bc, owner, pub(backend));
        await owner.send({ to: m.address, value: toNano('1'), bounce: false }); // top-up
        const before = (await bc.getContract(m.address)).balance;
        const r = await m.send(user.getSender(), { value: toNano('0.2') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        expect(r.transactions).toHaveTransaction({ from: m.address, deploy: true, success: true });
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === m.address.toString())!;
        console.log('CHECK gas/fees of CreatePool:', tx.totalFees.coins.toString());
        const after = (await bc.getContract(m.address)).balance;
        console.log('CHECK master delta:', (after - before).toString());
        expect(before - after).toBeLessThan(toNano('0.001'));
    });
});
