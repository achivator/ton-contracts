// Regressions for the DistributorMaster findings of
// docs/security/2026-10-06-contracts-review.md (DM-2..DM-10). Each test
// asserts the CORRECT behaviour; most started out as a PoC in
// tests/poc/DistributorMaster.poc.spec.ts that asserted the bug.
import { Blockchain, internal } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import '@ton/test-utils';
import { ChatPool, storeInitPool } from '../wrappers/ChatPool';
import { ChatPool as StandaloneChatPool } from '../build/ChatPool/tact_ChatPool';
import {
    BACKEND,
    CHAT_ID,
    deployMaster,
    errorCode,
    expectTx,
    PoolEnv,
    pubKey,
    rentPerYear,
    setAdminMsg,
    setupPool,
    T0,
    tonBalance,
} from './helpers/pool';
import { globalIdOf } from './helpers/vouchers';

const NEXT = keyPairFromSeed(Buffer.alloc(32, 8));
const OTHER_CHAT = -1009999999999n;

async function freshMaster() {
    const bc = await Blockchain.create();
    bc.now = T0;
    const owner = await bc.treasury('owner');
    const user = await bc.treasury('user');
    const master = await deployMaster(bc, owner);
    return { bc, owner, user, master };
}

describe('DistributorMaster security regressions', () => {
    it('DM-2: poolAddress(chatId) survives RotateBackendKey; existing pools keep their key until their admin moves it', async () => {
        const env = await setupPool();
        const before = await env.master.getPoolAddress(CHAT_ID);
        const rotate = await env.master.send(
            env.owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'RotateBackendKey', backendPubKey: pubKey(NEXT) },
        );
        expectTx(rotate, { to: env.master.address, success: true });
        expect((await env.master.getPoolAddress(CHAT_ID)).equals(before)).toBe(true);

        // CreatePool again is a no-op for the existing pool: no second pool, no new key
        const again = await env.master.send(
            env.admin.getSender(),
            { value: toNano('0.3') },
            { $$type: 'CreatePool', chatId: CHAT_ID },
        );
        expectTx(again, { from: env.master.address, to: before, success: true });
        expect(await env.pool.getBackendKey()).toEqual(pubKey(BACKEND));

        // the admin moves the existing pool to the new key
        await env.pool.send(
            env.admin.getSender(),
            { value: toNano('0.05') },
            { $$type: 'SetPoolBackendKey', backendPubKey: pubKey(NEXT) },
        );
        expect(await env.pool.getBackendKey()).toEqual(pubKey(NEXT));

        // pools created after the rotation start with the new key
        await env.master.send(
            env.admin.getSender(),
            { value: toNano('0.3') },
            { $$type: 'CreatePool', chatId: OTHER_CHAT },
        );
        const other = env.bc.openContract(ChatPool.fromAddress(await env.master.getPoolAddress(OTHER_CHAT)));
        expect(await other.getIsInitialized()).toBe(true);
        expect(await other.getBackendKey()).toEqual(pubKey(NEXT));
    });

    it('DM-3: a pool deployed around the master stays inert until the master initialises it with its current key', async () => {
        const { bc, owner, master } = await freshMaster();
        const attacker = await bc.treasury('attacker');
        await master.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'RotateBackendKey',
                backendPubKey: pubKey(NEXT),
            },
        );

        // StateInit is public: deploy ChatPool(master, chat) directly
        const rogue = bc.openContract(await ChatPool.fromInit(master.address, OTHER_CHAT));
        expect(rogue.address.equals(await master.getPoolAddress(OTHER_CHAT))).toBe(true);
        const init = await rogue.send(
            attacker.getSender(),
            { value: toNano('0.1') },
            {
                $$type: 'InitPool',
                backendPubKey: pubKey(BACKEND), // the leaked, rotated-out key
                excessTo: attacker.address,
            },
        );
        expectTx(init, {
            to: rogue.address,
            success: false,
            exitCode: errorCode(rogue, 'only the master initialises the pool'),
        });
        expect(await rogue.getIsInitialized()).toBe(false);

        // with an old-key voucher: refused too (not initialised)
        const env = { bc, globalId: globalIdOf(bc), master, pool: rogue } as unknown as PoolEnv;
        const setAdmin = await rogue.send(
            attacker.getSender(),
            { value: toNano('0.05') },
            setAdminMsg(env, attacker.address),
        );
        expectTx(setAdmin, {
            to: rogue.address,
            success: false,
            exitCode: errorCode(rogue, 'pool is not initialised'),
        });
        const topUp = await attacker.send({ to: rogue.address, value: toNano('0.05') });
        expectTx(topUp, { to: rogue.address, success: false, exitCode: errorCode(rogue, 'pool is not initialised') });
        expect(await rogue.getIsInitialized()).toBe(false);

        // the master initialises it with the current key; old-key vouchers are dead
        await master.send(attacker.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: OTHER_CHAT });
        expect(await rogue.getIsInitialized()).toBe(true);
        expect(await rogue.getBackendKey()).toEqual(pubKey(NEXT));
        const stale = await rogue.send(
            attacker.getSender(),
            { value: toNano('0.05') },
            setAdminMsg(env, attacker.address),
        );
        expectTx(stale, {
            to: rogue.address,
            success: false,
            exitCode: errorCode(rogue, 'bad admin voucher signature'),
        });
        expect(await rogue.getPoolAdmin()).toBeNull();

        // and only once: a second InitPool from the master changes no key and
        // hands its value back
        const twice = await bc.sendMessage(
            internal({
                from: master.address,
                to: rogue.address,
                value: toNano('0.1'),
                body: beginCell()
                    .store(
                        storeInitPool({
                            $$type: 'InitPool',
                            backendPubKey: pubKey(BACKEND),
                            excessTo: attacker.address,
                        }),
                    )
                    .endCell(),
            }),
        );
        expectTx(twice, { from: rogue.address, to: attacker.address, success: true });
        expect(await rogue.getBackendKey()).toEqual(pubKey(NEXT));
    });

    it('DM-7: CreatePool for an existing pool hands the pool value back to the caller', async () => {
        const env = await setupPool();
        const poolBefore = await tonBalance(env.bc, env.pool.address);
        const userBefore = await tonBalance(env.bc, env.user.address);
        const res = await env.master.send(
            env.user.getSender(),
            { value: toNano('0.3') },
            { $$type: 'CreatePool', chatId: CHAT_ID },
        );
        expectTx(res, { from: env.pool.address, to: env.user.address, success: true });
        const poolAfter = await tonBalance(env.bc, env.pool.address);
        expect(poolAfter - poolBefore).toBeLessThan(toNano('0.001'));
        // the caller only pays gas
        expect(userBefore - (await tonBalance(env.bc, env.user.address))).toBeLessThan(toNano('0.03'));
        expect(await env.pool.getBackendKey()).toEqual(pubKey(BACKEND));
    });

    it('DM-4: ownership moves in two steps (propose, accept)', async () => {
        const { bc, owner, user, master } = await freshMaster();
        const next = await bc.treasury('next-owner');
        const byStranger = await master.send(
            user.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'ProposeOwner',
                newOwner: user.address,
            },
        );
        expectTx(byStranger, { to: master.address, success: false });

        await master.send(
            owner.getSender(),
            { value: toNano('0.05') },
            { $$type: 'ProposeOwner', newOwner: next.address },
        );
        expect((await master.getPendingOwner())!.equals(next.address)).toBe(true);
        expect((await master.getOwner()).equals(owner.address)).toBe(true);

        const wrongAccept = await master.send(
            user.getSender(),
            { value: toNano('0.05') },
            { $$type: 'AcceptOwnership' },
        );
        expectTx(wrongAccept, { to: master.address, success: false });

        const accept = await master.send(next.getSender(), { value: toNano('0.05') }, { $$type: 'AcceptOwnership' });
        expectTx(accept, { to: master.address, success: true });
        expect((await master.getOwner()).equals(next.address)).toBe(true);
        expect(await master.getPendingOwner()).toBeNull();

        const oldOwner = await master.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'RotateBackendKey',
                backendPubKey: pubKey(NEXT),
            },
        );
        expectTx(oldOwner, { to: master.address, success: false });
        const newOwner = await master.send(
            next.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'RotateBackendKey',
                backendPubKey: pubKey(NEXT),
            },
        );
        expectTx(newOwner, { to: master.address, success: true });

        // a proposal can be withdrawn
        await master.send(
            next.getSender(),
            { value: toNano('0.05') },
            { $$type: 'ProposeOwner', newOwner: user.address },
        );
        await master.send(next.getSender(), { value: toNano('0.05') }, { $$type: 'ProposeOwner', newOwner: null });
        const late = await master.send(user.getSender(), { value: toNano('0.05') }, { $$type: 'AcceptOwnership' });
        expectTx(late, { to: master.address, success: false });
    });

    it('DM-5: the master keeps a storage reserve on Deploy and covers its rent for years', async () => {
        const { bc, owner, user, master } = await freshMaster();
        const reserve = toNano('0.1'); // MasterStorageReserve
        const afterDeploy = await tonBalance(bc, master.address);
        expect(afterDeploy).toBeGreaterThanOrEqual(reserve);

        // a second Deploy, CreatePool and RotateBackendKey never dip into it
        await master.send(user.getSender(), { value: toNano('0.05') }, { $$type: 'Deploy', queryId: 1n });
        await master.send(user.getSender(), { value: toNano('0.3') }, { $$type: 'CreatePool', chatId: CHAT_ID });
        await master.send(
            owner.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'RotateBackendKey',
                backendPubKey: pubKey(NEXT),
            },
        );
        expect(await tonBalance(bc, master.address)).toBeGreaterThanOrEqual(afterDeploy - toNano('0.001'));

        const perYear = await rentPerYear(bc, master.address);
        const years = Number(reserve) / Number(perYear);
        console.log(
            `DM-5: master rent ${(Number(perYear) / 1e9).toFixed(5)} TON/yr; the reserve covers ${years.toFixed(1)} years`,
        );
        expect(years).toBeGreaterThanOrEqual(10);
    });

    it('DM-6: RotateBackendKey rejects 0 and the current key', async () => {
        const { owner, master } = await freshMaster();
        for (const key of [0n, pubKey(BACKEND)]) {
            const r = await master.send(
                owner.getSender(),
                { value: toNano('0.05') },
                {
                    $$type: 'RotateBackendKey',
                    backendPubKey: key,
                },
            );
            expectTx(r, { to: master.address, success: false, exitCode: errorCode(master, 'invalid backend key') });
        }
        expect(await master.getBackendKey()).toEqual(pubKey(BACKEND));
    });

    it('DM-8: wrappers/ChatPool derives exactly the address and code the master deploys', async () => {
        const env = await setupPool();
        const viaWrapper = await ChatPool.fromInit(env.master.address, CHAT_ID);
        expect(viaWrapper.address.equals(env.pool.address)).toBe(true);
        const deployed = (await env.bc.getContract(env.pool.address)).accountState as any;
        expect((deployed.state.code as Cell).hash().equals(viaWrapper.init!.code.hash())).toBe(true);
        // the standalone build compiles ChatPool in its own unit (another
        // get_abi_ipfs): it must never be used to derive pool addresses
        const standalone = await StandaloneChatPool.fromInit(env.master.address, CHAT_ID);
        expect(standalone.address.equals(env.pool.address)).toBe(false);
    });
});
