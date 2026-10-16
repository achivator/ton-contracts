import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, StateInit, toNano } from '@ton/core';
import { flattenTransaction } from '@ton/test-utils';
import '@ton/test-utils';
import { TestJettonWallet } from '../wrappers/TestJetton';
import { REF_JETTON_WALLET, USDT_JETTON_WALLET, realWalletInit } from './helpers/realJettonWallets';
import {
    burnBody,
    internalTransferBody,
    jettonBalance,
    MAX_COINS,
    OP,
    transferBody,
    WALLET_EXIT,
} from './helpers/jettonMessages';

// Parity: TestJettonWallet must behave like the production wallets, so tests
// built on it cannot mask bugs that real wallets expose (review TJM-7/TJW-5,
// and the X-1 Critical that survived because of it). Every scenario runs the
// same messages through TestJettonWallet and through the vendored reference
// TEP-74 wallet (or the USDT wallet, for the stricter forward_payload rule),
// then compares what happened: which messages were sent, between whom,
// bounceable or not, with which exit codes, the exact notification /
// burn_notification / excess bodies, and the resulting jetton balances.
//
// TON amounts differ (different gas usage) and are not compared, except the
// value a notification carries, which is forward_ton_amount in both.

interface WalletKind {
    name: string;
    init(owner: Address, master: Address): Promise<StateInit>;
}

const TEST_WALLET: WalletKind = {
    name: 'TestJettonWallet',
    init: async (owner, master) => (await TestJettonWallet.fromInit(owner, master)).init!,
};
const REF_WALLET: WalletKind = {
    name: REF_JETTON_WALLET.name,
    init: async (owner, master) => realWalletInit(REF_JETTON_WALLET, owner, master),
};
const USDT_WALLET: WalletKind = {
    name: USDT_JETTON_WALLET.name,
    init: async (owner, master) => realWalletInit(USDT_JETTON_WALLET, owner, master),
};

interface Env {
    blockchain: Blockchain;
    master: SandboxContract<TreasuryContract>; // plays the jetton minter
    alice: SandboxContract<TreasuryContract>;
    bob: SandboxContract<TreasuryContract>;
    carol: SandboxContract<TreasuryContract>;
    aliceWallet: Address;
    bobWallet: Address;
    mint(owner: Address, amount: bigint): Promise<void>;
}

async function setup(kind: WalletKind): Promise<Env> {
    const blockchain = await Blockchain.create();
    blockchain.now = 1_800_000_000;
    const master = await blockchain.treasury('jetton-master');
    const alice = await blockchain.treasury('alice');
    const bob = await blockchain.treasury('bob');
    const carol = await blockchain.treasury('carol');
    const walletOf = async (owner: Address) => contractAddress(0, await kind.init(owner, master.address));
    const mint = async (owner: Address, amount: bigint) => {
        const init = await kind.init(owner, master.address);
        const res = await master.send({
            to: contractAddress(0, init),
            value: toNano('0.1'),
            init,
            bounce: false,
            body: internalTransferBody({ amount, from: master.address, responseDestination: null }),
        });
        expect(res.transactions).toHaveTransaction({ to: contractAddress(0, init), success: true });
    };
    const env: Env = {
        blockchain,
        master,
        alice,
        bob,
        carol,
        aliceWallet: await walletOf(alice.address),
        bobWallet: await walletOf(bob.address),
        mint,
    };
    await mint(alice.address, toNano('1000'));
    return env;
}

const BODY_OPS = new Set([OP.transferNotification, OP.burnNotification, OP.excesses]);

