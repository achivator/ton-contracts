// Shared setup for the ChatPool / DistributorMaster security regressions.
//
// A pool is always deployed and initialised by a real DistributorMaster
// (CreatePool -> InitPool), its admin is set with a backend-signed SetAdmin,
// and a jetton is registered the TEP-89 way: the admin sends RegisterJetton,
// the pool asks the jetton master (provide_wallet_address) and registers the
// wallet from the master's take_wallet_address reply.
import { Blockchain, BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import {
    ChatPool,
    storeAdminInitVoucher,
    storeAdminProposalVoucher,
    storeClaimVoucher,
    storeDepositVoucher,
    storeJettonTransfer,
} from '../../wrappers/ChatPool';
import { DistributorMaster } from '../../wrappers/DistributorMaster';
import { globalIdOf, signatureCell, signVoucher, TAG } from './vouchers';

export const CHAT_ID = -1001234567890n;
// A fixed clock: boundary tests move it explicitly.
export const T0 = 1_800_000_000;
export const DAY = 86400;

export const OP = {
    JettonTransfer: 0x0f8a7ea5,
    ProvideWalletAddress: 0x2c76b973,
    TakeWalletAddress: 0xd1735400,
    Excesses: 0xd53276db,
};
export const QUERY = {
    WithdrawTracked: 0x8000000000000001n,
    SweepUntracked: 0x8000000000000002n,
    Refund: 0x8000000000000003n,
};

export const pubKey = (kp: KeyPair) => BigInt('0x' + kp.publicKey.toString('hex'));
export const BACKEND = keyPairFromSeed(Buffer.alloc(32, 7));
export const OTHER_KEY = keyPairFromSeed(Buffer.alloc(32, 9));

export interface PoolEnv {
    bc: Blockchain;
    globalId: number;
    owner: SandboxContract<TreasuryContract>;
    admin: SandboxContract<TreasuryContract>;
    user: SandboxContract<TreasuryContract>;
    master: SandboxContract<DistributorMaster>;
    pool: SandboxContract<ChatPool>;
}

export async function deployMaster(bc: Blockchain, owner: SandboxContract<TreasuryContract>, key = pubKey(BACKEND)) {
    const master = bc.openContract(await DistributorMaster.fromInit(owner.address, key));
    const r = await master.send(owner.getSender(), { value: toNano('0.5') }, { $$type: 'Deploy', queryId: 0n });
    expectTx(r, { to: master.address, success: true });
    return master;
}

// Master + pool (created and initialised by the master) + admin.
export async function setupPool(opts: { withAdmin?: boolean } = {}): Promise<PoolEnv> {
    const bc = await Blockchain.create();
    bc.now = T0;
    const owner = await bc.treasury('owner');
    const admin = await bc.treasury('admin');
    const user = await bc.treasury('user');
    const master = await deployMaster(bc, owner);
    const created = await master.send(
        admin.getSender(),
        { value: toNano('0.3') },
        { $$type: 'CreatePool', chatId: CHAT_ID },
    );
    const poolAddress = await master.getPoolAddress(CHAT_ID);
    expectTx(created, { from: master.address, to: poolAddress, success: true });
    const pool = bc.openContract(ChatPool.fromAddress(poolAddress));
    const env: PoolEnv = { bc, globalId: globalIdOf(bc), owner, admin, user, master, pool };
    if (opts.withAdmin !== false) {
        const r = await setAdmin(env, admin, admin.address);
        expectTx(r, { to: pool.address, success: true });
    }
    return env;
}

export function now(env: { bc: Blockchain }): number {
    return env.bc.now ?? Math.floor(Date.now() / 1000);
}

export function setAdminMsg(env: PoolEnv, newAdmin: Address, kp: KeyPair = BACKEND) {
    const v = beginCell()
        .store(
            storeAdminInitVoucher({
                $$type: 'AdminInitVoucher',
                chatId: CHAT_ID,
                master: env.master.address,
                admin: newAdmin,
                expiry: BigInt(now(env) + 900),
            }),
        )
        .endCell();
    return {
        $$type: 'SetAdmin' as const,
        voucherCell: v,
        signature: signatureCell(signVoucher(v, kp, TAG.Admin, env.pool.address, env.globalId)),
    };
}

export function setAdmin(env: PoolEnv, from: SandboxContract<TreasuryContract>, newAdmin: Address) {
    return env.pool.send(from.getSender(), { value: toNano('0.05') }, setAdminMsg(env, newAdmin));
}

export function proposeAdminMsg(
    env: PoolEnv,
    newAdmin: Address,
    seq: bigint,
    opts: { kp?: KeyPair; expiry?: bigint; tag?: bigint } = {},
) {
    const v = beginCell()
        .store(
            storeAdminProposalVoucher({
                $$type: 'AdminProposalVoucher',
                chatId: CHAT_ID,
                newAdmin,
                seq,
                expiry: opts.expiry ?? BigInt(now(env) + 900),
            }),
        )
        .endCell();
    return {
        $$type: 'ProposeAdmin' as const,
        voucherCell: v,
        signature: signatureCell(
            signVoucher(v, opts.kp ?? BACKEND, opts.tag ?? TAG.AdminProposal, env.pool.address, env.globalId),
        ),
    };
}

// The v3 deposit voucher: int64 chatId, address jettonMaster, uint64 expiry,
// ref-wrapped with its signature the way stock wallets forward it.
export function depositPayload(
    env: PoolEnv,
    jettonMaster: Address,
    opts: { kp?: KeyPair; expiry?: bigint; chatId?: bigint; tag?: bigint } = {},
): Cell {
    const v = beginCell()
        .store(
            storeDepositVoucher({
                $$type: 'DepositVoucher',
                chatId: opts.chatId ?? CHAT_ID,
                jettonMaster,
                expiry: opts.expiry ?? BigInt(now(env) + 3600),
            }),
        )
        .endCell();
    const sig = signVoucher(v, opts.kp ?? BACKEND, opts.tag ?? TAG.Deposit, env.pool.address, env.globalId);
    return beginCell().storeUint(1, 1).storeRef(beginCell().storeRef(v).storeBuffer(sig).endCell()).endCell();
}

export function claimMsg(
    env: PoolEnv,
    args: {
        jettonMaster: Address;
        amount: bigint;
        nonce: bigint;
        recipient?: Address;
        expiry?: bigint;
        kp?: KeyPair;
    },
) {
    const v = beginCell()
        .store(
            storeClaimVoucher({
                $$type: 'ClaimVoucher',
                chatId: CHAT_ID,
                recipient: args.recipient ?? env.user.address,
                jettonMaster: args.jettonMaster,
                amount: args.amount,
                nonce: args.nonce,
                expiry: args.expiry ?? BigInt(now(env) + 3600),
            }),
        )
        .endCell();
    return {
        $$type: 'Claim' as const,
        voucherCell: v,
        signature: signatureCell(signVoucher(v, args.kp ?? BACKEND, TAG.Claim, env.pool.address, env.globalId)),
    };
}

export function claim(env: PoolEnv, args: Parameters<typeof claimMsg>[1], value = toNano('0.15')) {
    return env.pool.send(env.user.getSender(), { value }, claimMsg(env, args));
}

// The outbound provide_wallet_address the pool sent to `jettonMaster`.
export function provideWalletQuery(res: SendMessageResult, pool: Address, jettonMaster: Address) {
    for (const tx of res.transactions) {
        const m = tx.inMessage;
        if (!m || m.info.type !== 'internal') continue;
        if (!m.info.src.equals(pool) || !m.info.dest.equals(jettonMaster)) continue;
        const s = m.body.beginParse();
        if (s.remainingBits < 32 || s.loadUint(32) !== OP.ProvideWalletAddress) continue;
        const queryId = s.loadUintBig(64);
        const owner = s.loadAddress();
        const includeAddress = s.loadBit();
        return { queryId, owner, includeAddress };
    }
    return null;
}

// take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress owner_address:(Maybe ^MsgAddress)
export function takeWalletAddressBody(queryId: bigint, wallet: Address | null): Cell {
    const b = beginCell().storeUint(OP.TakeWalletAddress, 32).storeUint(queryId, 64);
    if (wallet) b.storeAddress(wallet);
    else b.storeUint(0, 2);
    return b.storeMaybeRef(null).endCell();
}

// RegisterJetton for a jetton master played by a treasury: the test answers
// the pool's TEP-89 request with `wallet`.
export async function registerJetton(
    env: PoolEnv,
    jettonMaster: SandboxContract<TreasuryContract>,
    wallet: Address,
    from: SandboxContract<TreasuryContract> = env.admin,
) {
    const req = await env.pool.send(
        from.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RegisterJetton', jettonMaster: jettonMaster.address },
    );
    const q = provideWalletQuery(req, env.pool.address, jettonMaster.address);
    if (!q) return { req, reply: null };
    const reply = await jettonMaster.send({
        to: env.pool.address,
        value: toNano('0.05'),
        body: takeWalletAddressBody(q.queryId, wallet),
    });
    return { req, reply };
}

// A JettonTransferNotification as the pool's jetton wallet (a treasury) sends it.
export function notify(
    env: PoolEnv,
    wallet: SandboxContract<TreasuryContract>,
    args: { amount: bigint; sender: Address; forwardPayload: Cell; value?: bigint },
) {
    return env.pool.send(
        wallet.getSender(),
        { value: args.value ?? toNano('0.15') },
        {
            $$type: 'JettonTransferNotification',
            queryId: 0n,
            amount: args.amount,
            sender: args.sender,
            forwardPayload: args.forwardPayload,
        },
    );
}

// The bounce a jetton wallet emits for a rejected JettonTransfer: 0xffffffff
// followed by the first 256 bits of the original body.
export function bouncedTransferBody(queryId: bigint, amount: bigint, to: Address): Cell {
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
                forwardPayload: beginCell().storeUint(0, 1).endCell(),
            }),
        )
        .endCell();
    return beginCell().storeUint(0xffffffff, 32).storeBits(t.beginParse().loadBits(256)).endCell();
}

