# Security review: ton-contracts (2026-10-06)

**Scope:** every contract in `contracts/` as of `dc4ddce` (Tact 1.2.0). One reviewer per contract went through it line by line, and each checked the generated FunC in `build/`.

| Contract | File | Role |
|---|---|---|
| ChatPool | `contracts/chat_pool.tact` | Per-chat jetton custody: deposits, backend-signed claims, admin withdrawals |
| DistributorMaster | `contracts/distributor_master.tact` | Factory for ChatPools; holds the backend key used for new pools |
| AchievementRegistry | `contracts/achievement_registry.tact` | TEP-62 collection: templates and backend-signed mints |
| AchievementItem | `contracts/achievement_item.tact` | TEP-62 NFT item |
| TestJettonMinter | `contracts/test_jetton.tact:33-77` | Testnet-only jetton master |
| TestJettonWallet | `contracts/test_jetton.tact:79-176` | Testnet-only jetton wallet |

Shared code: `voucher.tact` (the `SignedVoucher` envelope), `distributor_messages.tact` and `achievement_messages.tact`.

**Evidence:** 52 proof-of-concept sandbox tests in `tests/poc/*.poc.spec.ts`. Run them with `npm run test:poc`. Each test **passes while the issue exists**, so it should be inverted or deleted once the fix lands. The PoCs are kept out of the default `npm test`. The real-jetton comparisons embed the code BOCs of the upstream reference TEP-74 wallet (`ton-blockchain/token-contract`) and the USDT wallet (`ton-blockchain/stablecoin-contract`).

Status legend: **CONFIRMED** means a PoC demonstrates the issue. **THEORETICAL** means the issue was derived from the code or from measurements but not executed end to end.

---

## 1. Executive summary

1. **Critical: ChatPool cannot pay out real jettons.** Every outbound `JettonTransfer` that ChatPool sends has an empty `forward_payload`, with no `Either` bit (`chat_pool.tact:307`). The stock TEP-74 wallet rejects it with exit 708, and USDT rejects it with exit 9. Deposits are credited normally, but **every claim, withdrawal and deposit refund bounces**. The contracts are immutable, so jettons already in a pool are **locked permanently**. The test suite never caught this because `TestJettonWallet` and the treasury-as-wallet mocks never parse that field. If any pool on mainnet holds real jettons, treat this as an incident.
2. **High: AchievementRegistry will brick itself.** Per-mint state (`usedNonces` and `mintedUsers`) grows by about 2 cells per mint and is never pruned. When the account reaches the `max_acc_state_cells = 65536` limit, every mint and every registration fails with action code 50. That happens after about 31.5k mints *in total*. An attacker gets there for about 1.5 TON, because the URL length cap only follows `ref[0]` (AR-1) and a register voucher can be replayed (AR-3).
3. **High: deposits go to whoever holds the admin slot.** ChatPool accepts a deposit from anyone once *any* admin exists. Three ways the wrong party can hold that slot: a leaked backend key, a testnet voucher replayed on mainnet, or a Telegram ownership change (the old owner keeps the slot for good). In each case, the chat creator's deposits can be withdrawn by that party.
4. **Systemic: vouchers are not bound to a network.** The comment in `voucher.tact` says a key may be shared between testnet and mainnet. With the same owner mnemonic (v4 wallet) and the same key, the master, every pool and the registry get **identical addresses on both networks**, so testnet vouchers verify on mainnet.
5. **Systemic: key rotation is incomplete.** `DistributorMaster.RotateBackendKey` changes `poolAddress()` for every chat, so the miniapp loses sight of every existing pool exactly during an incident. Existing pools keep the leaked key until each admin rotates it by hand. The registry cannot rotate its key at all.

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 13 |
| Low | 20 |
| Info | ~20 |

---

## 2. Consolidated findings

IDs are prefixed by contract: CP = ChatPool, DM = DistributorMaster, AR = AchievementRegistry, AI = AchievementItem, TJM = TestJettonMinter, TJW = TestJettonWallet. X = cross-contract. Where several reviewers found the same root cause, it is merged into one X finding.

### Critical

