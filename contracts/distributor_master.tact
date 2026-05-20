import "@stdlib/deploy";
import "@stdlib/ownable";
import "./distributor_messages.tact";
import "./chat_pool.tact";

const MasterMinTonForStorage: Int = ton("0.05");
const PoolDeployValue: Int = ton("0.1");

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
    receive(msg: CreatePool) {
        let init: StateInit = self.poolInit(msg.chatId);
        send(SendParameters{
            to: contractAddress(init),
            value: PoolDeployValue,
            mode: SendPayGasSeparately,
            bounce: false,
            body: Deploy{queryId: 0}.toCell(),
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
