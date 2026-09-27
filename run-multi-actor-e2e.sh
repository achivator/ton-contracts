#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Multi-actor E2E scenario on testnet.
#
#   OWNER     deploys DistributorMaster (fresh, from the current build) and
#             funds everyone
#   ADMIN1    registers chat 1, deposits 200, takes the admin slot via
#             SetAdmin, withdraws the remainder
#   ADMIN2    legit admin of chat 2, deposits 150, takes the admin slot via
#             SetAdmin, then rotates it to MEMBER2 (rotation demo)
#   MEMBER1   claims a reward from chat 1, then tries 4 forged claims
#   MEMBER2   receives a backend-paid claim, replays it, then, as the
#             rotated-in pool2 admin, sweeps the remainder
#   ATTACKER  front-runs chat 2 (creates its pool + squat-deposits 20 into the
#             adminless pool, refunded), forges a deposit notification,
#             submits leaked/forged admin vouchers (init race + bad signature),
#             tries to rotate a taken slot with a valid voucher, tries to
#             sweep both pools, and junk jettons are refunded by the pool
#
# Every adversarial action is expected to be rejected on-chain; the runner
# prints the pool transaction's exit code as evidence and then asserts the
# exact end state (jetton deltas + zeroed pool ledgers + admin slots) via
# scenarioVerify.
#
# Repeatable: actor wallets live in .env.test-actors (gitignored), the master
# is reused across runs, and a persisted SCENARIO_RUN counter gives every run a
# fresh pair of chat ids, so re-running never collides with previous state.
# A fresh master is MANDATORY whenever the pool code changes: the master
# embeds the ChatPool code, so a new pool build needs its own master.
#
# Usage:  bash run-multi-actor-e2e.sh
#   SCENARIO_NEW_MASTER=1   force deploying a fresh master (~0.1 TON)
#   SCENARIO_MASTER=<addr>  run against an explicit master (advanced)
#
# Requires: .env with WALLET_MNEMONIC / BACKEND_SECRET / JETTON_MASTER and a
# paced toncenter proxy on 127.0.0.1:8787 (started automatically if absent).
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
TMP=$ROOT/temp
mkdir -p "$TMP"

if [ -z "${BASH_VERSION:-}" ]; then
    printf 'run with bash: bash run-multi-actor-e2e.sh\n' >&2
    exit 1
fi

ENV_FILE=$ROOT/.env
ACTORS_FILE=$ROOT/.env.test-actors
RPC_URL=http://127.0.0.1:8787/api/v2/jsonRPC

# ---- scenario parameters (whole tokens; jettons are 9-decimal) ----
DEPOSIT1=200      # ADMIN1 -> pool1
DEPOSIT2=150      # ADMIN2 -> pool2 (swept by MEMBER2, the rotated-in admin, to ADMIN2)
CLAIM1=50         # MEMBER1 claims from pool1
CLAIM2=30         # backend-paid claim from pool2 to MEMBER2
SQUAT=20          # ATTACKER's squat deposit into adminless pool2 (refunded)
JUNK=10           # junk jettons round-tripped through pool2
SWEEP1=150        # ADMIN1 withdraws the pool1 remainder
SWEEP2=120        # MEMBER2 (pool2 admin after the rotation) sweeps it to ADMIN2
ATTACK1=50        # amount used in the rejected claim attempts
TAMPER1=500       # amount submitted in the tampered-voucher attempt

# actor wallet funding targets (TON)
FUND_ADMIN1=0.6
FUND_ADMIN2=0.6
FUND_MEMBER1=0.5
FUND_MEMBER2=0.6
FUND_ATTACKER=2.0
DIST="ADMIN1:500,ADMIN2:150,ATTACKER:100"   # jetton handout

# ---- helpers --------------------------------------------------------------
say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

ESC=$(printf '\033')
strip_ansi() { sed -E "s/${ESC}\[[0-9;]*[A-Za-z]//g"; }
env_val() { [ -f "$2" ] && sed -n "s/^$1=//p" "$2" | tail -1; }

