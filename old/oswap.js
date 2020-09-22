"use strict";

const _ = require('lodash');
const network = require('ocore/network.js');
const walletGeneral = require('ocore/wallet_general.js');
const dag = require('aalib/dag.js');
const aa_state = require('aalib/aa_state.js');

class OswapAA {
	#oswap_aa;
	#fee;
	#interest_asset;
	#stable_asset;
	#committed_balances;
	#balances; // balances after executing all the pending triggers
	#arrPendingSwaps = [];

	constructor(oswap_aa, interest_asset, stable_asset, committed_balances, fee) {
		this.#oswap_aa = oswap_aa;
		this.#interest_asset = interest_asset;
		this.#stable_asset = stable_asset;
		this.#committed_balances = committed_balances;
		this.#balances = _.cloneDeep(committed_balances);
		this.#fee = fee;
		setInterval(() => this.updateBalances(), 60 * 1000);
	}

	static async create(oswap_aa, interest_asset, stable_asset) {
		const definition_rows = await aa_addresses.readAADefinitions([oswap_aa]);
		const definition = JSON.parse(definition_rows[0].definition);
		await aa_addresses.readAADefinitions([definition[1].base_aa]); // make sure the base AA is in our database
		const params = definition[1].params;
		const fee = params.swap_fee / 1e11;
		if (!(params.asset0 === interest_asset && params.asset1 === stable_asset || params.asset1 === interest_asset && params.asset0 === stable_asset))
			throw Error("this oswap is for other assets");
		const committed_balances = await dag.readAABalances(oswap_aa);
		aa_state.addBalances(committed_balances);
		delete committed_balances.base;
		walletGeneral.addWatchedAddress(oswap_aa);
		network.addLightWatchedAa(oswap_aa, null, err => {
			if (err)
				throw Error(err);
		});
		return new OswapAA(oswap_aa, interest_asset, stable_asset, committed_balances, fee);
	}