| ID | Title | Location | Status |
|---|---|---|---|
| **X-1** (TJW-6) | ChatPool's outbound `JettonTransfer` has no `Either` bit in `forward_payload`, so standard and USDT wallets reject it and pool funds are locked | `chat_pool.tact:307` (`forwardPayload: emptySlice()`); masked by `test_jetton.tact:141-163` and `tests/Distributor.spec.ts:723,914,941` | CONFIRMED |

The PoC (`TestJettonWallet.poc.spec.ts`, "TJW-6") runs the same ChatPool claim and WithdrawRemainder against three wallets:

- **Reference wallet:** bounces with 708 (`slice_bits(either_forward_payload) >= 1`).
- **USDT wallet:** bounces with 9 (`check_either_forward_payload`).
- **TestJettonWallet (control):** succeeds.

With a single `0` bit added, both real wallets accept the transfer even at the minimum claim value (about 0.048 TON forwarded).

**Impact:**
- `bounced()` restores the ledger, but nothing can ever leave the pool.
- `refundDeposit` (`QueryRefund`) bounces are ignored, so even mis-sent jettons are stuck.

**Fix:** `forwardPayload: beginCell().storeUint(0, 1).endCell().beginParse()`. Since the code is immutable, ship it as a new master with a migration path; see section 4.

Also harden `TestJettonWallet` so it rejects payloads without the bit, the way USDT does, and add a CI test against the vendored real-wallet BOCs.

### High

| ID | Title | Location | Status |
|---|---|---|---|
| **AR-2** | Registry state grows without bound, up to `max_acc_state_cells`; past that, every state-growing transaction fails with code 50, permanently | `achievement_registry.tact:34-36, 67, 138-140` | CONFIRMED |
| **AR-1** | `snakeCells` follows only `ref[0]`, so a `contentUrl` can carry about 8k hidden cells per registration (cheap brick; it also breaks `getTemplate()` in @ton/core) | `achievement_registry.tact:64, 174-182` | CONFIRMED |
| **CP-9** | Deposits are accepted from anyone once any admin is set, so whoever holds the slot (leaked key, X-2 replay, a stale Telegram owner) can withdraw the creator's deposits | `chat_pool.tact:101-110` | CONFIRMED |

**AR-2:**
- Measured growth is 2.06 cells per mint, which caps the whole product at about 31.5k mints.
- In the PoC an honest registration and 5 of 5 honest mints failed with code 50.
- Fix: derive uniqueness from the item address, e.g. `initOf AchievementItem(registry, templateId, tgUserId)`, so a re-mint hits an initialized item. Drop `usedNonces`, since expiry plus per-user uniqueness already suffice. Make the mint bounceable and roll back in `bounced`.

**AR-1:** the PoC reached 65,537 cells for 1.47 TON with *one* register voucher. Fix: require that every cell of `contentUrl` has at most 1 ref and a whole number of bytes, or require `refs()==0`, or store only a hash plus a slug.

**CP-9:**
- The code comment "No funds before an admin exists" assumes the depositor *is* the admin, but nothing on-chain enforces that.
- Fix: put the expected admin into `DepositVoucher` and require `self.admin == vAdmin`, or require `msg.sender == self.admin`. On the backend, issue deposit vouchers only to `poolAdmin`.

### Medium