# bp <script> [KEY=VAL ...] - runs blueprint with the actor/wallet overrides in
# KEY=VAL (WALLET_MNEMONIC selects the acting wallet), streamed and logged.
bp() {
    local script=$1; shift
    local log=${BP_LOG:-$TMP/bp-$script.log}
    env "$@" npx blueprint run "$script" \
        --custom "$RPC_URL" --custom-version v2 --custom-type testnet --mnemonic </dev/null 2>&1 \
        | strip_ansi | tee "$log"
    # blueprint exits 0 even when a script throws: inspect the text instead
    if grep -qE '(^|[^A-Za-z])(Error|Exception)(:|[[:space:]]|$)' "$log"; then
        die "blueprint run $script reported an error (log: $log)"
    fi
}

pool_deployed() {   # reads $TMP/bp-probe-<tag>.log, echoes 0|1
    sed -n 's/^POOL|[^|]*|[^|]*|deployed=\([01]\).*/\1/p' "$TMP/bp-probe-$1.log" | tail -1
}

persist_run() {     # persist_run <n>
    awk -v v="$1" 'BEGIN{done=0} /^SCENARIO_RUN=/{print "SCENARIO_RUN=" v; done=1; next}
        {print} END{if(!done) print "SCENARIO_RUN=" v}' "$ACTORS_FILE" >"$ACTORS_FILE.tmp"
    mv "$ACTORS_FILE.tmp" "$ACTORS_FILE"
}

health_ok() {
    curl -s -m 20 -o "$TMP/health.json" -w '%{http_code}' -X POST "$RPC_URL" \
        -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getMasterchainInfo","params":{}}' | grep -q 200
}

ensure_proxy() {
    if health_ok; then
        note "pacing proxy already up on 127.0.0.1:8787"
        return
    fi
    note "starting pacing proxy (toncenter keyless limit is ~1 rps)"
    node "$ROOT/tools/ton-pace-proxy.js" >"$TMP/proxy.log" 2>&1 &
    for _ in $(seq 1 15); do
        sleep 1
        if health_ok; then
            note "proxy up"
            return
        fi
    done
    tail -5 "$TMP/proxy.log" >&2 || true
    die "pacing proxy did not come up"
}

on_abort() {
    printf '\nscenario aborted. Partial on-chain state stays on testnet; a re-run\n'
    printf 'automatically picks fresh chat ids (SCENARIO_RUN in .env.test-actors).\n'
    printf 'logs: %s/bp-*.log\n' "$TMP"
}
trap on_abort EXIT

# ---- preflight ------------------------------------------------------------
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (see .env.example)"
for k in WALLET_MNEMONIC BACKEND_SECRET JETTON_MASTER; do
    grep -q "^$k=" "$ENV_FILE" || die "missing $k in .env"
done
OWNER_MN=$(env_val WALLET_MNEMONIC "$ENV_FILE")
[ -n "$OWNER_MN" ] || die "WALLET_MNEMONIC is empty in .env"
WV=$(env_val WALLET_VERSION "$ENV_FILE")
if [ -n "$WV" ] && [ "$WV" != v4 ]; then
    die "WALLET_VERSION must be v4 (got $WV)"
fi
JM=$(env_val JETTON_MASTER "$ENV_FILE")
[ -n "$JM" ] || die "JETTON_MASTER is empty in .env"

say "multi-actor E2E scenario on testnet"
note "OWNER    deploys the master, funds everyone (spends testnet TON)"
note "ADMIN1   chat 1: deposit $DEPOSIT1, init the admin slot, withdraw $SWEEP1"
note "ADMIN2   chat 2: deposit $DEPOSIT2, init the admin slot, rotate it to MEMBER2"
note "MEMBER1  claims $CLAIM1 from chat 1, then 4 forged claims"
note "MEMBER2  receives a $CLAIM2 claim, replays it, sweeps chat 2 as its rotated admin"
note "ATTACKER squat $SQUAT in chat 2 (slot stays empty), forged/leaked vouchers, sweeps"
note "jetton   $JM"
note "gas      comes from actor wallets; owner outlay is ~4.5 TON"
note "faucet   top up the owner with @testgiver_ton_bot if it runs dry"

