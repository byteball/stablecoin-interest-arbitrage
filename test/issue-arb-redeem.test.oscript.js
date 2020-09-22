// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const path = require('path')
const crypto = require('crypto')
const Decimal = require('ocore/formula/common.js').Decimal;
const objectHash = require("ocore/object_hash.js");
const { expect } = require('chai');

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

function number_from_seed(seed) {
	var hash = crypto.createHash("sha256").update(seed.toString(), "utf8").digest("hex");
	var head = hash.substr(0, 16);
	var nominator = new Decimal("0x" + head);
	var denominator = new Decimal("0x1" + "0".repeat(16));
	var num = nominator.div(denominator); // float from 0 to 1
	return num.toNumber();
}

describe('Full circle: issue and redeem shares, arb above, arb below, get management and success fees', function () {
	this.timeout(120000)


	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../node_modules/bonded-stablecoin/bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../node_modules/bonded-stablecoin/bonded-stablecoin-factory.oscript') })
			.with.agent({ daf2: path.join(__dirname, '../node_modules/bonded-stablecoin/define-asset2-forwarder.oscript') })
			.with.agent({ governance: path.join(__dirname, '../node_modules/bonded-stablecoin/governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../node_modules/bonded-stablecoin/deposits.oscript') })
			.with.agent({ pool: path.join(__dirname, '../node_modules/oswap/public/pool.oscript') })
		//	.with.agent({ pool: path.join(__dirname, '../pool3.oscript') })
			.with.agent({ oswapFactory: path.join(__dirname, '../node_modules/oswap/public/factory.oscript') })
			.with.agent({ arb: path.join(__dirname, '../arbitrage-stable.oscript') })
			.with.agent({ arbFactory: path.join(__dirname, '../arbitrage-stable-factory.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
		//	.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
	//	this.explorer = await this.network.newObyteExplorer().ready()
		
		this.bank_aa = this.network.agent.bank

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
	})

	it('Post data feed', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(20)
		await this.network.witnessUntilStable(unit)

		this.target_p2 = 1/price
	})
	
	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.ts = Math.round(Date.now() / 1000)
		this.fee_multiplier = 5
		this.interest_rate = 0.1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.bsf,
			amount: 15000,
			data: {
				reserve_asset: 'base',
				reserve_asset_decimals: 9,
				decimals1: 9,
				decimals2: 2,
				m: 2,
				n: 0.5,
				interest_rate: this.interest_rate,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'GBYTE_USD',
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.bsf)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(6)
		for (let name in vars) {
			if (name.startsWith('curve_')) {
				this.curve_aa = name.substr(6)
				expect(vars[name]).to.be.equal("s1^2 s2^0.5")
			}
		}
		this.asset1 = vars['asset_' + this.curve_aa + '_1'];
		this.asset2 = vars['asset_' + this.curve_aa + '_2'];
		this.asset_stable = vars['asset_' + this.curve_aa + '_stable'];
		this.deposit_aa = vars['deposit_aa_' + this.curve_aa];
		this.governance_aa = vars['governance_aa_' + this.curve_aa];

		const { vars: curve_vars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log('curve vars', curve_vars, this.curve_aa)
		expect(curve_vars['asset1']).to.be.equal(this.asset1)
		expect(curve_vars['asset2']).to.be.equal(this.asset2)
		expect(curve_vars['governance_aa']).to.be.equal(this.governance_aa)
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.equal(1)
		expect(curve_vars['interest_rate']).to.be.equal(0.1)
		expect(parseInt(curve_vars['rate_update_ts'])).to.be.eq(this.ts)

		this.getReserve = (s1, s2) => Math.ceil(1e9*(s1/1e9)**2 * (s2/1e2)**0.5)
		this.getP2 = (s1, s2) => (s1 / 1e9) ** 2 * 0.5 / (s2 / 1e2) ** 0.5
		this.getFee = (avg_reserve, old_distance, new_distance) => Math.ceil(avg_reserve * (new_distance**2 - old_distance**2) * this.fee_multiplier);

		this.buy = (tokens1, tokens2) => {
			const new_supply1 = this.supply1 + tokens1
			const new_supply2 = this.supply2 + tokens2
			const new_reserve = this.getReserve(new_supply1, new_supply2)
			const amount = new_reserve - this.reserve
			const abs_reserve_delta = Math.abs(amount)
			const avg_reserve = (this.reserve + new_reserve)/2
			const p2 = this.getP2(new_supply1, new_supply2)
	
			const old_distance = this.reserve ? Math.abs(this.p2 - this.target_p2) / this.target_p2 : 0
			const new_distance = Math.abs(p2 - this.target_p2) / this.target_p2
			let fee = this.getFee(avg_reserve, old_distance, new_distance);
			if (fee > 0) {
				const reverse_reward = Math.floor((1 - old_distance / new_distance) * this.fast_capacity); // rough approximation
			}

			const fee_percent = round(fee / abs_reserve_delta * 100, 4)
			const reward = old_distance ? Math.floor((1 - new_distance / old_distance) * this.fast_capacity) : 0;
			const reward_percent = round(reward / abs_reserve_delta * 100, 4)

			console.log('p2 =', p2, 'target p2 =', this.target_p2, 'amount =', amount, 'fee =', fee, 'reward =', reward, 'old distance =', old_distance, 'new distance =', new_distance, 'fast capacity =', this.fast_capacity)
	
			this.p2 = p2
			this.distance = new_distance
			if (fee > 0) {
				this.slow_capacity += Math.floor(fee / 2)
				this.fast_capacity += fee - Math.floor(fee / 2)
			}
			else if (reward > 0)
				this.fast_capacity -= reward
			
			if (fee > 0 && reward > 0)
				throw Error("both fee and reward are positive");
			if (fee < 0 && reward < 0)
				throw Error("both fee and reward are negative");
	
			this.supply1 += tokens1
			this.supply2 += tokens2
			this.reserve += amount
	
			return { amount, fee, fee_percent, reward, reward_percent }
		}

		this.supply1 = 0
		this.supply2 = 0
		this.reserve = 0
		this.slow_capacity = 0
		this.fast_capacity = 0
		this.distance = 0
	})


	it('Alice buys tokens', async () => {
		const tokens1 = 1e9
		const tokens2 = 100e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + 1000,
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(parseFloat(parseFloat(vars['p2']).toPrecision(13))).to.be.equal(this.p2)
		expect(vars['slow_capacity']).to.be.undefined
		expect(vars['fast_capacity']).to.be.undefined
		expect(vars['lost_peg_ts']).to.be.undefined

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset1,
				amount: tokens1,
			},
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
		])

	})

	it('Half a year later, Alice exchanges tokens2 for stable tokens', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		const tokens2 = Math.floor(this.supply2 * 0.1)
		const stable_tokens = Math.floor(tokens2 * Math.sqrt(1 + this.interest_rate))

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.deposit_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.deposit_aa, amount: tokens2 }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		const id = unit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.id).to.be.equal(unit)

		const { vars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['supply']).to.be.equal(stable_tokens)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset_stable,
			amount: stable_tokens,
		}])

		expect(vars['deposit_' + id]).to.deep.equalInAnyOrder({
			amount: tokens2,
			stable_amount: stable_tokens,
			owner: this.aliceAddress,
			ts: unitObj.timestamp,
		})

		this.id = id
		this.deposit_stable_tokens = stable_tokens
		this.deposit_tokens2 = tokens2
		
		this.supply = stable_tokens
	})

	it('Alice opens another deposit and gets more stable tokens', async () => {
		const tokens2 = Math.floor(this.supply2 * 0.4)
		const stable_tokens = Math.floor(tokens2 * Math.sqrt(1 + this.interest_rate))
		this.supply += stable_tokens

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.deposit_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.deposit_aa, amount: tokens2 }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		const id = unit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.id).to.be.equal(unit)

		const { vars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['supply']).to.be.equal(this.supply)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset_stable,
			amount: stable_tokens,
		}])

		expect(vars['deposit_' + id]).to.deep.equalInAnyOrder({
			amount: tokens2,
			stable_amount: stable_tokens,
			owner: this.aliceAddress,
			ts: unitObj.timestamp,
		})
	})

	
	it('Bob defines a new oswap pool', async () => {
		const swap_fee = 0.003e11
		const [asset0, asset1] = (number_from_seed(this.asset2) > number_from_seed(this.asset_stable)) ? [this.asset2, this.asset_stable] : [this.asset_stable, this.asset2]
		this.asset0 = asset0
		const definition = ['autonomous agent', {
			base_aa: this.network.agent.pool,
			params: {
				asset0,
				asset1,
				swap_fee,
				factory: this.network.agent.oswapFactory,
			}
		}];
		const address = objectHash.getChash160(definition);
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.oswapFactory,
			amount: 10000,
			data: {
				create: 1,
				asset0,
				asset1,
				swap_fee,
				address,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.oswapFactory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(7)
		expect(vars['pools.' + address + '.asset0']).to.be.equal(asset0)
		expect(vars['pools.' + address + '.asset1']).to.be.equal(asset1)
		expect(vars['pools.' + address + '.asset']).to.be.validUnit

		this.pool_shares_asset = vars['pools.' + address + '.asset']
		this.oswap_aa = address

		this.get_optimal_deposit_amount = async () => {
			let { time_error, timestamp } = await this.network.timetravel({ shift: '0s' })
			expect(time_error).to.be.undefined
			timestamp = Math.round(timestamp / 1000)

			const term = (timestamp - this.ts) / (360 * 24 * 3600); // in years
			const target_price = (1 + this.interest_rate) ** term;
			console.log('target price', target_price)
	
			const fee = 0.003;
			const balance = await this.bob.getOutputsBalanceOf(this.oswap_aa)
			console.log('oswap balance', balance)
			const interest_balance = balance[this.asset2].stable + balance[this.asset2].pending;
			const stable_balance = balance[this.asset_stable].stable + balance[this.asset_stable].pending;
			const net_share = 1 - fee;
			const deposit_amount = (Math.sqrt(interest_balance * stable_balance * net_share * target_price) - stable_balance) / (net_share * target_price);
			return Math.floor(deposit_amount);
		};

	})
	
	it('Bob defines a new arbitrage AA', async () => {
		this.management_fee = 0.01
		this.success_fee = 0.1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.arbFactory,
			amount: 10000,
			data: {
				oswap_aa: this.oswap_aa,
				deposit_aa: this.deposit_aa,
				manager: this.bobAddress,
				management_fee: this.management_fee,
				success_fee: this.success_fee,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.arb_aa = response.response.responseVars.address
		expect(this.arb_aa).to.be.validAddress

		const { vars } = await this.bob.readAAStateVars(this.network.agent.arbFactory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(1)

		const { vars: arb_vars } = await this.bob.readAAStateVars(this.arb_aa)
		console.log('arb vars', arb_vars)
		this.shares_asset = arb_vars['shares_asset']
		expect(this.shares_asset).to.be.validUnit

		expect(vars['arb_' + this.arb_aa]).to.be.deep.equalInAnyOrder({
			oswap_aa: this.oswap_aa,
			deposit_aa: this.deposit_aa,
			manager: this.bobAddress,
			management_fee: this.management_fee,
			success_fee: this.success_fee,
			interest_asset: this.asset2,
			stable_asset: this.asset_stable,
			curve_aa: this.curve_aa,
			shares_asset: this.shares_asset,
		})
	})


	it('Alice buys shares in arbitrage AA', async () => {
		const tokens2 = Math.floor(this.supply2 / 4)

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.arb_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.arb_aa, amount: tokens2 }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['shares_supply']).to.be.equal(tokens2)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.shares_asset,
			amount: tokens2,
		}])

		this.arb_balance = tokens2
		this.shares_supply = tokens2
	})

	it('Alice sends interest token to bank AA', async () => {
		const tokens2 = Math.floor(this.supply2 / 4)

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.bank_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.bank_aa, amount: tokens2 }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.bank_aa)
		console.log(vars)
		expect(vars['balance_' + this.aliceAddress + '_' + this.asset2]).to.be.equal(tokens2)

		this.asset2_in_bank = tokens2
	})

	it('Alice sends stable token to bank AA', async () => {
		const amount = Math.floor(this.supply * 0.4)

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset_stable,
			base_outputs: [{ address: this.bank_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.bank_aa, amount: amount }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.bank_aa)
		console.log(vars)
		expect(vars['balance_' + this.aliceAddress + '_' + this.asset_stable]).to.be.equal(amount)

		this.stable_asset_in_bank = amount
	})


	it('Alice instructs the bank to send interest and stable tokens to the pool', async () => {
		console.log('interest', this.asset2_in_bank)
		console.log('stable', this.stable_asset_in_bank)
		const recipients = [
			{
				asset: this.asset2,
				address: this.oswap_aa,
				amount: this.asset2_in_bank,
			},
			{
				asset: this.asset_stable,
				address: this.oswap_aa,
				amount: this.stable_asset_in_bank,
			},
			{
				asset: 'base',
				address: this.oswap_aa,
				amount: 1e3,
			},
		];
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.bank_aa,
			amount: 1e4,
			data: {
				recipients,
				to: this.aliceAddress,
				withdraw: 1,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.bank_aa)
		console.log(vars)
		expect(vars['balance_' + this.aliceAddress + '_' + this.asset2]).to.be.equal(0)
		expect(vars['balance_' + this.aliceAddress + '_' + this.asset_stable]).to.be.equal(0)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		recipients.forEach(recipient => {
			if (recipient.asset === 'base')
				delete recipient.asset
		})
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder(recipients)
		const data = unitObj.messages.find(message => message.app === 'data').payload
		expect(data).to.deep.equalInAnyOrder({ to: this.aliceAddress })

		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit

		const { unitObj: unitObj2 } = await this.alice.getUnitInfo({ unit: response2.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([{
			asset: this.pool_shares_asset,
			address: this.aliceAddress,
			amount: this.asset0 == this.asset2 ? this.asset2_in_bank : this.stable_asset_in_bank,
		}])
	})


	/*it('Alice tries to trigger arbitrage above the peg but fails because she is not the manager', async () => {
		// now stable is above the peg, let's open a deposit and sell the stable token
		const amount = Math.floor(this.supply2/160)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				open_deposit: 1,
				amount: amount,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("you are not the manager")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})*/

	it('Alice triggers arbitrage above the peg', async () => {
		// now stable is above the peg, let's open a deposit and sell the stable token
		const amount = await this.get_optimal_deposit_amount();
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				open_deposit: 1,
			//	amount: amount,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['status']).to.be.undefined
		expect(vars['expected_stable_amount']).to.be.undefined
		expect(vars['expected_interest_amount']).to.be.undefined
		expect(vars['balance_in_challenging_period']).to.be.undefined
		expect(vars['id']).to.be.undefined
		
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			asset: this.asset2,
			address: this.deposit_aa,
			amount: amount,
		}])
		const balance = await this.alice.getOutputsBalanceOf(this.arb_aa)
		console.log('arb balance', balance)
		expect(balance[this.asset_stable]).to.be.undefined
		expect(balance[this.asset2].stable).to.be.gt(this.arb_balance)
		this.arb_balance = balance[this.asset2].stable
	})

	it('Alice tries to trigger arbitrage below the peg but fails because she is not the manager', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				close_deposit: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("you are not the manager")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Bob tries to trigger arbitrage below the peg but fails because there is no arbitrage opportunity in this direction', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				close_deposit: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("would lose money")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('1/2 year later, Alice exchanges stable token for interest token through oswap, thus pushing the price below the peg', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		const amount = Math.floor(this.supply * 0.2)

		const { result: interest_amount, error: getterError } = await this.alice.executeGetter({
			aaAddress: this.arb_aa,
			getter: 'get_oswap_output',
			args: [amount, this.asset_stable, this.asset2]
		})
		expect(getterError).to.be.null
		expect(interest_amount).to.be.gt(0)

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset_stable,
			base_outputs: [{ address: this.oswap_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.oswap_aa, amount: amount }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			asset: this.asset2,
			address: this.aliceAddress,
			amount: interest_amount,
		}])

	})

	it('Bob tries to trigger arbitrage above the peg but fails', async () => {
		// now stable is above the peg, let's open a deposit and sell the stable token
	//	const amount = Math.floor(this.supply2/160)
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				open_deposit: 1,
			//	amount: amount,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.equal("would lose money")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob triggers arbitrage below the peg', async () => {
		const stable_tokens = Math.floor(this.deposit_tokens2 * (1 + this.interest_rate))
		this.interest = stable_tokens - this.deposit_stable_tokens
		const { result: interest_amount, error: getterError } = await this.alice.executeGetter({
			aaAddress: this.arb_aa,
			getter: 'get_oswap_input',
			args: [stable_tokens, this.asset2, this.asset_stable]
		})
		expect(getterError).to.be.null
		expect(interest_amount).to.be.gt(0)
		expect(interest_amount).to.be.lt(this.deposit_tokens2) // profitable

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				close_deposit: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['status']).to.be.undefined
		expect(vars['expected_stable_amount']).to.be.undefined
		expect(vars['expected_interest_amount']).to.be.undefined
		expect(vars['id']).to.be.undefined
		expect(vars['balance_in_challenging_period']).to.be.equal(this.deposit_tokens2)
		expect(vars['amount_' + this.id]).to.be.equal(this.deposit_tokens2)	

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			asset: this.asset2,
			address: this.oswap_aa,
			amount: interest_amount,
		}])

		const { vars: dvars } = await this.bob.readAAStateVars(this.deposit_aa)
		console.log(dvars)
		expect(dvars['deposit_' + this.id + '_force_close']).to.be.deep.equalInAnyOrder({
			ts: unitObj.timestamp,
			closer: this.arb_aa,
			interest: this.interest,
			protection_ratio: 0,
		})
	})

	it('13 hours later, Alice commits the force-close', async () => {
		const { time_error } = await this.network.timetravel({shift: '13h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.deposit_aa,
			amount: 1e4,
			data: {
				commit_force_close: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: dvars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(dvars)
		expect(dvars['deposit_' + this.id + '_force_close']).to.be.undefined

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset2,
				address: this.bank_aa,
				amount: this.deposit_tokens2,
			},
			{
				asset: this.asset_stable,
				address: this.aliceAddress,
				amount: this.interest,
			},
		])
		const data = unitObj.messages.find(message => message.app === 'data').payload
		expect(data).to.deep.equalInAnyOrder({
			recipients: [{
				asset: this.asset2,
				address: this.arb_aa,
				amount: this.deposit_tokens2,
			}]
		})

		const { vars: bvars } = await this.alice.readAAStateVars(this.bank_aa)
		console.log(bvars)
		expect(bvars['balance_' + this.arb_aa + '_' + this.asset2]).to.be.eq(this.deposit_tokens2)

	})

	it('Alice unlocks the force-close', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				unlock: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['amount_' + this.id]).to.be.undefined
		expect(vars['balance_in_challenging_period']).to.be.eq(0)
	})

	it('Alice requests withdrawal from the bank for the arb AA', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw_from_bank: 1,
				asset: this.asset2,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.bank_aa)
		console.log(vars)
		expect(vars['balance_' + this.arb_aa + '_' + this.asset2]).to.be.eq(0)

		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		const { unitObj } = await this.alice.getUnitInfo({ unit: response2.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset2,
				address: this.arb_aa,
				amount: this.deposit_tokens2,
			},
		])

		const balance = await this.alice.getOutputsBalanceOf(this.arb_aa)
		console.log('arb balance', balance)
		expect(balance[this.asset_stable]).to.be.undefined
		expect(balance[this.asset2].stable).to.be.gt(this.arb_balance)
		this.arb_balance = balance[this.asset2].stable
	})

	it('Bob withdraws his management fee from arb AA', async () => {
		const term = (180 + 180 + 13 / 24) / 360
		const mf = Math.floor(this.shares_supply * ((1 + this.management_fee) ** term - 1))
		console.log('management fee', mf, 'shares')
		this.shares_supply += mf
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw_management_fee: 1,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.bobAddress,
				amount: mf,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['shares_supply']).to.be.eq(this.shares_supply)
		expect(vars['last_mf_withdrawal_ts']).to.be.eq(unitObj.timestamp)

	})

	it('Bob withdraws his success fee from arb AA', async () => {
		const balance = await this.bob.getOutputsBalanceOf(this.arb_aa)
		console.log('arb balance', balance)
		expect(balance[this.asset_stable]).to.be.undefined
		expect(balance[this.asset2].stable).to.be.eq(this.arb_balance)
		const share_price = this.arb_balance / this.shares_supply
		const sf = Math.floor(this.success_fee * this.shares_supply * (share_price - 1))
		console.log('success fee', sf)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw_success_fee: 1,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset2,
				address: this.bobAddress,
				amount: sf,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['shares_supply']).to.be.eq(this.shares_supply)
		expect(vars['last_mf_withdrawal_ts']).to.be.eq(unitObj.timestamp)
		expect(round(vars['last_sf_withdrawal_share_price'], 14)).to.be.eq(round(share_price, 14))

		this.arb_balance -= sf
	})

	it('Alice tries to withdraws bytes from arb AA', async () => {
		const amount = 30000
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw_bytes: 1,
				amount,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.eq("neither case is true in messages")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob withdraws bytes from arb AA', async () => {
		const amount = 30000
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw_bytes: 1,
				amount,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['shares_supply']).to.be.eq(this.shares_supply)
	})

	it('Alice redeems her shares', async () => {
		const amount = Math.floor(this.shares_supply/2)
		const share_price = this.arb_balance / this.shares_supply
		const amount_out = Math.floor(amount * share_price)
		this.shares_supply -= amount

		const { unit, error } = await this.alice.sendMulti({
			asset: this.shares_asset,
			base_outputs: [{ address: this.arb_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.arb_aa, amount: amount }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.arb_aa)
		console.log(vars)
		expect(vars['shares_supply']).to.be.eq(this.shares_supply)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset2,
				address: this.aliceAddress,
				amount: amount_out,
			},
		])
	})

	after(async () => {
		await this.network.stop()
	})
})