| ID | Title | Location | Status |
|---|---|---|---|
| **X-2** (DM-1, CP-8, AR-4) | No network id in `SignedVoucher` or in contract init, so testnet and mainnet deployments share addresses and accept each other's vouchers | `voucher.tact:7-8, 28-35`; `distributor_master.tact:16-19`; `achievement_registry.tact:38-42` | CONFIRMED |
| **DM-2** | `RotateBackendKey` changes `poolAddress(chatId)` for every chat: existing pools disappear from the app, a second `CreatePool` deploys a duplicate pool, and existing pools keep the old key | `distributor_master.tact:56-58, 67-76` | CONFIRMED |
| **CP-1** | A leaked key can permanently register an attacker contract as the wallet of a jetton the pool hasn't received yet. That creates a phantom ledger, burns claims into the attacker contract, and makes all later real deposits refund | `chat_pool.tact:96-117` | CONFIRMED |
| **X-3** | ChatPool `usedNonces` has the same `max_acc_state_cells` ceiling as AR-2: about 2 cells per claim, so a busy pool stops accepting claims after about 30k (withdraw still works) | `chat_pool.tact:37, 189` | THEORETICAL (per-entry cost measured in CP-7) |
| **CP-10** | A bounce makes `isNonceUsed` go back to false, and the backend re-credits points at `expiry` with no finality margin, opening a double-payout race | `chat_pool.tact:255-256`; miniapp `lib/rewards.js:54-79` | THEORETICAL |
| **AR-3** | `RegisterVoucher` has no nonce, so one voucher registers unlimited templates until expiry (and enables AR-1) | `achievement_messages.tact:108-112` | CONFIRMED |
| **AR-5** | `templateId` is assigned at execution and `registerTemplates.ts` infers it from a count, so a racing registration can capture a platform template slot (with royalty up to 100/100 to the attacker) | `achievement_registry.tact:62-76`; `scripts/registerTemplates.ts:41,67-70` | CONFIRMED |
| **AR-6** | The registry cannot rotate its backend key and cannot be paused. A leaked key gives unlimited genuine-collection forgeries and lets the attacker permanently squat real users' (template, tgUserId) slots | `achievement_registry.tact:29, 38-42` | THEORETICAL |
| **AR-7 / AI-10** | `tgUserId` ↔ wallet ↔ chatId are public permanently (event, `isMinted` probe, `Template.chatId`) | `achievement_registry.tact:141-146, 210-213` | by inspection |
| **AI-3** | Achievements can be transferred and sold, so "holds the NFT" ≠ "earned it". `isMinted` stays true for the seller | `achievement_item.tact:53-72` | CONFIRMED |
| **AI-2 / AR-9** | Royalty is not discoverable via TEP-66: no `royalty_params` getter or `GetRoyaltyParams` responder on the collection, and the item getter is misnamed. Secondary sales pay 0% | `achievement_item.tact:108-144`; registry has none | CONFIRMED |
| **TJW-1 / TJW-3** | TestJettonWallet has no `bounced` handler, so tokens are destroyed when the receiver fails. No `forward_ton_amount` ≤ value check, so anyone can drain the TON the pool's wallet holds (+1.78 TON in the PoC) | `test_jetton.tact:106-110, 141-163` | CONFIRMED (testnet only) |
| **TJM-7 / TJW-5** | The integration has been validated only against this non-standard jetton: wrong notification payload shape, no gas checks, no `get_wallet_data` or `get_jetton_data`, so the miniapp flow can't even run with it | `tests/*`, `run-multi-actor-e2e.sh` | CONFIRMED |

**X-2 fix:** add `global_id` (`getConfigParam(19)`) to `SignedVoucher` and to every init. Forbid key and owner reuse across networks in the scripts. Correct the voucher.tact comment.

**DM-2 fix:** store the creation key per chat, or remove the key from the pool's init. Add a rotation runbook and a rotation script.

**CP-1 fix:** discover the wallet on-chain via TEP-89 `provide_wallet_address`, or use an admin-signed `RegisterJetton`. Add an admin reset for a jetton whose real balance is 0.

**CP-10 fix:** reconcile only at `expiry` plus a few minutes against a finalized masterchain block. Use a nonce that is never deleted and has a "bounced" state.

### Low