ensure_proxy

# ---- actors ---------------------------------------------------------------
say "actors: generating/reusing wallets (.env.test-actors)"
BP_LOG=$TMP/genActors.log bp genActors "WALLET_MNEMONIC=$OWNER_MN"
grep -q '^written :' "$TMP/genActors.log" || die "genActors did not finish (see $TMP/genActors.log)"

for A in ADMIN1 ADMIN2 MEMBER1 MEMBER2 ATTACKER; do
    MN=$(env_val "${A}_MNEMONIC" "$ACTORS_FILE")
    AD=$(env_val "${A}_ADDR" "$ACTORS_FILE")
    [ -n "$MN" ] && [ -n "$AD" ] || die "${A}_MNEMONIC/_ADDR missing in $ACTORS_FILE"
    printf -v "${A}_MN" '%s' "$MN"
    printf -v "${A}_ADDR" '%s' "$AD"
done
OWNER_ADDR=$(env_val OWNER_ADDR "$ACTORS_FILE")
[ -n "$OWNER_ADDR" ] || die "OWNER_ADDR missing in $ACTORS_FILE"

# ---- master ---------------------------------------------------------------
bp backendPub
BACKEND_PUB_KEY=$(sed -n 's/^BACKEND_PUBLIC_KEY=//p' "$TMP/bp-backendPub.log" | tail -1)
[ -n "$BACKEND_PUB_KEY" ] || die "could not derive BACKEND_PUBLIC_KEY from BACKEND_SECRET"
ENV_PUB=$(env_val BACKEND_PUBLIC_KEY "$ENV_FILE")
if [ -n "$ENV_PUB" ] && [ "$ENV_PUB" != "$BACKEND_PUB_KEY" ]; then
    die "BACKEND_PUBLIC_KEY in .env does not match BACKEND_SECRET (stale value?)"
fi

MASTER="${SCENARIO_MASTER:-$(env_val MASTER_ADDRESS "$ACTORS_FILE")}"
if [ "${SCENARIO_NEW_MASTER:-0}" = 1 ]; then
    MASTER=""
fi

if [ -n "$MASTER" ]; then
    say "master: reusing $MASTER"
    bp backendPub "MASTER_ADDRESS=$MASTER"
    grep -q '^KEY_MATCH=yes$' "$TMP/bp-backendPub.log" ||
        die "master backend key != BACKEND_SECRET pubkey (set SCENARIO_NEW_MASTER=1 for a fresh master)"
else
    say "master: deploying a fresh DistributorMaster (~0.1 TON)"
    BP_LOG=$TMP/deploy-master.log bp deployDistributorMaster \
        "WALLET_MNEMONIC=$OWNER_MN" "BACKEND_PUBLIC_KEY=$BACKEND_PUB_KEY"
    MASTER=$(sed -n 's/^DistributorMaster deployed at: \(.*\)$/\1/p' "$TMP/deploy-master.log" | tail -1)
    [ -n "$MASTER" ] || die "could not parse the master address (see $TMP/deploy-master.log)"
    printf 'MASTER_ADDRESS=%s\n' "$MASTER" >>"$ACTORS_FILE"
    note "persisted MASTER_ADDRESS into $ACTORS_FILE"
fi
note "master: $MASTER"

