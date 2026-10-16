import { Blockchain } from '@ton/sandbox';
import { Address, beginCell, Builder, Cell, Dictionary, Slice } from '@ton/core';
import { sha256_sync } from '@ton/crypto';

// TEP-74 / TEP-89 wire format, built by hand so the tests speak the standard
// and not the Tact bindings: the same bodies drive TestJettonWallet and the
// production wallets in tests/helpers/realJettonWallets.ts.

export const OP = {
    transfer: 0x0f8a7ea5,
    internalTransfer: 0x178d4519,
    transferNotification: 0x7362d09c,
    excesses: 0xd53276db,
    burn: 0x595f07bc,
    burnNotification: 0x7bdd97de,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    // TestJettonMinter only (not part of TEP-74)
    mint: 0x4d494e54,
    changeOwner: 0x819dbe99,
};

// Exit codes of the reference TEP-74 wallet (token-contract ft/jetton-wallet.fc),
// which TestJettonWallet reuses so both can be compared one to one.
export const WALLET_EXIT = {
    notOwner: 705,
    balanceTooLow: 706,
    untrustedSender: 707, // also "burn value too low" in the reference wallet
    badForwardPayload: 708,
    valueTooLow: 709,
};

export const MAX_COINS = (1n << 120n) - 1n;

// forward_payload:(Either Cell ^Cell) is appended as-is, so tests can also
// build malformed payloads (e.g. an empty one, without the Either bit).
function storeRaw(b: Builder, payload: Cell | Slice): Builder {
    return b.storeSlice(payload instanceof Cell ? payload.beginParse() : payload);
}

export function transferBody(args: {
    queryId?: bigint;
    amount: bigint;
    destination: Address;
    responseDestination: Address | null;
    customPayload?: Cell | null;
    forwardTonAmount: bigint;
    forwardPayload: Cell;
}): Cell {
    return storeRaw(
        beginCell()
            .storeUint(OP.transfer, 32)
            .storeUint(args.queryId ?? 0n, 64)
            .storeCoins(args.amount)
            .storeAddress(args.destination)
            .storeAddress(args.responseDestination)
            .storeMaybeRef(args.customPayload ?? null)
            .storeCoins(args.forwardTonAmount),
        args.forwardPayload,
    ).endCell();
}

// What a jetton master sends to mint into a wallet (and what wallets send
// each other). `from` is the previous owner, or the master for a mint.
export function internalTransferBody(args: {
    queryId?: bigint;
    amount: bigint;
    from: Address;
    responseDestination: Address | null;
    forwardTonAmount?: bigint;
    forwardPayload?: Cell;
}): Cell {
    return storeRaw(
        beginCell()
            .storeUint(OP.internalTransfer, 32)
            .storeUint(args.queryId ?? 0n, 64)
            .storeCoins(args.amount)
            .storeAddress(args.from)
            .storeAddress(args.responseDestination)
            .storeCoins(args.forwardTonAmount ?? 0n),
        args.forwardPayload ?? beginCell().storeBit(false).endCell(),
    ).endCell();
}

export function burnBody(args: {
    queryId?: bigint;
    amount: bigint;
    responseDestination: Address | null;
    customPayload?: Cell | null;
}): Cell {
    return beginCell()
        .storeUint(OP.burn, 32)
        .storeUint(args.queryId ?? 0n, 64)
        .storeCoins(args.amount)
        .storeAddress(args.responseDestination)
        .storeMaybeRef(args.customPayload ?? null)
        .endCell();
}

export function burnNotificationBody(args: {
    queryId?: bigint;
    amount: bigint;
    sender: Address;
    responseDestination: Address | null;
}): Cell {
    return beginCell()
        .storeUint(OP.burnNotification, 32)
        .storeUint(args.queryId ?? 0n, 64)
        .storeCoins(args.amount)
        .storeAddress(args.sender)
        .storeAddress(args.responseDestination)
        .endCell();
}

// TestJettonMinter's owner-only mint (layout is this project's, not TEP-74).
export function mintBody(args: { queryId?: bigint; amount: bigint; recipient: Address }): Cell {
    return beginCell()
        .storeUint(OP.mint, 32)
        .storeUint(args.queryId ?? 0n, 64)
        .storeCoins(args.amount)
        .storeAddress(args.recipient)
        .endCell();
}

// TEP-89. `owner` may be a raw MsgAddress slice to test unresolvable owners.
export function provideWalletAddressBody(args: {
    queryId?: bigint;
    owner: Address | Slice;
    includeAddress: boolean;
}): Cell {
    const b = beginCell()
        .storeUint(OP.provideWalletAddress, 32)
        .storeUint(args.queryId ?? 0n, 64);
    if (args.owner instanceof Address) b.storeAddress(args.owner);
    else b.storeSlice(args.owner);
    return b.storeBit(args.includeAddress).endCell();
}