| ID | Title | Location |
|---|---|---|
| CP-3 | The daily cap resets at UTC midnight: about 19% of the pool drains within 2 s around the boundary (CONFIRMED) | `chat_pool.tact:181-186, 328-335` |
| CP-2 | `walletMasters` can be overwritten by a second master that points at the same wallet; real bounces then credit the alias ledger. Also reachable through a malicious jetton master's `get_wallet_address` (TJM blind spot) | `chat_pool.tact:96-100, 116, 250` |
| CP-5 | An oversized (untracked) withdrawal that bounces zeroes the ledger for good, and claims stop | `chat_pool.tact:235-237, 264-267` |
| CP-4 | A claim from yesterday that bounces after today's first claim lowers today's `daySpent` | `chat_pool.tact:257-262` |
| CP-6 | The day's budget is fixed at the first claim, so a 1-unit claim before a top-up pins the whole day's budget near 0 | `chat_pool.tact:182-183, 339-351` |
| CP-7 | A nonce entry costs 0.00049 TON/yr. The 0.002 TON fee covers about 4 years, not "never freezing" as the comment says | `chat_pool.tact:8-10` |
| CP-11 | Jettons sent to an unregistered pool wallet need a backend voucher to recover (contradicts "NEVER requires the backend"). An underfunded deposit refund strands the depositor's jettons | `chat_pool.tact:110-111, 230-231, 286-289` |
| DM-3 | After rotation, anyone can still deploy `ChatPool(master, chat, oldKey)` directly at its pre-rotation address and take its admin slot with the leaked key | `distributor_master.tact:67-69` |
| DM-4 | Owner is `Ownable`, not transferable; it is the hot scripts wallet | `distributor_master.tact:12` |
| DM-5 | `Deploy` refunds everything, so the master runs at 0 TON and accumulates storage debt until it freezes (~14 yr) | `distributor_master.tact:10-12, 36` |
| DM-6 | `RotateBackendKey` accepts 0 or the same key and has no two-step or timelock | `distributor_master.tact:56-58` |
| AR-8 | One-time rent prepayments cover about 5 years; the "never rents itself into freezing" comment is wrong | `achievement_registry.tact:7-12` |
| AI-1 | `ReportStaticData.index_id` is int257 instead of TEP-62 uint256, so strict on-chain verifiers misparse it | `achievement_messages.tact:45` |
| AI-4 | The transfer value floor ignores the forward fee, so the owner can drain the item's 0.02 TON reserve with large payloads | `achievement_item.tact:56, 59-69, 82` |
| AI-5 | No top-up receiver, and third-party top-ups get swept to the next `response_destination` | `achievement_item.tact:5, 82-91` |
| AI-9 / DM-8 | Contracts compiled inside the parent's unit have a different `get_abi_ipfs`, so the standalone wrappers (`AchievementItem.fromInit`, `ChatPool.fromInit`) compute **wrong addresses** and explorer verification fails | `wrappers/*`, `build/*` |
| TJM-1 / TJW-4 | The test jetton lacks `get_jetton_data`, `get_wallet_data` and TEP-89 | `test_jetton.tact` |
| TJM-2 | Minted supply can drift from wallet balances (non-bounceable mint, no burn accounting) | `test_jetton.tact:53, 66` |
| TJM-3 | Mint excess goes to the recipient. A ChatPool recipient traps it, since `Excesses` is unhandled there | `test_jetton.tact:59` |
| TJW-2 / TJW-8 | An underfunded transfer loses tokens. Trailing payload data is dropped. Excess goes to the owner when `response_destination` is null | `test_jetton.tact:104-128, 141-163` |

### Info (abridged)

- **ChatPool / master:**
  - The pool's TON can never leave (CP-13).
  - Admin rotation needs a backend voucher that the miniapp never issues, so a lost admin wallet cannot be recovered (CP-12).
  - Claim excess goes to the recipient, not the relayer (CP-14).
  - `CreatePool` is not idempotent, so repeat calls lose 0.1 TON (DM-7).
  - Anyone can create a pool for any chatId (DM-9).
  - Stale comment at `distributor_master.tact:24-25` (DM-10).
- **Registry and items:**
  - The mint deploys the item with `bounce:false` after state is committed (AR-11).
  - A front-runner can submit someone else's mint voucher (harmless; AR-12).
  - `usedNonces` in the registry is redundant (AR-13).
  - The registry owner is immutable (AR-14).
  - uint32 counters (AR-15).
  - No `Either` bit in the mint's `forward_payload` (AI-8).
  - No burn or revoke (AI-7).
  - Item metadata can change after mint, since the hash is never checked (AI-11).