# ---- fresh chat ids -------------------------------------------------------
RUN=$(env_val SCENARIO_RUN "$ACTORS_FILE"); RUN=${RUN:-0}
CHAT1=$((-1009000000 - RUN * 10 - 1))
CHAT2=$((-1009000000 - RUN * 10 - 2))
persist_run $((RUN + 1))
FRESH=0
for _ in $(seq 1 20); do
    BP_LOG=$TMP/bp-probe-p1.log bp probe "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT1" >/dev/null
    BP_LOG=$TMP/bp-probe-p2.log bp probe "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT2" >/dev/null
    D1=$(pool_deployed p1)
    D2=$(pool_deployed p2)
    [ -n "$D1" ] && [ -n "$D2" ] || die "probe did not report pool state (see $TMP/bp-probe-p1.log)"
    if [ "$D1" = 0 ] && [ "$D2" = 0 ]; then
        FRESH=1
        break
    fi
    note "chats $CHAT1/$CHAT2 already have pools; bumping run id"
    RUN=$((RUN + 1))
    persist_run $((RUN + 1))
    CHAT1=$((-1009000000 - RUN * 10 - 1))
    CHAT2=$((-1009000000 - RUN * 10 - 2))
done
[ "$FRESH" = 1 ] || die "could not find a fresh pair of chat ids"
note "chat 1: $CHAT1   chat 2: $CHAT2"

# ---- owner balance estimate ----------------------------------------------
BP_LOG=$TMP/bp-probe-owner.log bp probe "ADDR=$OWNER_ADDR" >/dev/null
OWNER_TON=$(sed -n 's/^ADDR|.*|ton=\([0-9]*\).*/\1/p' "$TMP/bp-probe-owner.log" | tail -1)
note "owner balance: $(awk -v n="${OWNER_TON:-0}" 'BEGIN{printf "%.3f TON", n/1e9}') (needs ~4.5 TON)"

# ---- nonces & expiry ------------------------------------------------------
NBASE=$((($(date +%s) % 100000000) * 10))
N1=$((NBASE + 1)); N2=$((NBASE + 2)); N3=$((NBASE + 3))
N4=$((NBASE + 4)); N5=$((NBASE + 5)); N6=$((NBASE + 6))
NOW=$(date +%s)
EXPIRY_S=$((NOW + 7200))
PAST_EXPIRY=$((NOW - 60))
note "nonces: N1..N6 = $N1 .. $N6   (fresh per run)"
ALL_NONCES="$N1,$N2,$N3,$N4,$N5,$N6"

# ---- funding -------------------------------------------------------------
# Before the pools phase: every later actor action (incl. the ATTACKER's
# front-run createPool) must be paid from an already funded wallet.
say "funding: owner sends TON to the five actor wallets"
bp fund "WALLET_MNEMONIC=$OWNER_MN" \
    "ADMIN1_TON=$FUND_ADMIN1" "ADMIN2_TON=$FUND_ADMIN2" \
    "MEMBER1_TON=$FUND_MEMBER1" "MEMBER2_TON=$FUND_MEMBER2" \
    "ATTACKER_TON=$FUND_ATTACKER"

say "funding: owner distributes test jettons ($DIST)"
bp sendJettons "WALLET_MNEMONIC=$OWNER_MN" "DIST=$DIST"

# ---- pools ---------------------------------------------------------------
say "pools: OWNER creates chat-1 pool; ATTACKER front-runs chat 2"
bp createPool "WALLET_MNEMONIC=$OWNER_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT1"
bp createPool "WALLET_MNEMONIC=$ATTACKER_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT2"

# ---- snapshot before -----------------------------------------------------
say "snapshot: before"
BP_LOG=$TMP/snap-before.txt bp snapshot \
    "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" "CHAT1=$CHAT1" "CHAT2=$CHAT2" \
    "P1_NONCES=$ALL_NONCES" "P2_NONCES=$ALL_NONCES"

# ---- legit flows ---------------------------------------------------------
# Pools refund deposits until they have an admin, so a leaked backend key
# can never seize a funded pool through SetAdmin init. The squat deposit
# below lands while pool2 is still adminless and comes straight back.
say "phase 1: ATTACKER squat-deposits into adminless pool2 (refunded)"
bp deposit "WALLET_MNEMONIC=$ATTACKER_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$SQUAT"

