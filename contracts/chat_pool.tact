import "./distributor_messages.tact";
import "./dict.fc";

@name(__achivator_udict_min_key)
native udictMinKey(dict: Cell?, keyLen: Int): Int;

// Minimum TON the caller must attach so the outbound jetton transfer cannot
// run out of gas in the jetton wallet (which would bounce the transfer). At
// this value the pool forwards about 0.07 TON, at least 0.02 TON more than
// the reference and USDT wallets need to deliver to a fresh wallet
// (tests/RealJettonWallets.spec.ts measures both).
const PoolMinClaimValue: Int = ton("0.08");
const PoolMinWithdrawValue: Int = ton("0.08");
// A rejected deposit is refunded only when its notification brought at least
// this much TON, enough for the refund to reach the depositor through a
// real jetton wallet. With less, the refund would bounce and strand the
// jettons on the pool's wallet anyway: the pool keeps them as untracked
// instead, and the admin can move them with SweepUntracked (registering the
// jetton first, if needed).
const PoolMinRefundValue: Int = ton("0.08");
// TON attached to RegisterJetton: the TEP-89 round trip to the jetton
// master and back. What is left returns to the admin.
const PoolRegisterJettonValue: Int = ton("0.05");
// WithdrawTon never takes the pool below this: its storage rent for at
// least 14 years (about 0.01 TON a year at mainnet prices, measured in
// tests/ChatPoolSecurity.spec.ts). The master deploys a pool with exactly
// this much (PoolDeployValue); top-ups and claim fees add to it.
const PoolMinTonReserve: Int = ton("0.15");
// Kept from every claim for the pool's storage rent. A claim's nonce entry
// (2 cells, about 0.00013 TON a year at mainnet prices) lives NonceRetention
// (a week) while the pool is in use, then later claims prune it: the fee
// covers that thousands of times over and the rest tops up the pool's rent
// reserve. If the pool falls idle its last entries stay, and their own fees
// pay for them for about 15 years (tests/ChatPoolSecurity.spec.ts, CP-7).
const PoolClaimStorageFee: Int = ton("0.002");
// Default claim budget per jetton over a rolling 24h window, as a share of
// the balance plus what the window has already paid out. Caps what a leaked
// backend key can drain: about one budget in any short burst, never more
// than two in any 24 hours (see windowSpent).
const DefaultDailyClaimPercent: Int = 10;
const ClaimWindow: Int = 86400;
// Claim vouchers may expire at most this far ahead, which bounds how long a
// nonce entry must be kept (X-3).
const MaxClaimTtl: Int = 86400;
// A used nonce is kept this long after its claim, then pruned, and the nonce
// floor moves above it. MaxClaimTtl plus six days: every voucher with a
// lower nonce (the backend allocates them in order) has expired long before,
// and the backend has had six days to reconcile it against nonceState().
// It also bounds the state: at 2 cells an entry, a pool stays clear of
// max_acc_state_cells (65536) below about 4,500 claims a day, sustained.
const NonceRetention: Int = 604800;
// Entries pruned per claim at most: bounded gas, and still twice the rate
// entries are added at, so the backlog always drains.
const NoncePrunePerClaim: Int = 2;
// A claim nonce must lie below nonceFloor + NonceWindow: a leaked key cannot
// push the floor to the end of the range and retire every nonce at once.
const NonceWindow: Int = 0x100000000;
// Gas of the deposit notification. Must be covered by the depositor's
// forward_ton_amount, never by the pool; whatever is left goes back.
const PoolDepositGas: Int = ton("0.02");
// raw_reserve mode: reserve at most the amount (never fail on a low balance)
const PoolReserveAtMost: Int = 2;

// Admin recovery (ProposeAdmin) takes effect this long after the proposal,
// unless the current admin cancels it first.
const AdminRecoveryDelay: Int = 604800;

// queryId of outbound JettonTransfers tells the bounce handler what to undo.
// Claims use the voucher nonce, which is therefore limited to (0, 2^63).
const QueryClaimNonceLimit: Int = 0x8000000000000000;
const QueryWithdrawTracked: Int = 0x8000000000000001;   // WithdrawRemainder, debited from the ledger
const QuerySweepUntracked: Int = 0x8000000000000002;    // SweepUntracked, never in the ledger
const QueryRefund: Int = 0x8000000000000003;            // returned a rejected deposit