- **Test jetton:**
  - Immutable owner (TJM-4).
  - Public template code (TJM-5).
  - No network guard on the deploy scripts (TJM-9, TJW-7).
  - Notification is bounceable (TJW-9).
  - Fixed 0.02 TON reserve (TJW-10).
  - Masterchain addresses rejected (TJW-11).
  - Zero-amount transfers allowed (TJW-12).

---

## 3. Line-by-line notes (condensed)

Line numbers are relative to each file. "OK" means the reviewer checked that range and found nothing.

### ChatPool (`chat_pool.tact`)
- **1-26 constants:** query constants are ≥ 2^63, while the nonce range is (0, 2^63), so there is no overlap. OK. Fee comment at 8-10 → CP-7.
- **28-50 storage/init:** anyone deploying the same parameters is harmless, and other parameters give a different address. Maps are never iterated. OK. `usedNonces` → X-3.
- **53 `receive()`:** accepts only an empty body (text comments throw 130). OK.
- **68-83 deposit parsing:** the two payload shapes are unambiguous. Pre-signature refunds go to `sender()`, and a forged notifier only messages itself. OK.
- **86-91:** wc0 std addresses, `endParse` (ENDS checks refs too). OK.
- **96-113:** wallet trust rests on the backend → CP-1. Reverse-map check missing → CP-2. Only `admin != null` checked → CP-9. `value < 0.02` gives an underfunded refund → CP-11.
- **115-120:** int257 arithmetic, so no overflow. `refundExcess` keeps the pre-message balance. OK.
- **128-151 SetAdmin:** domain separation OK, except the network → X-2. The voucher has no nonce but only the named wallet or the current admin can use it. OK. Rotation dependency → CP-12.
- **154-179 Claim checks:** signature, ENDS, chatId, expiry, nonce range, amount, replay, pause, gas floor of 0.052 TON. OK.
- **181-186 budget:** → CP-3, CP-6.
- **188-193:** if the action phase fails, the whole transaction rolls back atomically. The reserve keeps the balance plus 0.002, so there is no drain. OK.
- **197-221 admin controls:** `requireAdmin` correct. Replies use mode 64+2. OK.
- **226-243 withdraw:** → CP-5, CP-11.
- **249-270 bounce handler:** the source is gated by `walletMasters` and bounces can't be forged. Then → CP-10, CP-4, CP-5, CP-2.
- **275-290 refunds:** the reserve-then-mode-128 pattern is correct. Refunds use mode 64 → CP-11.
- **294-310 `sendJettons`:** **line 307 → X-1 (Critical).** Excess goes to the recipient → CP-14.
- **312-423 helpers/getters:** OK. `isNonceUsed` is not monotonic → CP-10. A default budget below 10 units rounds to 0 (Info).

### DistributorMaster (`distributor_master.tact`)
- **1-4:** importing ChatPool into this compilation unit → DM-8 (different code hash).
- **6-8:** constants OK; actual cost is about 0.0022 TON.
- **10-11:** comment is wrong → DM-5.
- **12:** non-transferable `Ownable` → DM-4. `Deployable` refunds the deploy value (mode 66) → DM-5.
- **16-19 init:** no network id → X-2.
- **22:** OK.
- **31-54 CreatePool:** the value floor is OK (exit 32292). The reserve keeps the master's prior balance exactly. Deploy uses mode 1 and `bounce:false` → DM-7. The refund (mode 130) is the last action. OK.
- **56-64 RotateBackendKey:** owner check OK (132) → DM-2, DM-6. Refund uses mode 66. OK.
- **67-76:** the address depends on the current key → DM-2, DM-3.
- **78-84:** OK. `version()=2` matches the pool and the miniapp.