say "phase 2: admin vouchers (leaked/forged rejected; legit inits)"
# Leaked valid voucher: ATTACKER holds a backend-signed voucher naming ADMIN1
# for pool1 (its admin slot is still empty). It must fail - only the wallet
# named in the voucher may claim the slot.
BP_LOG=$TMP/bp-attack-setAdmin_init.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=set_admin "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "ADMIN=$ADMIN1_ADDR"
# Forged signature: a self-named voucher signed with a foreign key must fail
# the signature check on pool2.
BP_LOG=$TMP/bp-attack-setAdmin_badSig.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=set_admin "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" SIG_KEY=foreign
# Legit inits: the named wallet claims its own slot.
bp setAdmin "WALLET_MNEMONIC=$ADMIN1_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT1"
bp setAdmin "WALLET_MNEMONIC=$ADMIN2_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT2"
say "phase 2b: deposits (pool1 by ADMIN1, pool2 by ADMIN2) and daily claim budgets"
bp deposit "WALLET_MNEMONIC=$ADMIN1_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$DEPOSIT1"
bp deposit "WALLET_MNEMONIC=$ADMIN2_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$DEPOSIT2"
# The default budget is 10% of the balance per day; the scenario claims more.
bp poolControl "WALLET_MNEMONIC=$ADMIN1_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT1" \
    MODE=limit "JETTON_MASTER=$JM" "AMOUNT=$DEPOSIT1"
bp poolControl "WALLET_MNEMONIC=$ADMIN2_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT2" \
    MODE=limit "JETTON_MASTER=$JM" "AMOUNT=$DEPOSIT2"

say "phase 2c: admin rotation"
# Rotation branch: a taken slot cannot be moved even with a valid backend
# signature unless the current admin sends the tx...
BP_LOG=$TMP/bp-attack-setAdmin_rotation.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=set_admin "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "ADMIN=$ATTACKER_ADDR"
# ...while the current admin (ADMIN2) hands pool2 over to MEMBER2.
bp setAdmin "WALLET_MNEMONIC=$ADMIN2_MN" "MASTER_ADDRESS=$MASTER" "CHAT_ID=$CHAT2" \
    "ADMIN=$MEMBER2_ADDR"

say "phase 3: claims (MEMBER1 own claim; ATTACKER submits a backend claim paying MEMBER2)"
bp claim "WALLET_MNEMONIC=$MEMBER1_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$CLAIM1" "NONCE=$N1" "EXPIRY=$EXPIRY_S"
bp claim "WALLET_MNEMONIC=$ATTACKER_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$CLAIM2" "NONCE=$N2" "EXPIRY=$EXPIRY_S" "RECIPIENT=$MEMBER2_ADDR"

# ---- adversarial ---------------------------------------------------------
say "phase 4: forged claims against pool1 (each must be rejected on-chain)"
BP_LOG=$TMP/bp-attack-bad_signature.log bp attack "WALLET_MNEMONIC=$MEMBER1_MN" \
    MODE=bad_signature "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$ATTACK1" "NONCE=$N3"
BP_LOG=$TMP/bp-attack-tampered.log bp attack "WALLET_MNEMONIC=$MEMBER1_MN" \
    MODE=tampered "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$ATTACK1" "TAMPER_AMOUNT=$TAMPER1" "NONCE=$N4"
BP_LOG=$TMP/bp-attack-expired.log bp attack "WALLET_MNEMONIC=$MEMBER1_MN" \
    MODE=expired "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$ATTACK1" "NONCE=$N5" "EXPIRY=$PAST_EXPIRY"
BP_LOG=$TMP/bp-attack-cross_chat.log bp attack "WALLET_MNEMONIC=$MEMBER1_MN" \
    MODE=cross_chat "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "VOUCHER_CHAT_ID=$CHAT2" "AMOUNT=$ATTACK1" "NONCE=$N6" "EXPIRY=$EXPIRY_S"

