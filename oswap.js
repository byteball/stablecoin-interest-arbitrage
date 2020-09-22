"use strict";

const _ = require('lodash');
const aa_addresses = require('ocore/aa_addresses.js');
const walletGeneral = require('ocore/wallet_general.js');
const dag = require('aabot/dag.js');
const aa_state = require('aabot/aa_state.js');

class OswapAA {
	#oswap_aa;
	#fee;
	#interest_asset;
	#stable_asset;

	constructor(oswap_aa, interest_asset, stable_asset, fee) {
		this.#oswap_aa = oswap_aa;
		this.#interest_asset = interest_asset;
		this.#stable_asset = stable_asset;
		this.#fee = fee;
	}

	static async create(oswap_aa, interest_asset, stable_asset) {
		const params = await dag.readAAParams(oswap_aa);
		const fee = params.swap_fee / 1e11;
		if (!(params.asset0 === interest_asset && params.asset1 === stable_asset || params.asset1 === interest_asset && params.asset0 === stable_asset))
			throw Error("this oswap is for other assets");
		
		const factory_aa = params.factory;
		await aa_addresses.readAADefinitions([factory_aa]); // to have the definition in our database
		const stateVars = await dag.readAAStateVars(factory_aa, '');
		console.log('factory stateVars', JSON.stringify(stateVars, null, 2))
		aa_state.addStateVars(factory_aa, stateVars);

		await aa_state.followAA(oswap_aa);
		
		return new OswapAA(oswap_aa, interest_asset, stable_asset, fee);
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

}

module.exports = OswapAA;