### AchievementRegistry (`achievement_registry.tact`)
- **7-19 constants:** the economics math is OK, but the comment at 7-10 is wrong → AR-8. `MaxContentUrlCells` is ineffective → AR-1.
- **27-36 storage:** unbounded maps → AR-2.
- **38-42 init:** → X-2, AR-6.
- **45:** OK.
- **48-60 register:** the tag+address envelope is OK. Address parsing via `loadAddress` rejects masterchain (137). No nonce and no upper bound on expiry → AR-3.
- **62-63:** royalty divide-by-zero guard OK. 100% is allowed → AR-5/AR-9.
- **64:** → AR-1.
- **65:** value check OK.
- **67-76:** append-only. The id is assigned at execution → AR-5.
- **78, 154-159:** the reserve includes `ctx.value` correctly, so there is no drain. OK.
- **84-99 mint checks:** OK. The template's identity is not bound → AR-5.
- **103-104:** the `templateId·2^64 + (tgUserId & mask)` key is injective, so a double mint is impossible. OK.
- **106-119:** value floor and custom payload match the item's parser. Reserve before send. OK.
- **120-135:** sequential index, so an index can't be chosen; a pre-deployed item is harmless → AR-11.
- **137-147:** → AR-2.
- **151, 163-171:** mode 130 is the last action. OK.
- **174-182:** → AR-1.
- **185-240 getters:** OK. `isMinted` → AR-7. `get_nft_content` returns the full TEP-64 cell, which is correct.

### AchievementItem (`achievement_item.tact`)
- **1-9 constants:** reserve mode "at most" → AI-4/AI-5.
- **17-35 storage/init:** fits in one cell. Lazy-init data is checked against the address, so another deployer's init data is rejected. OK.
- **37-52 mint branch:** only the registry can initialize, and that can't happen twice. The unchecked parse of `custom_payload` is fine because only the registry reaches this branch. OK.
- **53-57:** owner check OK. Value floor → AI-4. `new_owner` not validated → AI-7.
- **58-70:** `OwnershipAssigned` matches the reference. Forward fee → AI-4. `Either` bit → AI-8.
- **71, 81-92:** send, then reserve, then mode 130, so it can't overdraw. OK. Sweeping third-party top-ups → AI-5.
- **94-121:** replies use mode 64, so the item can't be drained. Wire format → AI-1. Placement → AI-2.
- **123-144:** tuple order correct. Getter name → AI-2.

### TestJettonMinter (`test_jetton.tact:1-77`)
- **10-12:** `Deployable` harmless. `Ownable` → TJM-4.
- **15-31:** opcodes and layout match TEP-74 → TJM-8.
- **38-45:** wallet derivation is identical to the wallet's own check; verified against the deployed address. OK.
- **47-48:** owner check OK. No value floor → TJM-2.
- **49-64:** mode 64, atomic. `bounce:false` → TJM-2. Excess routing → TJM-3. No notification → TJM-6.
- **66:** overflow throws and reverts atomically. OK.
- **69-76:** getter correct, but the comment says TEP-89 when it is TEP-74 → TJM-1.

### TestJettonWallet (`test_jetton.tact:79-176`)
- **79-96:** a forged mint from a non-sibling is rejected (exit 14236). OK.
- **97:** the credit is committed before checks that can throw → TJW-1.
- **99-117:** → TJW-1, TJW-3, TJW-5, TJW-8, TJW-9.
- **124-137:** → TJW-8, TJW-10.
- **141-163:** owner and balance checks OK. Missing value check and missing bounce handler → TJW-1/2/3. **Missing `Either` validation → this is what hides X-1.**
- **165-175:** → TJW-4.

---

## 4. Blind spots and alternative angles

These come from patterns across the whole codebase rather than from any one line.

1. **Comments state invariants that the code doesn't hold.** The code documents its safety reasoning carefully, which is good, but several of those claims turned out false. A reader trusts these comments more than the code, so a false one is dangerous.
   - "a voucher signed for one contract is worthless on any other" (X-2)
   - "No funds before an admin exists" (CP-9)
   - "never rents itself into freezing" (CP-7, AR-8)
   - "its balance only covers its own storage rent" (DM-5)
   - "NEVER requires the backend" (CP-11)
   - "wire-compatible byte for byte" (TJW)
   - "the length cap" (AR-1)

   Turn each stated invariant into a test, or delete it.
