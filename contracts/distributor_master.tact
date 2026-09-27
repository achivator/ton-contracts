import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";
import "./chat_pool.tact";

const MasterMinTonForStorage: Int = ton("0.05");
const PoolDeployValue: Int = ton("0.1");
// Master's own gas + forward fee for a CreatePool, paid by the caller.
const CreatePoolGas: Int = ton("0.05");

contract DistributorMaster with Deployable, Ownable {
    owner: Address;
    backendPubKey: Int as uint256;
    feeTiers: map<Int, Int>;        // tier -> depositFeeTon (published reference table)

    init(owner: Address, backendPubKey: Int) {
        self.owner = owner;
        self.backendPubKey = backendPubKey;
    }

    // Deploy a ChatPool for a chat. Anyone may trigger creation; the pool
    // becomes useful only once the admin funds it (and thereby claims it).
    // The caller pays the pool's initial balance and the gas, so repeated
    // CreatePool calls cannot drain the master's fee balance. The pool keeps
    // PoolDeployValue as its storage reserve (plain-TON deploy, no DeployOk
    // echo back to the master); anything above it accrues to the master.
    receive(msg: CreatePool) {
        require(context().value >= PoolDeployValue + CreatePoolGas, "attach at least 0.15 TON");
        let init: StateInit = self.poolInit(msg.chatId);
        send(SendParameters{
            to: contractAddress(init),
            value: PoolDeployValue,
            mode: SendPayGasSeparately,
            bounce: false,
            code: init.code,
            data: init.data
        });
    }

    // TON fee forwarded by a pool on deposit. The value simply accrues to the
    // master balance; the typed body is informational.
    receive(msg: CollectFee) {}

    receive(msg: SetFeeTier) {
        self.requireOwner();
        self.feeTiers.set(msg.tier, msg.depositFeeTon);
    }

    receive(msg: RotateBackendKey) {
        self.requireOwner();
        self.backendPubKey = msg.backendPubKey;
    }

    receive(msg: WithdrawFee) {
        self.requireOwner();
        require(msg.amount <= myBalance() - MasterMinTonForStorage, "insufficient fee balance");
        send(SendParameters{
            to: msg.to,
            value: msg.amount,
            mode: SendPayGasSeparately,
            bounce: false
        });
    }

    fun poolInit(chatId: Int): StateInit {
        return initOf ChatPool(myAddress(), chatId, self.backendPubKey);
    }

    // NOTE: the pool address embeds backendPubKey, so this getter is correct
    // for pools created under the current key. After RotateBackendKey, track
    // pre-rotation pool addresses off-chain.
    get fun poolAddress(chatId: Int): Address {
        return contractAddress(self.poolInit(chatId));
    }

    get fun backendKey(): Int {
        return self.backendPubKey;
    }

    get fun feeTier(tier: Int): Int? {
        return self.feeTiers.get(tier);
    }
}