	async updateBalances() {
		console.log('checking balances');
		const committed_balances = await dag.readAABalances(this.#oswap_aa);
		delete committed_balances.base;
		if (_.isEqual(committed_balances, this.#committed_balances))
			return console.log(`balances match`);
		console.log(`=== balances mismatch: calculated: ${JSON.stringify(this.#committed_balances)}, real: ${JSON.stringify(committed_balances)}`);
		this.#committed_balances = committed_balances;
		this.replayPendingSwaps();
	}

	getOutAsset(in_asset) {
		return in_asset === this.#interest_asset ? this.#stable_asset : this.#interest_asset;
	}

	getOswapOutput(in_amount, in_asset, out_asset) {
		const balances = aa_state.getUpcomingBalances()[this.#oswap_aa];
		const net_in_amount = in_amount * (1 - this.#fee);
		const in_balance = balances[in_asset];
		const out_balance = balances[out_asset];
		const out_amount = out_balance * net_in_amount / (in_balance + net_in_amount);
		return Math.floor(out_amount);
	}

	getOswapInput(out_amount, in_asset, out_asset){
		const balances = aa_state.getUpcomingBalances()[this.#oswap_aa];
		const in_balance = balances[in_asset];
		const out_balance = balances[out_asset];
		if (out_amount >= out_balance)
			return Infinity;
		const net_in_amount = in_balance * out_amount / (out_balance - out_amount);
		const in_amount = net_in_amount / (1 - this.#fee);
		return Math.ceil(in_amount);
	}

	applySwap(in_amount, in_asset) {
		console.log(`applySwap ${in_amount} ${in_asset}`);
		const out_asset = this.getOutAsset(in_asset);
		const out_amount = this.getOswapOutput(in_amount, in_asset, out_asset);
		this.#balances[in_asset] += in_amount;
		this.#balances[out_asset] -= out_amount;
	}

	applySwapAndQueue(in_amount, in_asset, unit) {
		this.applySwap(in_amount, in_asset);
		this.#arrPendingSwaps.push({ in_amount, in_asset, unit });
		console.log(`queued swap ${in_amount} ${in_asset}, unit ${unit}`);
	}

	replayPendingSwaps() {
		console.log(`will replay pending swaps`);
		this.#balances = _.cloneDeep(this.#committed_balances);
		this.#arrPendingSwaps.forEach(swap => this.applySwap(swap.in_amount, swap.in_asset));
	}

	removeExecutedPendingSwaps(trigger_initial_unit) {
		let i = this.#arrPendingSwaps.findIndex(swap => swap.unit === trigger_initial_unit);
		console.log(`removeExecutedPendingSwaps after ${trigger_initial_unit} will remove ${i + 1} swaps`);
		if (i < 0)
			return;
		this.#arrPendingSwaps.splice(0, i + 1);
	}

	// price of interest_asset in terms of stable token
	getPrice() {
		const balances = aa_state.getUpcomingBalances()[this.#oswap_aa];
		return balances[this.#stable_asset] / balances[this.#interest_asset]; 
	}

	getRequiredStableInAmount(target_price) {
		const balances = aa_state.getUpcomingBalances()[this.#oswap_aa];
		// when the price gets closer than the fee to the target, it becomes unprofitable to raise the price further
		const adjusted_target_price = target_price * (1 - this.#fee);
		const new_stable_balance = Math.sqrt(adjusted_target_price * balances[this.#interest_asset] * balances[this.#stable_asset]);
		const delta_stable = new_stable_balance - balances[this.#stable_asset];
	//	if (delta_stable < 0)
	//		throw Error("delta stable < 0");
		return Math.floor(delta_stable / (1 - this.#fee));
	}

	getRequiredInterestInAmount(target_price) {
		const balances = aa_state.getUpcomingBalances()[this.#oswap_aa];
		const adjusted_target_price = target_price / (1 - this.#fee);
		const new_interest_balance = Math.sqrt(balances[this.#interest_asset] * balances[this.#stable_asset] / adjusted_target_price);
		const delta_interest = new_interest_balance - balances[this.#interest_asset];
	//	if (delta_interest < 0)
	//		throw Error("delta interest < 0");
		return Math.floor(delta_interest / (1 - this.#fee));
	}

	onAARequest(objAARequest) {
		console.log('oswap onAARequest');
		const objUnit = objAARequest.unit;
		if (!objUnit.messages) // final-bad
			return false;
		let objMessage = objUnit.messages.find(message => message.app === 'payment' && (message.payload.asset === this.#interest_asset || message.payload.asset === this.#stable_asset));
		if (!objMessage)
			return false;
		let output = objMessage.payload.outputs.find(output => output.address === this.#oswap_aa);
		if (!output)
			return false;
		const asset = objMessage.payload.asset;
		const amount = output.amount;
		
		this.applySwapAndQueue(amount, asset, objUnit.unit);
		return true;
	}

	async onAAResponse(objAAResponse) {
		console.log('oswap onAAResponse');
		this.removeExecutedPendingSwaps(objAAResponse.trigger_initial_unit);
		if (!objAAResponse.bounced) {
			const objJoint = await dag.readJoint(objAAResponse.trigger_unit);
			const objUnit = objJoint.unit;
			const paymentMessagesIn = objUnit.messages.filter(message => message.app === 'payment' && (message.payload.asset === this.#interest_asset || message.payload.asset === this.#stable_asset));
			paymentMessagesIn.forEach(message => {
				const payload = message.payload;
				const amount = payload.outputs.reduce((acc, o) => acc + (o.address === this.#oswap_aa ? o.amount : 0), 0);
				if (!Number.isFinite(amount))
					throw Error("bad amount");
				this.#committed_balances[payload.asset] += amount;
			});
			const paymentMessagesOut = objAAResponse.objResponseUnit.messages.filter(message => message.app === 'payment' && (message.payload.asset === this.#interest_asset || message.payload.asset === this.#stable_asset));
			paymentMessagesOut.forEach(message => {
				const payload = message.payload;
				const amount = payload.outputs.reduce((acc, o) => acc + (o.address !== this.#oswap_aa ? o.amount : 0), 0);
				if (!Number.isFinite(amount))
					throw Error("bad amount");
				this.#committed_balances[payload.asset] -= amount;
			});
		}
		this.replayPendingSwaps();
	}
}

module.exports = OswapAA;