// The pool's outbound JettonTransfers in a result, decoded.
export function jettonTransfersFrom(res: SendMessageResult, pool: Address) {
    const out: {
        to: Address;
        value: bigint;
        queryId: bigint;
        amount: bigint;
        destination: Address;
        responseDestination: Address | null;
    }[] = [];
    for (const tx of res.transactions as BlockchainTransaction[]) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type !== 'internal' || !m.info.src.equals(pool)) continue;
            const s = m.body.beginParse();
            if (s.remainingBits < 32 || s.loadUint(32) !== OP.JettonTransfer) continue;
            out.push({
                to: m.info.dest,
                value: m.info.value.coins,
                queryId: s.loadUintBig(64),
                amount: s.loadCoins(),
                destination: s.loadAddress(),
                responseDestination: s.loadMaybeAddress(),
            });
        }
    }
    return out;
}

export function expectTx(res: SendMessageResult, match: Record<string, unknown>) {
    expect(res.transactions).toHaveTransaction(match);
}

// Exit code of a require() message, from the contract's ABI.
export function errorCode(contract: { abi: { errors?: Record<string, { message: string }> } }, message: string) {
    const hit = Object.entries(contract.abi.errors ?? {}).find(([, e]) => e.message === message);
    if (!hit) throw new Error(`no error "${message}" in the ABI`);
    return Number(hit[0]);
}

export async function tonBalance(bc: Blockchain, a: Address) {
    return (await bc.getContract(a)).balance;
}

export async function storageUsed(bc: Blockchain, a: Address) {
    const s = (await bc.getContract(a)).account.account!.storageStats.used;
    return { cells: Number(s.cells), bits: Number(s.bits) };
}

// Mainnet basechain storage prices (config param 18): bit_price_ps = 1,
// cell_price_ps = 500, in 2^-16 nanoTON per second.
export function rentPerYear(used: { cells: number; bits: number }): bigint {
    return BigInt(Math.ceil(((used.bits * 1 + used.cells * 500) / 65536) * 365 * DAY));
}
