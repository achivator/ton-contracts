// The achievement SBT wire formats, spelled out by hand: opcodes, voucher
// layouts, message bodies and the key/index derivations. Deliberately
// independent of the generated wrappers, so the regression tests pin the
// formats themselves (and ran, failing, against the pre-SBT contracts).
import { Address, beginCell, Builder, Cell, Dictionary, Slice, TupleBuilder, TupleReader } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { KeyPair, sign } from '@ton/crypto';
import { createHmac } from 'crypto';

export const OP = {
    // TEP-62
    Transfer: 0x5fcc3d14,
    Excesses: 0xd53276db,
    GetStaticData: 0x2fcb26a2,
    ReportStaticData: 0x8b771735,
    // TEP-85
    ProveOwnership: 0x04ded148,
    OwnershipProof: 0x0524c7ae,
    RequestOwner: 0xd0c3bfea,
    OwnerInfo: 0x0dd607e3,
    Destroy: 0x1f04537a,
    Revoke: 0x6f89f5e3,
    // registry
    RegisterTemplate: 0xac4e0001,
    MintAchievement: 0xf7b315f8,
    TemplateInit: 0xac4e0002,
    TemplateMintRequest: 0xac4e0003,
    TemplateMintApproved: 0xac4e0004,
    RotateBackendKey: 0xac4e0005,
    SetPaused: 0xac4e0006,
    ProposeOwner: 0xac4e0007,
    AcceptOwnership: 0xac4e0008,
    RevokeAchievement: 0xac4e0009,
    // events
    TemplateRegistered: 0xac4e0010,
};

export const TAG = { Register: 0x52454731n, Mint: 0x4d4e5431n };

// v3 envelope: uint32 tag, int32 globalId, address target, ^voucher.
export function signFor(voucher: Cell, kp: KeyPair, tag: bigint, target: Address, globalId: number): Buffer {
    const envelope = beginCell()
        .storeUint(tag, 32)
        .storeInt(globalId, 32)
        .storeAddress(target)
        .storeRef(voucher)
        .endCell();
    return sign(envelope.hash(), kp.secretKey);
}

const big = (b: Buffer) => BigInt('0x' + b.toString('hex'));

// The backend's privacy tags: HMAC-SHA256(tagKey, "user:<id>" | "chat:<id>").
export function tagOf(key: Buffer, kind: 'user' | 'chat', id: bigint | number): bigint {
    return big(createHmac('sha256', key).update(`${kind}:${id}`).digest());
}

// templateKey = hash(uint256 chatTag ++ uint256 contentHash)
export function templateKeyOf(chatTag: bigint, contentHash: bigint): bigint {
    return big(beginCell().storeUint(chatTag, 256).storeUint(contentHash, 256).endCell().hash());
}

// item index = hash(uint256 templateKey ++ uint256 userTag)
export function itemIndexOf(templateKey: bigint, userTag: bigint): bigint {
    return big(beginCell().storeUint(templateKey, 256).storeUint(userTag, 256).endCell().hash());
}

export function urlCell(url: string): Cell {
    return beginCell().storeBuffer(Buffer.from(url)).endCell();
}

// RegisterVoucher: uint256 chatTag, address registrant, uint256 contentHash,
// uint64 expiry, ^contentUrl
export function registerVoucher(v: {
    chatTag: bigint;
    registrant: Address;
    contentHash: bigint;
    expiry: bigint;
    url: Cell;
}): Cell {
    return beginCell()
        .storeUint(v.chatTag, 256)
        .storeAddress(v.registrant)
        .storeUint(v.contentHash, 256)
        .storeUint(v.expiry, 64)
        .storeRef(v.url)
        .endCell();
}

// MintVoucher: uint256 templateKey, address recipient, uint256 userTag, uint64 expiry
export function mintVoucher(v: { templateKey: bigint; recipient: Address; userTag: bigint; expiry: bigint }): Cell {
    return beginCell()
        .storeUint(v.templateKey, 256)
        .storeAddress(v.recipient)
        .storeUint(v.userTag, 256)
        .storeUint(v.expiry, 64)
        .endCell();
}

// RegisterTemplate / MintAchievement: op, ^voucher, 512-bit signature inline
export function signedBody(op: number, voucher: Cell, signature: Buffer): Cell {
    return beginCell().storeUint(op, 32).storeRef(voucher).storeBuffer(signature).endCell();
}

export function opBody(op: number, fill?: (b: Builder) => Builder): Cell {
    const b = beginCell().storeUint(op, 32);
    return (fill ? fill(b) : b).endCell();
}

// TEP-64 off-chain content: 0x01 + URL
export function offchainContent(url: string): Cell {
    return beginCell().storeUint(1, 8).storeBuffer(Buffer.from(url)).endCell();
}

export async function getter(bc: Blockchain, address: Address, name: string, args: (bigint | Cell)[] = []) {
    const tb = new TupleBuilder();
    for (const a of args) {
        if (typeof a === 'bigint') tb.writeNumber(a);
        else tb.writeCell(a);
    }
    const res = await bc.provider(address).get(name, tb.build());
    return res.stack as TupleReader;
}

export async function accountCells(bc: Blockchain, a: Address): Promise<{ cells: bigint; bits: bigint }> {
    const acc = (await bc.getContract(a)).account.account;
    if (!acc) return { cells: 0n, bits: 0n };
    return acc.storageStats.used;
}

export async function isActive(bc: Blockchain, a: Address): Promise<boolean> {
    return (await bc.getContract(a)).accountState?.type === 'active';
}

// Every bit of a cell tree, depth first, as a string of 0/1 per cell.
function cellBitStrings(c: Cell, out: string[] = [], seen = new Set<string>()): string[] {
    const h = c.hash().toString('hex');
    if (seen.has(h)) return out;
    seen.add(h);
    const s = c.beginParse(true);
    let bits = '';
    while (s.remainingBits > 0) bits += s.loadBit() ? '1' : '0';
    out.push(bits);
    for (const r of c.refs) cellBitStrings(r, out, seen);
    return out;
}

// Whether `value` appears, as a 64-bit two's complement integer, anywhere in
// the bits of `c` (any cell of the tree, at any bit offset).
export function containsInt64(c: Cell, value: bigint): boolean {
    const pattern = BigInt.asUintN(64, value).toString(2).padStart(64, '0');
    return cellBitStrings(c).some((bits) => bits.includes(pattern));
}

export function loadMaybeRef(s: Slice): Cell | null {
    return s.loadBit() ? s.loadRef() : null;
}

// Sets config param 18 (storage prices) to one entry, for all time.
export function setStoragePrices(
    bc: Blockchain,
    p: { bitPs: bigint; cellPs: bigint; mcBitPs: bigint; mcCellPs: bigint },
) {
    const config = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), bc.config);
    const prices = Dictionary.empty(Dictionary.Keys.Uint(32), {
        serialize: (v: Cell, b: Builder) => b.storeSlice(v.beginParse()),
        parse: (s: Slice) => s.asCell(),
    });
    prices.set(
        0,
        beginCell()
            .storeUint(0xcc, 8)
            .storeUint(0, 32)
            .storeUint(p.bitPs, 64)
            .storeUint(p.cellPs, 64)
            .storeUint(p.mcBitPs, 64)
            .storeUint(p.mcCellPs, 64)
            .endCell(),
    );
    config.set(18, beginCell().storeDictDirect(prices).endCell());
    bc.setConfig(beginCell().storeDictDirect(config).endCell());
}
