# Autonomous Agent for arbitrage between stable and interest tokens on bonded stablecoins

This AA checks the price between the interest and stable tokens on [Oswap.io](https://oswap.io) and if the price deviates from the target, it opens or closes a deposit in stable tokens and sells or buys the stable token on Oswap in order to earn from the difference in prices. See the [introductory article about bonded stablecoins](https://medium.com/obyte/using-multi-dimensional-bonding-curves-to-create-stablecoins-81e857b4355c) to learn about the interest and stable tokens.

Investors provide liquidity to the AA in interest tokens, get shares in exchange, and share the profits from  arbitrage.

All arbitrage actions of the AA are triggered by a companion bot that is also included here. There is a manager who runs the bot and earns a management fee and a success fee.

## Bot operator (manager):

### Installing
```bash
yarn
```

### Testing the AA

Tests are written using the [AA Testkit](https://github.com/valyakin/aa-testkit).

```bash
yarn test
```

### Creating the arbitrage AA

Use your Obyte wallet to send a transaction to the factory AA **5WPGSR5KPKLLRWU75B3FM6O4M7CPYOEA** with the following parameters:
* `deposit_aa`: address of the deposit AA that issues stable tokens in exchange for locking interest tokens on deposits. You can look up its address on the Parameters tab of the corresponding stablecoin, e.g. https://ostable.org/trade/26XAPPPTTYRIOSYNCUV3NS2H57X5LZLJ#parameters.
* `oswap_aa`: address of the Oswap pool AA where interest tokens are traded against stable tokens, e.g. IUSD/OUSD.
* `manager`: address of the manager's bot that will issue arb commands to the AA. You learn this address after running the bot for the first time, see below.
* `management_fee`: yearly fee paid to the manager as a share of all managed assets, set 0.01 for 1%.
* `success_fee`: success fee paid to the manager as a share of the AA's profits, set 0.1 for 10%.

The factory will create a new arbitrage AA, this is the AA that will store the funds of investors. The bot will issue `arb` commands to this AA when it sees an arbitrage opportunity.

Add this arbitrage AA to the `arb_aas` array in your conf.json. A single bot can manage several arb AAs:
```json
{
        "arb_aas": ["BCMFNDHNQDEECEWAKUXYIHFE6GXAJ2F6"]
}
```

### Running the arbitrage bot

```bash
node run.js 2>errlog
```
When the bot starts, it prints its address (`====== my single address: ....`), refill it with some Bytes, so it can send transactions to the AA. Also, specify this address as `manager` when creating the arbitrage AA.

The bot's funds are separate from the AA's funds. The bot needs to hold only small amounts required to trigger the AA.

### How arbitrage works

When the stable token is **overpriced** on Oswap, the AA sends some interest tokens to the deposit AA to open a new deposit, gets stable tokens in exchange, and immediately sends them to Oswap for exchange back to interest tokens. The amount of tokens received from Oswap should be greater than the amount sent to the deposit, this is the AA's profit.

Both trades are executed atomically, as part of a chain of AA triggers. If any of them fails for any reason, the entire chain fails. Before executing the sequence, the AA checks that it would be profitable, and bounces if it wouldn't (this can happen if the price has moved since the command was sent to the AA by the bot). There is no way that the AA can lose investors' money by trying to arb in this direction and this type of arbitrage can be triggered by anybody, not just the manager. If the arb was triggered by a non-manager, they get a reward of 20Kbytes - twice the bounce fees spent on sending the triggering transaction. They lose the bounce fees if the arb fails.

When the stable token is **underpriced** on Oswap, the AA uses its interest tokens to buy the (cheap) stable tokens on Oswap and sends them to the deposit AA to close the weakest deposit and get its interest tokens. The amount of tokens received from closing the deposit should be greater than the amount sent to Oswap, this is the AA's profit.

Again, both trades are executed atomically and the AA checks that they would result in making a profit, otherwise it bounces. However, the AA can lose money by trying to close a deposit that is not the weakest and having its close request challenged by somebody else. The id of the deposit to be closed is indicated by the bot sending the arb command. It is the manager's responsibility to correctly identify the weakest deposit and only the manager is allowed to send such arb commands.

### Withdrawing the management and success fees

The manager's bot can withdraw both fees by sending `withdraw_management_fee` or `withdraw_success_fee` commands to the AA. In response, it receives the fees accrued since the previous withdrawal. Success fee is paid in interest tokens, management fee is paid in shares and dilutes the existing investors.

## Investors:

### Investing/divesting

To provide liquidity and participate in profits of the AA, investors send their interest tokens to the AA and get shares in exchange. The share price is determined by dividing the AA's assets in interest token by the number of the existing shares outstanding.

To redeem, users send their shares back to the AA and get interest tokens in exchange.