// The comparable shape of a message chain.
function trace(env: Env, res: SendMessageResult) {
    const names: [string, Address][] = [
        ['master', env.master.address],
        ['alice', env.alice.address],
        ['bob', env.bob.address],
        ['carol', env.carol.address],
        ['aliceWallet', env.aliceWallet],
        ['bobWallet', env.bobWallet],
    ];
    const label = (a?: Address) => (a ? names.find(([, x]) => x.equals(a))?.[0] ?? a.toString() : 'none');
    return res.transactions
        .map(flattenTransaction)
        .filter((t) => t.from !== undefined)
        .map((t) => ({
            from: label(t.from),
            to: label(t.to),
            op: t.op === undefined ? 'none' : '0x' + t.op.toString(16),
            bounceable: t.inMessageBounceable,
            bounced: t.inMessageBounced,
            deploy: t.deploy,
            success: t.success,
            exitCode: t.exitCode,
            // bit-exact bodies of what the wallet builds
            body:
                t.op !== undefined && BODY_OPS.has(t.op) && !t.inMessageBounced
                    ? t.body?.toBoc().toString('hex')
                    : undefined,
            // a notification carries exactly forward_ton_amount
            value: t.op === OP.transferNotification ? t.value : undefined,
        }));
}

interface Scenario {
    name: string;
    from?: 'alice' | 'bob'; // who sends `body` to alice's wallet (default alice)
    value: bigint;
    body(env: Env): Cell;
    prepare?(env: Env): Promise<void>;
    // checks every implementation must pass, on top of being identical
    expectations?(t: ReturnType<typeof trace>, balances: Balances): void;
}

async function run(kind: WalletKind, sc: Scenario) {
    const env = await setup(kind);
    if (sc.prepare) await sc.prepare(env);
    const sender = sc.from === 'bob' ? env.bob : env.alice;
    const res = await sender.send({ to: env.aliceWallet, value: sc.value, body: sc.body(env) });
    return {
        trace: trace(env, res),
        balances: {
            alice: await balanceOrError(env.blockchain, env.aliceWallet),
            bob: await balanceOrError(env.blockchain, env.bobWallet),
        },
    };
}

// A missing get_wallet_data shows up as a value mismatch, after the trace.
async function balanceOrError(blockchain: Blockchain, wallet: Address): Promise<bigint | string> {
    try {
        return await jettonBalance(blockchain, wallet);
    } catch (e) {
        return `error: ${(e as Error).message}`;
    }
}

type Balances = { alice: bigint | string; bob: bigint | string };

const inlineComment = beginCell().storeBit(false).storeUint(0, 32).storeStringTail('thanks').endCell();
const refPayload = beginCell().storeBit(true).storeRef(beginCell().storeUint(0xdead, 16).endCell()).endCell();
const inlineWithRef = beginCell()
    .storeBit(false)
    .storeUint(0xbeef, 16)
    .storeRef(beginCell().storeUint(0xaa, 8).endCell())
    .endCell();

const transfer = (env: Env, over: Partial<Parameters<typeof transferBody>[0]> & { forwardPayload: Cell }): Cell =>
    transferBody({
        queryId: 42n,
        amount: toNano('100'),
        destination: env.bob.address,
        responseDestination: env.alice.address,
        forwardTonAmount: toNano('0.05'),
        ...over,
    });

const hop = (t: ReturnType<typeof trace>, from: string, to: string) => t.filter((x) => x.from === from && x.to === to);

const delivered = (t: ReturnType<typeof trace>, balances: Balances) => {
    expect(hop(t, 'aliceWallet', 'bobWallet')).toMatchObject([{ op: '0x178d4519', bounceable: true, success: true }]);
    expect(balances).toEqual({ alice: toNano('900'), bob: toNano('100') });
};

const rejectedBySender = (exitCode: number) => (t: ReturnType<typeof trace>, balances: Balances) => {
    expect(hop(t, 'alice', 'aliceWallet')).toMatchObject([{ success: false, exitCode }]);
    expect(hop(t, 'aliceWallet', 'bobWallet')).toEqual([]);
    expect(balances).toEqual({ alice: toNano('1000'), bob: 0n });
};

const notification = (t: ReturnType<typeof trace>) => hop(t, 'bobWallet', 'bob');
const excesses = (t: ReturnType<typeof trace>) => t.filter((x) => x.op === '0xd53276db');