export function changeOwnerBody(newOwner: Address, queryId = 0n): Cell {
    return beginCell().storeUint(OP.changeOwner, 32).storeUint(queryId, 64).storeAddress(newOwner).endCell();
}

export interface TransferNotification {
    queryId: bigint;
    amount: bigint;
    from: Address | null;
    forwardPayload: Cell; // the Either, verbatim (bits and refs)
}

export function parseTransferNotification(body: Cell): TransferNotification {
    const s = body.beginParse();
    if (s.loadUint(32) !== OP.transferNotification) throw new Error('not a transfer_notification');
    const queryId = s.loadUintBig(64);
    const amount = s.loadCoins();
    const from = s.loadMaybeAddress();
    return { queryId, amount, from, forwardPayload: beginCell().storeSlice(s).endCell() };
}

export function parseInternalTransfer(body: Cell) {
    const s = body.beginParse();
    if (s.loadUint(32) !== OP.internalTransfer) throw new Error('not an internal_transfer');
    return {
        queryId: s.loadUintBig(64),
        amount: s.loadCoins(),
        from: s.loadMaybeAddress(),
        responseDestination: s.loadMaybeAddress(),
        forwardTonAmount: s.loadCoins(),
        forwardPayload: beginCell().storeSlice(s).endCell(),
    };
}

export interface WalletData {
    balance: bigint;
    owner: Address;
    master: Address;
    walletCode: Cell;
}

// get_wallet_data (TEP-74): balance, owner, master, wallet code.
export async function getWalletData(blockchain: Blockchain, wallet: Address): Promise<WalletData> {
    const r = await blockchain.runGetMethod(wallet, 'get_wallet_data');
    if (r.exitCode !== 0) throw new Error(`get_wallet_data exited with ${r.exitCode}`);
    const s = r.stackReader;
    return { balance: s.readBigNumber(), owner: s.readAddress(), master: s.readAddress(), walletCode: s.readCell() };
}

// Jetton balance from get_wallet_data; 0 for a wallet that is not deployed.
export async function jettonBalance(blockchain: Blockchain, wallet: Address): Promise<bigint> {
    const state = await blockchain.getContract(wallet);
    if (state.accountState?.type !== 'active') return 0n;
    return (await getWalletData(blockchain, wallet)).balance;
}

export interface JettonData {
    totalSupply: bigint;
    mintable: boolean;
    admin: Address | null;
    content: Cell;
    walletCode: Cell;
}

// get_jetton_data (TEP-74): total supply, mintable, admin, content, wallet code.
export async function getJettonData(blockchain: Blockchain, master: Address): Promise<JettonData> {
    const r = await blockchain.runGetMethod(master, 'get_jetton_data');
    if (r.exitCode !== 0) throw new Error(`get_jetton_data exited with ${r.exitCode}`);
    expectStackDepth(r.stack.length, 5);
    const s = r.stackReader;
    return {
        totalSupply: s.readBigNumber(),
        mintable: s.readBigNumber() !== 0n,
        admin: s.readAddressOpt(),
        content: s.readCell(),
        walletCode: s.readCell(),
    };
}

function expectStackDepth(actual: number, expected: number) {
    if (actual !== expected) throw new Error(`getter returned ${actual} stack entries, expected ${expected}`);
}

// TEP-64 on-chain content: 0x00 + HashmapE(sha256(key) -> 0x00 snake text).
// Throws if the cell is not on-chain TEP-64 metadata.
export function parseOnchainContent(content: Cell): Record<string, string> {
    const s = content.beginParse();
    const tag = s.loadUint(8);
    if (tag !== 0) throw new Error(`content tag 0x${tag.toString(16)} is not TEP-64 on-chain (0x00)`);
    const dict = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    if (s.remainingBits !== 0 || s.remainingRefs !== 0) throw new Error('trailing data after the TEP-64 dict');
    const out: Record<string, string> = {};
    for (const key of ['name', 'symbol', 'decimals', 'description', 'image', 'uri']) {
        const v = dict.get(BigInt('0x' + sha256_sync(key).toString('hex')));
        if (!v) continue;
        const vs = v.beginParse();
        if (vs.loadUint(8) !== 0) throw new Error(`${key}: only snake (0x00) values are supported here`);
        out[key] = vs.loadStringTail();
    }
    return out;
}

export function buildOnchainContent(fields: Record<string, string>): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [key, value] of Object.entries(fields)) {
        dict.set(
            BigInt('0x' + sha256_sync(key).toString('hex')),
            beginCell().storeUint(0, 8).storeStringTail(value).endCell(),
        );
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}
