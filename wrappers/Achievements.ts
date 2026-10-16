import { Address, beginCell, Cell } from '@ton/core';
import {
    storeMintAchievement,
    storeMintVoucher,
    storeRegisterTemplate,
    storeRegisterVoucher,
} from './AchievementRegistry';

// Off-chain mirror of the achievement SBT derivations in
// contracts/achievement_messages.tact. The miniapp has the same in
// src/lib/ton/achievement-tags.js (tests/AchievementRegistry.spec.ts checks
// both against the registry's getters).

// chatTag of a platform-wide template (one that belongs to no chat). Real
// chat tags are HMAC-SHA256 outputs and never 0.
export const PLATFORM_CHAT_TAG = 0n;

// Content URL bounds the registry enforces: one cell, whole bytes.
export const CONTENT_URL_MIN_BYTES = 8;
export const CONTENT_URL_MAX_BYTES = 126;
// The longest a voucher may live (the registry's MaxVoucherTtl).
export const MAX_VOUCHER_TTL = 86400;

const big = (b: Buffer) => BigInt('0x' + b.toString('hex'));

// templateKey = hash(uint256 chatTag ++ uint256 contentHash)
export function templateKeyOf(chatTag: bigint, contentHash: bigint): bigint {
    return big(beginCell().storeUint(chatTag, 256).storeUint(contentHash, 256).endCell().hash());
}

// item index = hash(uint256 templateKey ++ uint256 userTag)
export function itemIndexOf(templateKey: bigint, userTag: bigint): bigint {
    return big(beginCell().storeUint(templateKey, 256).storeUint(userTag, 256).endCell().hash());
}

// The URL cell a RegisterVoucher carries, checked the way the registry
// checks it (scheme and length). Which https hosts are acceptable is a
// policy of whoever signs: pass `allowedHttpsPrefixes` to enforce it.
export function contentUrlCell(url: string, allowedHttpsPrefixes?: string[]): Cell {
    const bytes = Buffer.from(url, 'utf8');
    if (bytes.length < CONTENT_URL_MIN_BYTES || bytes.length > CONTENT_URL_MAX_BYTES) {
        throw new Error(`content url must be ${CONTENT_URL_MIN_BYTES}-${CONTENT_URL_MAX_BYTES} bytes: ${url}`);
    }
    if (url.startsWith('https://')) {
        if (allowedHttpsPrefixes && !allowedHttpsPrefixes.some((p) => url.startsWith(p))) {
            throw new Error(`content url host is not allowed: ${url}`);
        }
    } else if (!url.startsWith('ipfs://')) {
        throw new Error(`content url must be https:// or ipfs://: ${url}`);
    }
    return beginCell().storeBuffer(bytes).endCell();
}

// TEP-64 off-chain content cell (0x01 + URL), as templates and items store it.
export function offchainContent(url: string): Cell {
    return beginCell().storeUint(1, 8).storeBuffer(Buffer.from(url, 'utf8')).endCell();
}

export function registerVoucherCell(v: {
    chatTag: bigint;
    registrant: Address;
    contentHash: bigint;
    expiry: bigint;
    contentUrl: string;
    allowedHttpsPrefixes?: string[];
}): Cell {
    return beginCell()
        .store(
            storeRegisterVoucher({
                $$type: 'RegisterVoucher',
                chatTag: v.chatTag,
                registrant: v.registrant,
                contentHash: v.contentHash,
                expiry: v.expiry,
                contentUrl: contentUrlCell(v.contentUrl, v.allowedHttpsPrefixes),
            }),
        )
        .endCell();
}

export function mintVoucherCell(v: { templateKey: bigint; recipient: Address; userTag: bigint; expiry: bigint }): Cell {
    return beginCell()
        .store(storeMintVoucher({ $$type: 'MintVoucher', ...v }))
        .endCell();
}

export function registerTemplateBody(voucherCell: Cell, signature: Buffer): Cell {
    return beginCell()
        .store(
            storeRegisterTemplate({
                $$type: 'RegisterTemplate',
                voucherCell,
                signature: beginCell().storeBuffer(signature).endCell(),
            }),
        )
        .endCell();
}

export function mintAchievementBody(voucherCell: Cell, signature: Buffer): Cell {
    return beginCell()
        .store(
            storeMintAchievement({
                $$type: 'MintAchievement',
                voucherCell,
                signature: beginCell().storeBuffer(signature).endCell(),
            }),
        )
        .endCell();
}