const SCENARIOS: Scenario[] = [
    {
        name: 'inline (Either left) text comment: notification carries it verbatim, excess to response',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardPayload: inlineComment }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(notification(t)).toMatchObject([{ op: '0x7362d09c', bounceable: false, value: toNano('0.05') }]);
            expect(excesses(t)).toMatchObject([{ from: 'bobWallet', to: 'alice', bounceable: false }]);
        },
    },
    {
        name: 'ref (Either right) payload: notification carries the bit and the ref verbatim',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardPayload: refPayload }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(notification(t)).toHaveLength(1);
        },
    },
    {
        name: 'inline payload with a ref and trailing bits is forwarded untouched',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardPayload: inlineWithRef }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(notification(t)).toHaveLength(1);
        },
    },
    {
        name: 'response_destination = addr_none: no excess is sent anywhere',
        value: toNano('0.2'),
        body: (env) => transfer(env, { responseDestination: null, forwardPayload: inlineComment }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(excesses(t)).toEqual([]);
        },
    },
    {
        name: 'response_destination is a third party: the excess goes there, not to the owner',
        value: toNano('0.2'),
        body: (env) => transfer(env, { responseDestination: env.carol.address, forwardPayload: inlineComment }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(excesses(t)).toMatchObject([{ from: 'bobWallet', to: 'carol' }]);
        },
    },
    {
        name: 'forward_ton_amount = 0: no notification, excess to response',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardTonAmount: 0n, forwardPayload: inlineComment }),
        expectations: (t, b) => {
            delivered(t, b);
            expect(notification(t)).toEqual([]);
            expect(excesses(t)).toMatchObject([{ from: 'bobWallet', to: 'alice' }]);
        },
    },
    {
        name: 'forward_payload without the Either bit is rejected (forward_ton_amount > 0)',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardPayload: beginCell().endCell() }),
        expectations: rejectedBySender(WALLET_EXIT.badForwardPayload),
    },
    {
        name: 'forward_payload without the Either bit is rejected (forward_ton_amount = 0)',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardTonAmount: 0n, forwardPayload: beginCell().endCell() }),
        expectations: rejectedBySender(WALLET_EXIT.badForwardPayload),
    },
    {
        name: 'value below forward_ton_amount + fees + gas is rejected before any token moves',
        value: toNano('0.5'),
        body: (env) => transfer(env, { forwardTonAmount: toNano('1'), forwardPayload: refPayload }),
        expectations: rejectedBySender(WALLET_EXIT.valueTooLow),
    },
    {
        name: 'value barely above forward_ton_amount is rejected too (no draining the wallet TON)',
        value: toNano('0.1'),
        body: (env) => transfer(env, { forwardTonAmount: toNano('0.09'), forwardPayload: refPayload }),
        expectations: rejectedBySender(WALLET_EXIT.valueTooLow),
    },
    {
        name: 'only the owner can transfer',
        from: 'bob',
        value: toNano('0.2'),
        body: (env) => transfer(env, { forwardPayload: inlineComment }),
        expectations: (t, b) => {
            expect(hop(t, 'bob', 'aliceWallet')).toMatchObject([{ success: false, exitCode: WALLET_EXIT.notOwner }]);
            expect(b).toEqual({ alice: toNano('1000'), bob: 0n });
        },
    },
    {
        name: 'cannot transfer more than the balance',
        value: toNano('0.2'),
        body: (env) => transfer(env, { amount: toNano('1001'), forwardPayload: inlineComment }),
        expectations: rejectedBySender(WALLET_EXIT.balanceTooLow),
    },
    {
        name: 'the receiving wallet fails: the bounce restores the sender balance',
        value: toNano('0.2'),
        // bob's balance is at the Coins maximum, so crediting him overflows
        prepare: (env) => env.mint(env.bob.address, MAX_COINS),
        body: (env) => transfer(env, { forwardPayload: inlineComment }),
        expectations: (t, b) => {
            expect(hop(t, 'aliceWallet', 'bobWallet')).toMatchObject([{ success: false }]);
            expect(hop(t, 'bobWallet', 'aliceWallet')).toMatchObject([{ bounced: true, success: true }]);
            expect(b).toEqual({ alice: toNano('1000'), bob: MAX_COINS });
        },
    },
    {
        name: 'a plain TON top-up (empty body) is accepted',
        value: toNano('1'),
        body: () => beginCell().endCell(),
        expectations: (t, b) => {
            expect(hop(t, 'alice', 'aliceWallet')).toMatchObject([{ success: true }]);
            expect(b).toEqual({ alice: toNano('1000'), bob: 0n });
        },
    },
    {
        name: 'burn sends a bounceable burn_notification to the master',
        value: toNano('0.2'),
        body: (env) => burnBody({ queryId: 7n, amount: toNano('300'), responseDestination: env.alice.address }),
        expectations: (t, b) => {
            expect(hop(t, 'aliceWallet', 'master')).toMatchObject([{ op: '0x7bdd97de', bounceable: true }]);
            expect(b).toEqual({ alice: toNano('700'), bob: 0n });
        },
    },
    {
        name: 'burn with too little value is rejected',
        value: toNano('0.02'),
        body: (env) => burnBody({ amount: toNano('300'), responseDestination: env.alice.address }),
        expectations: rejectedBySender(WALLET_EXIT.untrustedSender),
    },
    {
        name: 'burn by a non-owner is rejected',
        from: 'bob',
        value: toNano('0.2'),
        body: (env) => burnBody({ amount: toNano('300'), responseDestination: env.bob.address }),
        expectations: (t, b) => {
            expect(hop(t, 'bob', 'aliceWallet')).toMatchObject([{ success: false, exitCode: WALLET_EXIT.notOwner }]);
            expect(b).toEqual({ alice: toNano('1000'), bob: 0n });
        },
    },
];