2. **The tests check the code against the author's own model of the outside world.** Jetton wallets in the tests are a treasury or a hand-written Tact wallet. Prices come from a sandbox with zero storage fees. There is only one network. That is how a Critical, X-1, survived 54 green tests. Vendor the real wallet BOCs (USDT, reference minter) and mainnet config params into the test fixtures.
3. **"Refund everything, keep no fee" leaves contracts with no TON buffer.** The master, the registry, items and pools all run on a thin or zero reserve. Combined with state that only grows, they rent themselves toward freezing. Contracts that can never be upgraded must budget for decades, or expose a monitored top-up path.
4. **The threat model covers a backend key leak but not the backend lying or racing.** The protocol assumes the backend's view (toncenter `get_wallet_address`, `isNonceUsed`, `poolAdmin`) is accurate and final. CP-1, CP-10 and CP-2 all live in that gap. The chain should verify what it can (TEP-89) and the backend should wait for finality.
5. **Telegram state changes and on-chain state does not follow.**
   - Admin demotion or ownership transfer leaves the old wallet in control (CP-9, CP-12).
   - Lost wallets can't re-mint, because `mintedUsers` is keyed by tgUserId (AI-7).
   - Group→supergroup migration changes the chatId.

   Design an explicit "chat authority changed" path.
6. **Immutability without a migration story.** X-1 by itself requires a new master and a way for admins to move funds out of old pools, and today funds can't leave those pools at all. Write down a versioning and migration plan before mainnet funds grow. `ProtocolVersion` exists, but nothing on-chain migrates. The same applies to the registry: AR-2 means a new collection, which loses the "same collection" identity of every existing badge.
7. **"Achievement" semantics against a marketplace.** The items are tradeable and carry royalties that don't actually get paid. Decide whether a badge is a proof of what someone did (soulbound, TEP-85) or a collectible. Right now it's neither cleanly.
8. **Privacy is a product decision that has been made by default.** Raw Telegram user ids and group ids are on-chain permanently. Use an HMAC of the id, unless public linkage is an explicit feature.
9. **One key, three trust domains.** Deposit, claim, admin, register and mint vouchers all use a single ed25519 key. The tags prevent mixing one kind of voucher with another, but a single leak hits everything, and only the pools can rotate. Consider separate keys per domain (pools vs registry) and per network.

---

## 5. Recommended order of work

1. **Now:** find out whether any mainnet pool holds real jettons (X-1). If so, plan the migration and communication. Fix `chat_pool.tact:307`, and add the real-wallet tests (vendored BOCs) to the default suite.
2. **Before the next deploy (it is a redeploy anyway):** X-2 network binding, CP-9 depositor/admin binding, CP-1 on-chain wallet discovery, DM-2 rotation-stable addressing, AR-1/AR-2/AR-3 registry redesign (address-derived uniqueness), AR-6 registry key rotation, CP-3 rolling window, X-3 nonce pruning.
3. **Backend:** CP-10 finality margin; issue deposit vouchers only to the admin; rotation vouchers; per-network keys; check the template id from the event (AR-5).
4. **Product decisions:** soulbound vs tradeable (AI-3), TEP-66 royalty (AI-2), privacy (AR-7).
5. **Hygiene:** wrapper address derivation (AI-9/DM-8), TEP-62 int257 (AI-1), reserves and top-ups (DM-5, AI-5, AR-8), test jetton TEP-74 compliance or replacing it with the reference jetton.

---

## 6. Missing tests (union)

- Claim, withdraw, refund and bounce through the reference TEP-74 and USDT wallet code, at the exact miniapp gas constants; shape-2 deposits from a real wallet; USDT lock and force-transfer.
- Deposits from a non-admin when an admin is set (CP-9); fake-wallet squatting (CP-1); alias wallet (CP-2).
- UTC midnight boundary, a cross-day bounce, budget pinning (CP-3/4/6).
- Two-chain address and voucher replay (X-2); behaviour after `RotateBackendKey` (DM-2/3).
- Account state growth to code 50 for the registry and the pool (AR-2, X-3); multi-ref `contentUrl` (AR-1); register-voucher replay (AR-3).
- Multi-year rent with mainnet param 18, and freeze/unfreeze.
- TEP-62/66 wire decoding (`ReportStaticData`, royalty); OwnershipAssigned with an `Either` payload.
- Wrapper-derived address == getter-derived address (AI-9, DM-8).
- Network guards in the deploy scripts.