// A pool's address is derived from (master, chatId) alone. The master deploys
// it with InitPool, which sets the backend key; until then the pool refuses
// every message (a jetton notification is refunded instead). So nobody but
// the master can bring a pool to life at the official address, and a backend
// key rotation never moves it (DM-2, DM-3).
//
// Anyone may create a pool for any chatId through the master (DM-9): that is
// harmless, since the pool is useless until the backend-verified chat creator
// claims its admin slot, and the creator pays the deploy.
contract ChatPool {
    master: Address;
    chatId: Int as int64;
    initialized: Bool = false;             // set once, by the master's InitPool
    backendPubKey: Int as uint256 = 0;

    admin: Address?;                       // set via backend-signed SetAdmin (init/rotation)
    // Backend-initiated recovery (CP-12): proposed admin, when, and the
    // sequence number its voucher had to carry.
    pendingAdmin: Address?;
    pendingAdminSince: Int as uint32 = 0;
    adminProposalSeq: Int as uint32 = 0;
    balances: map<Address, Int>;           // jettonMaster -> credited amount (ledger)
    // Registered by RegisterJetton from the jetton master's own TEP-89 answer;
    // never re-pointed, and injective: one wallet, one master (CP-1, CP-2).
    jettonWallets: map<Address, Address>;  // jettonMaster -> this pool's jetton wallet
    walletMasters: map<Address, Address>;  // reverse of jettonWallets: deposits, bounces
    pendingWallets: map<Address, Int>;     // jettonMaster -> queryId of the open TEP-89 request
    lastQueryId: Int as uint64 = 0;
    // Claim replay protection: nonce -> claimedAt * 2 + bounced. Entries are
    // pruned NonceRetention after the claim (oldest nonce first); every nonce
    // below nonceFloor is retired for good (X-3, CP-10).
    nonces: map<Int as uint64, Int as uint64>;
    nonceFloor: Int as uint64 = 0;

    // Safety controls (admin-only), see SetClaimsPaused / SetClaimLimit.
    claimsPaused: Bool = false;
    claimLimits: map<Address, Int>;        // jettonMaster -> explicit 24h budget
    // jettonMaster -> spent << 32 | updatedAt: what the rolling window still
    // counts, as of updatedAt (it decays linearly, see windowSpent)
    claimWindows: map<Address, Int>;

    init(master: Address, chatId: Int) {
        self.master = master;
        self.chatId = chatId;
    }

    // The master's deploy message. A repeated CreatePool reaches an already
    // initialised pool: its value goes back to whoever paid for it.
    receive(msg: InitPool) {
        require(sender() == self.master, "only the master initialises the pool");
        if (self.initialized) {
            send(SendParameters{
                to: msg.excessTo,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: TonExcesses{queryId: 0}.toCell()
            });
            return;
        }
        require(msg.backendPubKey != 0, "invalid backend key");
        self.initialized = true;
        self.backendPubKey = msg.backendPubKey;
        // the deploy value stays: it is the pool's storage reserve
    }

    // Plain TON: storage top-ups.
    receive() {
        self.requireInitialized();
    }

    // ---- Deposit: jettons land on the pool's jetton wallet ----
    // Accepted forwardPayload shapes:
    //   1) unwrapped: ref(DepositVoucher cell) ++ 512-bit signature
    //   2) verbatim TEP-74 ref payload: 1 bit flag ++ ref(shape 1)
    // Stock jetton wallets forward the transfer's forward_payload as-is
    // (shape 2); cooperating wallets may deliver shape 1. The two are
    // unambiguous: a valid shape 1 always carries 512 bits of signature.
    //
    // Credited only when all of these hold (anything else is refunded):
    //   - the notification comes from a wallet the pool registered (TEP-89),
    //     so the amount and the original sender are the wallet's word;
    //   - the original sender is the current admin (CP-9): nobody else's
    //     jettons can land in a ledger the admin alone can withdraw;
    //   - a backend voucher for this pool, this chat and that jetton.
    // A deposit that fails is refunded instead of thrown: a thrown
    // notification would leave the jettons on the pool's wallet with no
    // ledger entry. Refunding is safe even for a forged notification: the
    // transfer request goes to the notifying contract itself, which can only
    // move its own jettons. Underfunded ones are kept (PoolMinRefundValue).
    receive(msg: JettonTransferNotification) {
        let ctx: Context = context();
        let jettonMaster: Address? = self.walletMasters.get(ctx.sender);
        if (jettonMaster == null) {
            self.refundDeposit(ctx, msg);
            return;
        }
        let fp: Slice = msg.forwardPayload;
        if (fp.bits() == 1 && fp.refs() == 1) {
            fp = fp.loadRef().beginParse();
        }
        if (fp.refs() < 1 || fp.bits() < 512) {
            self.refundDeposit(ctx, msg);
            return;
        }
        let voucherCell: Cell = fp.loadRef();
        let signature: Slice = fp.loadBits(512);
        if (!checkSignature(signedVoucherHash(VoucherTagDeposit, myAddress(), voucherCell), signature, self.backendPubKey)) {
            self.refundDeposit(ctx, msg);
            return;
        }

        // Signed by the backend, so the layout is trusted from here on.
        let vs: Slice = voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vJettonMaster: Address = vs.loadAddress();
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        let admin: Address? = self.admin;
        if (vChatId != self.chatId
            || vJettonMaster != jettonMaster!!
            || now() >= vExpiry
            || admin == null
            || msg.sender != admin!!
            // This handler's gas comes out of the depositor's
            // forward_ton_amount, never out of the pool balance.
            || ctx.value < PoolDepositGas) {
            self.refundDeposit(ctx, msg);
            return;
        }

        self.balances.set(vJettonMaster, self.balanceOrZero(vJettonMaster) + msg.amount);

        // No fee: the forwarded TON beyond the gas goes back to the depositor.
        self.refundExcess(ctx, msg.sender, msg.queryId);
    }

    // ---- RegisterJetton: TEP-89 discovery of the pool's own wallet ----
    receive(msg: RegisterJetton) {
        self.requireAdmin();
        require(self.jettonWallets.get(msg.jettonMaster) == null, "jetton already registered");
        require(context().value >= PoolRegisterJettonValue, "attach more TON for gas");
        // a new request replaces an unanswered one
        self.lastQueryId = self.lastQueryId + 1;
        self.pendingWallets.set(msg.jettonMaster, self.lastQueryId);
        send(SendParameters{
            to: msg.jettonMaster,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: ProvideWalletAddress{
                queryId: self.lastQueryId,
                ownerAddress: myAddress(),
                includeAddress: false
            }.toCell()
        });
    }

    // Only the master asked, answering the query it was asked. A wallet that
    // already belongs to another master is refused (CP-2).
    receive(msg: TakeWalletAddress) {
        self.requireInitialized();
        let pending: Int? = self.pendingWallets.get(sender());
        require(pending != null && pending!! == msg.queryId, "unexpected wallet address reply");
        require(msg.walletAddress != null, "jetton master reported no wallet");
        let wallet: Address = msg.walletAddress!!;
        require(self.walletMasters.get(wallet) == null, "wallet already registered for another jetton");
        self.pendingWallets.set(sender(), null);
        self.jettonWallets.set(sender(), wallet);
        self.walletMasters.set(wallet, sender());
        self.returnToAdmin(msg.queryId);
    }

    // A master that does not speak TEP-89 rejects the request: drop it.
    bounced(msg: bounced<ProvideWalletAddress>) {
        let pending: Int? = self.pendingWallets.get(sender());
        if (pending != null && pending!! == msg.queryId) {
            self.pendingWallets.set(sender(), null);
        }
        self.returnToAdmin(msg.queryId);
    }

    // ---- SetAdmin: backend-signed voucher; init and rotation share the path.
    // Init (slot empty): the wallet named in the voucher must claim itself, so
    // a leaked voucher cannot hand a squatter someone else's slot.
    // Rotation (slot taken): only the current admin may hand over, so a leaked
    // backend key can never hijack an established pool. ----
    receive(msg: SetAdmin) {
        self.requireInitialized();
        require(checkSignature(signedVoucherHash(VoucherTagAdmin, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad admin voucher signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vMaster: Address = vs.loadAddress();
        let vAdmin: Address = vs.loadAddress();
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        require(vChatId == self.chatId, "voucher for another chat");
        require(vMaster == self.master, "voucher for another master");
        require(now() < vExpiry, "voucher expired");

        let cur: Address? = self.admin;
        if (cur == null) {
            require(sender() == vAdmin, "only the named admin may init");
        } else {
            require(sender() == cur!!, "only the current admin may rotate");
        }
        self.admin = vAdmin;
        self.refundExcess(context(), sender(), 0);
    }

    // ---- Admin recovery: a lost or stale admin wallet (CP-12) ----
    // The backend signs a proposal for the wallet of a current chat
    // administrator; that wallet submits it and the 7-day timelock starts.
    // The current admin can cancel it meanwhile, so a leaked backend key
    // alone cannot take a pool whose admin is watching. Rotation by the
    // current admin (SetAdmin) stays immediate and leaves a pending proposal
    // alone: the new admin can cancel it like any other.
    receive(msg: ProposeAdmin) {
        self.requireInitialized();
        require(checkSignature(signedVoucherHash(VoucherTagAdminProposal, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad admin proposal signature");

        let vs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = vs.loadInt(64);
        let vNewAdmin: Address = vs.loadAddress();
        let vSeq: Int = vs.loadUint(32);
        let vExpiry: Int = vs.loadUint(64);
        vs.endParse();

        require(vChatId == self.chatId, "voucher for another chat");
        require(now() < vExpiry, "voucher expired");
        require(self.admin != null, "pool has no admin yet");
        require(vSeq == self.adminProposalSeq, "stale admin proposal");
        require(self.pendingAdmin == null, "an admin proposal is already pending");
        require(sender() == vNewAdmin, "only the proposed admin may submit");
        self.pendingAdmin = vNewAdmin;
        self.pendingAdminSince = now();
        self.refundExcess(context(), sender(), 0);
    }

    receive(msg: CancelAdminProposal) {
        self.requireAdmin();
        require(self.pendingAdmin != null, "no admin proposal");
        self.clearAdminProposal();
        self.returnValue();
    }

    receive(msg: ExecuteAdminProposal) {
        self.requireInitialized();
        let next: Address? = self.pendingAdmin;
        require(next != null, "no admin proposal");
        require(now() >= self.pendingAdminSince + AdminRecoveryDelay, "admin proposal is still timelocked");
        self.admin = next!!;
        self.clearAdminProposal();
        self.refundExcess(context(), sender(), 0);
    }

    // ---- Claim: backend-signed voucher, the submitter pays the gas ----
    receive(msg: Claim) {
        self.requireInitialized();
        require(checkSignature(signedVoucherHash(VoucherTagClaim, myAddress(), msg.voucherCell), msg.signature, self.backendPubKey),
            "bad claim voucher signature");

        let cs: Slice = msg.voucherCell.beginParse();
        let vChatId: Int = cs.loadInt(64);
        let vRecipient: Address = cs.loadAddress();
        let vJettonMaster: Address = cs.loadAddress();
        let vAmount: Int = cs.loadCoins();
        let vNonce: Int = cs.loadUint(64);
        let vExpiry: Int = cs.loadUint(64);
        cs.endParse();

        require(vChatId == self.chatId, "voucher for another chat");
        require(now() < vExpiry, "voucher expired");
        require(vExpiry <= now() + MaxClaimTtl, "voucher expiry too far ahead");
        require(vNonce > 0 && vNonce < QueryClaimNonceLimit, "nonce out of range");
        require(vNonce >= self.nonceFloor, "nonce retired");
        require(vNonce < self.nonceFloor + NonceWindow, "nonce too far ahead");
        require(vAmount > 0, "zero claim");
        require(self.nonces.get(vNonce) == null, "voucher already used");
        require(!self.claimsPaused, "claims are paused by the chat admin");
        let ctx: Context = context();
        require(ctx.value >= PoolMinClaimValue + PoolClaimStorageFee, "attach more TON for gas");

        let bal: Int = self.balanceOrZero(vJettonMaster);
        require(bal >= vAmount, "insufficient pool balance");
        let wallet: Address? = self.jettonWallets.get(vJettonMaster);
        require(wallet != null, "jetton not registered");

        let spent: Int = self.windowSpent(vJettonMaster);
        require(spent + vAmount <= self.claimBudget(vJettonMaster, bal, spent), "daily claim limit reached");
        self.setWindowSpent(vJettonMaster, spent + vAmount);

        self.balances.set(vJettonMaster, bal - vAmount);
        self.nonces.set(vNonce, now() * 2);
        self.pruneNonces();

        // Keep the storage fee, forward the rest of the submitter's TON; the
        // jetton wallet's excess goes back to the submitter too (CP-14).
        nativeReserve(myBalance() - ctx.value + PoolClaimStorageFee, 0);
        self.sendJettons(wallet!!, vNonce, vAmount, vRecipient, ctx.sender, SendRemainingBalance);
    }

    // ---- Safety controls: admin only ----
    receive(msg: SetClaimsPaused) {
        self.requireAdmin();
        self.claimsPaused = msg.paused;
        self.returnValue();
    }

    receive(msg: SetClaimLimit) {
        self.requireAdmin();
        if (msg.dailyLimit == 0) {
            self.claimLimits.set(msg.jettonMaster, null);
        } else {
            self.claimLimits.set(msg.jettonMaster, msg.dailyLimit);
        }
        // takes effect at once: every claim computes its budget afresh
        self.returnValue();
    }

    // Moves the pool to a new backend key (e.g. after a leak). Vouchers
    // signed by the old key stop working immediately.
    receive(msg: SetPoolBackendKey) {
        self.requireAdmin();
        self.backendPubKey = msg.backendPubKey;
        self.returnValue();
    }

    // ---- Withdrawals: admin only, no backend ----
    // Tracked jettons: at most what the ledger holds (CP-5).
    receive(msg: WithdrawRemainder) {
        self.requireAdmin();
        require(msg.amount > 0, "zero withdrawal");
        require(context().value >= PoolMinWithdrawValue, "attach more TON for gas");
        let wallet: Address? = self.jettonWallets.get(msg.jettonMaster);
        require(wallet != null, "jetton not registered");
        let bal: Int = self.balanceOrZero(msg.jettonMaster);
        require(msg.amount <= bal, "amount exceeds the tracked balance");
        self.balances.set(msg.jettonMaster, bal - msg.amount);
        self.sendJettons(wallet!!, QueryWithdrawTracked, msg.amount, msg.to, sender(), SendRemainingValue);
    }

    // Untracked jettons: the ledger never changes (CP-5, CP-11).
    receive(msg: SweepUntracked) {
        self.requireAdmin();
        require(msg.amount > 0, "zero withdrawal");
        require(context().value >= PoolMinWithdrawValue, "attach more TON for gas");
        let wallet: Address? = self.jettonWallets.get(msg.jettonMaster);
        require(wallet != null, "jetton not registered");
        self.sendJettons(wallet!!, QuerySweepUntracked, msg.amount, msg.to, sender(), SendRemainingValue);
    }

    // The pool's own TON above its storage reserve (CP-13): the amount and
    // what the admin attached, minus gas, go to `to`.
    receive(msg: WithdrawTon) {
        self.requireAdmin();
        require(msg.amount > 0, "zero withdrawal");
        let keep: Int = myBalance() - context().value - msg.amount;
        require(keep >= PoolMinTonReserve, "would go below the TON reserve");
        nativeReserve(keep, 0);
        send(SendParameters{
            to: msg.to,
            value: 0,
            mode: SendRemainingBalance,
            bounce: false
        });
    }

    // ---- Bounced transfer: the jettons never left the pool's wallet, so
    // undo the ledger debit. Only registered wallets are trusted as bounce
    // sources. ----
    bounced(msg: bounced<JettonTransfer>) {
        let jettonMaster: Address? = self.walletMasters.get(sender());
        if (jettonMaster == null) {
            return;
        }
        let q: Int = msg.queryId;
        if (q > 0 && q < QueryClaimNonceLimit) {
            // A wallet bounces a transfer once; an entry that is gone or
            // already marked bounced means there is nothing left to undo.
            let entry: Int? = self.nonces.get(q);
            if (entry == null || entry!! % 2 == 1) {
                return;
            }
            // The nonce stays burnt, marked bounced: the backend reissues the
            // claim under a new nonce, never this one (CP-10).
            self.nonces.set(q, entry!! + 1);
            // Give back only the part of the charge the window still counts:
            // a claim from more than 24h ago no longer weighs on it (CP-4).
            let elapsed: Int = now() - entry!! / 2;
            if (elapsed < ClaimWindow) {
                let charge: Int = msg.amount * (ClaimWindow - elapsed) / ClaimWindow;
                self.setWindowSpent(jettonMaster!!, max(self.windowSpent(jettonMaster!!) - charge, 0));
            }
        } else if (q != QueryWithdrawTracked) {
            // Sweeps and refunds were never in the ledger; crediting them
            // back would overstate the balance.
            return;
        }
        self.balances.set(jettonMaster!!, self.balanceOrZero(jettonMaster!!) + msg.amount);
    }

    // Everything the incoming message brought beyond this transaction's gas
    // goes back to `to`: the pool keeps its balance as it was, never more.
    // Must be the handler's last action (mode 128 sends all unreserved TON).
    fun refundExcess(ctx: Context, to: Address, queryId: Int) {
        nativeReserve(myBalance() - ctx.value, PoolReserveAtMost);
        send(SendParameters{
            to: to,
            value: 0,
            mode: SendRemainingBalance + SendIgnoreErrors,
            bounce: false,
            body: TonExcesses{queryId: queryId}.toCell()
        });
    }

    fun refundDeposit(ctx: Context, msg: JettonTransferNotification) {
        if (msg.amount > 0 && ctx.value >= PoolMinRefundValue) {
            self.sendJettons(ctx.sender, QueryRefund, msg.amount, msg.sender, msg.sender, SendRemainingValue);
        }
    }

    // TEP-89 leftovers go to the admin who paid for RegisterJetton.
    fun returnToAdmin(queryId: Int) {
        let admin: Address? = self.admin;
        if (admin != null) {
            send(SendParameters{
                to: admin!!,
                value: 0,
                mode: SendRemainingValue + SendIgnoreErrors,
                bounce: false,
                body: TonExcesses{queryId: queryId}.toCell()
            });
        }
    }

    // Outbound transfer funded by the incoming message: SendRemainingValue,
    // or SendRemainingBalance after a nativeReserve that keeps the storage rent.
    // forward_payload is TEP-74 (Either Cell ^Cell): it needs at least the
    // Either bit (0 = inline, empty), or real wallets throw (708 / USDT 9).
    // `response` gets the jetton wallet's excess.
    fun sendJettons(wallet: Address, queryId: Int, amount: Int, to: Address, response: Address, mode: Int) {
        send(SendParameters{
            to: wallet,
            value: 0,
            mode: mode,
            bounce: true,
            body: JettonTransfer{
                queryId: queryId,
                amount: amount,
                destination: to,
                responseDestination: response,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeUint(0, 1).asSlice()
            }.toCell()
        });
    }

    // Ends the pending proposal; its voucher's seq is spent with it.
    fun clearAdminProposal() {
        self.pendingAdmin = null;
        self.pendingAdminSince = 0;
        self.adminProposalSeq = self.adminProposalSeq + 1;
    }

    fun requireInitialized() {
        require(self.initialized, "pool is not initialised");
    }

    // An admin exists only in an initialised pool.
    fun requireAdmin() {
        let admin: Address? = self.admin;
        require(admin != null, "only chat admin");
        require(sender() == admin!!, "only chat admin");
    }

    // Admin controls change no balances: hand the TON back.
    fun returnValue() {
        send(SendParameters{
            to: sender(),
            value: 0,
            mode: SendRemainingValue + SendIgnoreErrors,
            bounce: false
        });
    }

    // What the rolling window still counts for a jetton: each charge decays
    // linearly to zero over ClaimWindow (rounded up). The drain rate is at
    // most budget / 24h, so any stretch of T seconds pays out at most
    // budget * (1 + T / 24h): one budget in a burst, two over 24 hours, and
    // no fresh budget at any calendar boundary (CP-3).
    fun windowSpent(jettonMaster: Address): Int {
        let w: Int? = self.claimWindows.get(jettonMaster);
        if (w == null) {
            return 0;
        }
        let spent: Int = w!! >> 32;
        let elapsed: Int = max(now() - (w!! & 0xFFFFFFFF), 0);
        if (elapsed >= ClaimWindow) {
            return 0;
        }
        return (spent * (ClaimWindow - elapsed) + ClaimWindow - 1) / ClaimWindow;
    }

    fun setWindowSpent(jettonMaster: Address, spent: Int) {
        if (spent == 0) {
            self.claimWindows.set(jettonMaster, null);
        } else {
            self.claimWindows.set(jettonMaster, (spent << 32) | now());
        }
    }

    // The window's budget: the admin's explicit limit, else the default share
    // of the balance plus what the window still counts. Computed afresh on
    // every claim, so a tiny first claim cannot pin it and a deposit raises
    // it at once (CP-6).
    fun claimBudget(jettonMaster: Address, balance: Int, spent: Int): Int {
        let explicit: Int? = self.claimLimits.get(jettonMaster);
        if (explicit != null) {
            return explicit!!;
        }
        return (balance + spent) * DefaultDailyClaimPercent / 100;
    }

    // Retires up to NoncePrunePerClaim of the oldest nonce entries whose
    // retention is over, moving the floor above them.
    fun pruneNonces() {
        let i: Int = 0;
        while (i < NoncePrunePerClaim) {
            let key: Int = udictMinKey(self.nonces.asCell(), 64);
            if (key < 0) {
                return;
            }
            let entry: Int = self.nonces.get(key)!!;
            if (now() < entry / 2 + NonceRetention) {
                return;
            }
            self.nonces.set(key, null);
            self.nonceFloor = max(self.nonceFloor, key + 1);
            i = i + 1;
        }
    }

    fun mapOrZero(m: map<Address, Int>, key: Address): Int {
        let v: Int? = m.get(key);
        if (v == null) {
            return 0;
        }
        return v!!;
    }

    fun balanceOrZero(jettonMaster: Address): Int {
        let b: Int? = self.balances.get(jettonMaster);
        if (b == null) {
            return 0;
        }
        return b!!;
    }

    // ---- Getters ----
    get fun balanceOf(jettonMaster: Address): Int {
        return self.balanceOrZero(jettonMaster);
    }

    get fun jettonWallet(jettonMaster: Address): Address? {
        return self.jettonWallets.get(jettonMaster);
    }

    // queryId of an unanswered RegisterJetton, 0 when none.
    get fun pendingJettonRegistration(jettonMaster: Address): Int {
        let q: Int? = self.pendingWallets.get(jettonMaster);
        if (q == null) {
            return 0;
        }
        return q!!;
    }

    get fun poolAdmin(): Address? {
        return self.admin;
    }

    get fun pendingAdmin(): Address? {
        return self.pendingAdmin;
    }

    // When ExecuteAdminProposal becomes possible, 0 without a proposal.
    get fun pendingAdminExecutableAt(): Int {
        if (self.pendingAdmin == null) {
            return 0;
        }
        return self.pendingAdminSince + AdminRecoveryDelay;
    }

    // The seq the next AdminProposalVoucher must carry.
    get fun adminProposalSeq(): Int {
        return self.adminProposalSeq;
    }

    // Monotonic: once true, a nonce stays used (bounced and retired ones too).
    get fun isNonceUsed(nonce: Int): Bool {
        return self.nonceState(nonce) != 0;
    }

    // 0 unused (a valid voucher can still claim it), 1 used, 2 used and its
    // transfer bounced (the jettons stayed: reissue under a new nonce),
    // 3 retired: below the floor, its record pruned; it can never be claimed,
    // and whether it ever was is no longer known on-chain. The backend
    // reconciles long before a nonce gets retired (NonceRetention).
    get fun nonceState(nonce: Int): Int {
        if (nonce >= 0 && nonce < QueryClaimNonceLimit) {
            let entry: Int? = self.nonces.get(nonce);
            if (entry != null) {
                return 1 + entry!! % 2;
            }
        }
        if (nonce < self.nonceFloor) {
            return 3;
        }
        return 0;
    }

    get fun nonceFloor(): Int {
        return self.nonceFloor;
    }

    get fun poolChatId(): Int {
        return self.chatId;
    }

    get fun claimsPaused(): Bool {
        return self.claimsPaused;
    }

    // Explicit 24h limit, 0 when the default share applies.
    get fun claimLimit(jettonMaster: Address): Int {
        return self.mapOrZero(self.claimLimits, jettonMaster);
    }

    // What the rolling 24h window still counts against the budget.
    get fun claimWindowSpent(jettonMaster: Address): Int {
        return self.windowSpent(jettonMaster);
    }

    // What claims can move right now under the rolling 24h budget (the name
    // predates the window), for the backend to size vouchers so they never
    // fail on-chain.
    get fun claimableToday(jettonMaster: Address): Int {
        let bal: Int = self.balanceOrZero(jettonMaster);
        let spent: Int = self.windowSpent(jettonMaster);
        let left: Int = self.claimBudget(jettonMaster, bal, spent) - spent;
        if (left > bal) {
            left = bal;
        }
        if (left < 0) {
            return 0;
        }
        return left;
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }

    get fun isInitialized(): Bool {
        return self.initialized;
    }

    get fun version(): Int {
        return ProtocolVersion;
    }
}