describe('TestJettonWallet behaves like the reference TEP-74 wallet', () => {
    for (const sc of SCENARIOS) {
        it(sc.name, async () => {
            const ref = await run(REF_WALLET, sc);
            sc.expectations?.(ref.trace, ref.balances); // the scenario describes the reference faithfully
            const test = await run(TEST_WALLET, sc);
            expect(test.trace).toEqual(ref.trace);
            expect(test.balances).toEqual(ref.balances);
        });
    }
});

// The reference wallet only checks that forward_payload has at least one bit;
// the USDT wallet also rejects an Either-right payload with anything besides
// the bit and its ref. TestJettonWallet applies the stricter USDT rule.
describe('TestJettonWallet applies the USDT forward_payload rule', () => {
    const cases: [string, Cell, boolean][] = [
        ['empty (no Either bit)', beginCell().endCell(), false],
        [
            'Either right with trailing bits',
            beginCell().storeBit(true).storeRef(Cell.EMPTY).storeUint(1, 8).endCell(),
            false,
        ],
        [
            'Either right with two refs',
            beginCell().storeBit(true).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).endCell(),
            false,
        ],
        ['Either right, exactly bit + ref', refPayload, true],
        ['Either left with data and a ref', inlineWithRef, true],
        ['Either left, empty', beginCell().storeBit(false).endCell(), true],
    ];
    for (const [name, payload, accepted] of cases) {
        it(`${name}: ${accepted ? 'accepted' : 'rejected'}`, async () => {
            const sc: Scenario = {
                name,
                value: toNano('0.2'),
                body: (env) => transfer(env, { forwardPayload: payload }),
            };
            const usdt = await run(USDT_WALLET, sc);
            const test = await run(TEST_WALLET, sc);
            const outcome = (r: typeof usdt) => ({
                accepted: hop(r.trace, 'alice', 'aliceWallet')[0].success,
                delivered: hop(r.trace, 'aliceWallet', 'bobWallet').some((x) => x.success),
                notified: hop(r.trace, 'bobWallet', 'bob').length,
                balances: r.balances,
            });
            expect(outcome(usdt).accepted).toBe(accepted);
            expect(outcome(test)).toEqual(outcome(usdt));
            if (!accepted) {
                expect(hop(test.trace, 'alice', 'aliceWallet')).toMatchObject([
                    { exitCode: WALLET_EXIT.badForwardPayload },
                ]);
            } else {
                // and the notification body is still identical to what USDT sends
                expect(notification(test.trace)).toEqual(notification(usdt.trace));
            }
        });
    }
});