say "phase 5: MEMBER2 replays the identical pool2 voucher"
BP_LOG=$TMP/bp-attack-replay.log bp attack "WALLET_MNEMONIC=$MEMBER2_MN" \
    MODE=replay "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$CLAIM2" "NONCE=$N2" "EXPIRY=$EXPIRY_S" "RECIPIENT=$MEMBER2_ADDR"

say "phase 6: ATTACKER forges a deposit notification to pool1"
BP_LOG=$TMP/bp-attack-fake_notify.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=fake_notify "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$ATTACK1" "FEE_TON=0.1" "TIER=0" "EXPIRY=$EXPIRY_S"

say "phase 7: withdrawal attempts by the ATTACKER on both pools (both rejected)"
BP_LOG=$TMP/bp-attack-withdraw1.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=withdraw "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$SWEEP1"
BP_LOG=$TMP/bp-attack-withdraw2.log bp attack "WALLET_MNEMONIC=$ATTACKER_MN" \
    MODE=withdraw "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$SWEEP2"

# ---- legit withdrawals ---------------------------------------------------
say "phase 8: legit withdrawals (ADMIN1 sweeps pool1; MEMBER2, the rotated-in admin, sweeps pool2 to ADMIN2)"
bp withdraw "WALLET_MNEMONIC=$ADMIN1_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT1" "AMOUNT=$SWEEP1"
bp withdraw "WALLET_MNEMONIC=$MEMBER2_MN" "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" \
    "CHAT_ID=$CHAT2" "AMOUNT=$SWEEP2" "TO=$ADMIN2_ADDR"

# ---- junk jettons --------------------------------------------------------
# A deposit without a valid voucher is refunded by the pool itself (never
# credited), so the junk comes back to ATTACKER without an admin sweep.
say "phase 9: junk jettons (ATTACKER deposits $JUNK garbage, the pool refunds them)"
bp attack "WALLET_MNEMONIC=$ATTACKER_MN" MODE=junk_deposit "MASTER_ADDRESS=$MASTER" \
    "JETTON_MASTER=$JM" "CHAT_ID=$CHAT2" "AMOUNT=$JUNK" "FORWARD_TON=0.1"

# ---- verify --------------------------------------------------------------
say "snapshot: after"
BP_LOG=$TMP/snap-after.txt bp snapshot \
    "MASTER_ADDRESS=$MASTER" "JETTON_MASTER=$JM" "CHAT1=$CHAT1" "CHAT2=$CHAT2" \
    "P1_NONCES=$ALL_NONCES" "P2_NONCES=$ALL_NONCES"

say "verifying the end state"
BP_LOG=$TMP/verify.log bp scenarioVerify \
    "SNAP_BEFORE=$TMP/snap-before.txt" "SNAP_AFTER=$TMP/snap-after.txt" \
    "P1_USED=$N1" "P1_UNUSED=$N2,$N3,$N4,$N5,$N6" \
    "P2_USED=$N2" "P2_UNUSED=$N1,$N3,$N4,$N5,$N6"
grep -q '^RESULT: PASS$' "$TMP/verify.log" || die "scenario verification FAILED (see $TMP/verify.log)"

say "attack evidence"
grep -h '^ATTACK ' "$TMP"/bp-attack-*.log 2>/dev/null || true

say "final on-chain state"
grep -E '^SNAP\|(master\.ton|pool[12]\.(addr|deployed|ledger|phys|admin|ton)|act\.jw\.)' \
    "$TMP/snap-after.txt" || true

trap - EXIT
printf '\nRESULT: PASS - full multi-actor scenario verified on testnet\n'
note "logs: $TMP/bp-*.log | snapshots: $TMP/snap-{before,after}.txt | checks: $TMP/verify.log"
note "the miniapp/bot keep their own MASTER_ADDRESS; this scenario's master is in $ACTORS_FILE"
