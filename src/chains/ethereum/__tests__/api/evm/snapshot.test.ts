const assert = require("assert");
import { join } from "path";
import getProvider from "../../helpers/getProvider";
import compile from "../../helpers/compile";
import { Quantity } from "@ganache/utils";

const eth = "0x" + (1000000000000000000n).toString(16);

describe("api", function() {
  describe("evm", function() {
    describe("snapshot / revert", function() {
      let context = {} as any;
      let startingBalance;
      let snapshotId;

      before("Set up provider and deploy a contract", async function() {
        const contract = compile(join(__dirname, "./snapshot.sol"));

        const p = await getProvider({
          defaultTransactionGasLimit: Quantity.from(6721975)
        });
        const accounts = await p.send("eth_accounts");
        const from = accounts[3];

        await p.send("eth_subscribe", ["newHeads"]);

        const transactionHash = await p.send("eth_sendTransaction", [
            {
              from,
              data: contract.code
            }
        ]);
      
        await p.once("message");

        const receipt = await p.send("eth_getTransactionReceipt", [transactionHash]);
        assert.strictEqual(receipt.blockNumber, "0x1");

        const to = receipt.contractAddress;
        const methods = contract.contract.evm.methodIdentifiers;

        context.send = p.send.bind(p);
        context.accounts = accounts;
        context.provider = p;
        context.instance = {
          n: () => {
            const tx = {
              to,
              data: "0x" + methods["n()"]
            }
            return p.send("eth_call", [tx]);
          },
          inc: async (tx: any) => {
            tx.from ||= accounts[0];
            tx.to = to
            tx.data = "0x" + methods["inc()"];
            const hash = await p.send("eth_sendTransaction", [tx]);
            await p.once("message");
            return await p.send("eth_getTransactionByHash", [hash]);
          }
        }
      });

      before("send a transaction then make a checkpoint", async function() {
        const { accounts, send, provider } = context

        await send("eth_sendTransaction",[{
          from: accounts[0],
          to: accounts[1],
          value: eth,
          gas: 90000
        }]);

        await provider.once("message");

        // Since transactions happen immediately, we can assert the balance.
        let balance = await send("eth_getBalance", [accounts[0]]);
        balance = BigInt(balance);

        // Assert the starting balance is where we think it is, including tx costs.
        assert(balance > 98900000000000000000 && balance < 99000000000000000000);
        startingBalance = balance;

        // Now checkpoint.
        snapshotId = await send("evm_snapshot");
      });

      it("rolls back successfully", async() => {
        const { accounts, send, provider } = context;

        // Send another transaction, check the balance, then roll it back to the old one and check the balance again.
        const transactionHash = await send("eth_sendTransaction",[{
          from: accounts[0],
          to: accounts[1],
          value: eth,
          gas: 90000
        }]);

        await provider.once("message");

        let balance = await send("eth_getBalance", [accounts[0]]);
        balance = BigInt(balance);

        // Assert the starting balance is where we think it is, including tx costs.
        assert(balance > 97900000000000000000n && balance < 98000000000000000000n);

        const status = await send("evm_revert", [snapshotId]);

        assert(status, "Snapshot should have returned true");

        let revertedBalance = await send("eth_getBalance", [accounts[0]]);
        revertedBalance = BigInt(revertedBalance);

        assert(revertedBalance === startingBalance, "Should have reverted back to the starting balance");

        const oldReceipt = await send("eth_getTransactionReceipt", [transactionHash]);
        assert.strictEqual(oldReceipt, null, "Receipt should be null as it should have been removed");
      });

      it("returns false when reverting a snapshot that doesn't exist", async() => {
        const { send } = context;

        const snapShotId1 = await send("evm_snapshot");
        const snapShotId2 = await send("evm_snapshot");
        const response1 = await send("evm_revert", [snapShotId1]);
        assert.strictEqual(response1, true, "Reverting a snapshot that exists does not work");
        const response2 = await send("evm_revert", [snapShotId2]);
        assert.strictEqual(response2, false, "Reverting a snapshot that no longer exists does not work");
        const response3 = await send("evm_revert", [snapShotId1]);
        assert.strictEqual(response3, false, "Reverting a snapshot that hasn't already been reverted does not work");
        const response4 = await send("evm_revert", [999]);
        assert.strictEqual(response4, false, "Reverting a snapshot that has never existed does not work");
      });

      it("checkpoints and reverts without persisting contract storage", async() => {
        const { accounts, instance, send } = context;

        const snapShotId = await send("evm_snapshot");
        const n1 = await instance.n();
        assert.strictEqual(parseInt(n1), 42, "Initial n is not 42");

        await instance.inc({ from: accounts[0] });
        const n2 = await instance.n();
        assert.strictEqual(parseInt(n2), 43, "n is not 43 after first call to `inc`");

        await send("evm_revert", [snapShotId]);
        const n3 = await instance.n();
        assert.strictEqual(parseInt(n3), 42, "n is not 42 after reverting snapshot");

        // this is the real test. what happened was that the vm's contract storage
        // trie cache wasn't cleared when the vm's stateManager cache was cleared.
        await instance.inc({ from: accounts[0] });
        const n4 = await instance.n();
        assert.strictEqual(parseInt(n4), 43, "n is not 43 after calling `inc` again");
      });

      it("evm_revert rejects invalid subscriptionId types without crashing", async() => {
        const { send } = context;
        const ids = [{ foo: "bar" }, true, false, 0.5, Infinity, -Infinity];
        await Promise.all(
          ids.map((id) => assert.rejects(send("evm_revert", [id]), /Cannot wrap a .+? as a json-rpc type/, "evm_revert did not reject as expected"))
        );
      });

      it("evm_revert rejects null/undefined subscriptionId values", async() => {
        const { send } = context;
        const ids = [null, undefined];
        await Promise.all(
          ids.map((id) =>
            assert.rejects(send("evm_revert", [id]), /invalid snapshotId/, "evm_revert did not reject as expected")
          )
        );
      });

      it("evm_revert returns false for out-of-range subscriptionId values", async() => {
        const { send } = context;
        const ids = [-1, Buffer.from([0])];
        const promises = ids.map((id) => send("evm_revert", [id]).then(result => assert.strictEqual(result, false)));
        await Promise.all(promises);
      });
    });
  });
});
