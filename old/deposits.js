"use strict";

const _ = require('lodash');
const network = require('ocore/network.js');
const walletGeneral = require('ocore/wallet_general.js');
const dag = require('aalib/dag.js');

class DepositAA {
	#deposit_aa;
	#rate_update_ts;
	#interest_rate;
	#growth_factor;
	#stable_asset;
	#deposit_params;
	
	#assocDeposits = {};
	#assocCloses = {};
	#assocPendingCloses = {};
	
	constructor(deposit_aa, stable_asset, interest_rate, rate_update_ts, growth_factor, deposit_params, assocDepositsAndCloses) {
		this.#deposit_aa = deposit_aa;
		this.#stable_asset = stable_asset;
		this.#interest_rate = interest_rate;
		this.#rate_update_ts = rate_update_ts;
		this.#growth_factor = growth_factor;
		this.#deposit_params = deposit_params;
		
		// initialize deposits
		for (let name in assocDepositsAndCloses) {
			let id = name.substr('deposit_'.length, 44);
			if (name.endsWith('_force_close'))
				this.#assocCloses[id] = assocDepositsAndCloses[name];
			else
				this.#assocDeposits[id] = assocDepositsAndCloses[name];
		}
		console.log('-- existing deposits', this.#assocDeposits);
		console.log('-- existing closes', this.#assocCloses);
	}

	static async create(deposit_aa) {
		const stable_asset = await dag.readAAStateVar(deposit_aa, 'asset');
		const curve_aa = await dag.executeGetter(deposit_aa, 'get_curve_aa');
		const deposit_params = await dag.executeGetter(deposit_aa, 'get_deposit_params');
		const growth_factor = await dag.readAAStateVar(curve_aa, 'growth_factor');
		const interest_rate = await dag.readAAStateVar(curve_aa, 'interest_rate');
		const rate_update_ts = await dag.readAAStateVar(curve_aa, 'rate_update_ts');

		// initialize deposits
		const assocDepositsAndCloses = await dag.readAAStateVars(deposit_aa, 'deposit_');

		walletGeneral.addWatchedAddress(deposit_aa, () => { });
		network.addLightWatchedAa(deposit_aa, null, err => {
			if (err)
				throw Error(err);
		});
		return new DepositAA(deposit_aa, stable_asset, interest_rate, rate_update_ts, growth_factor, deposit_params, assocDepositsAndCloses);
	}



	getTargetPrice() {
		const term = (Math.round(Date.now() / 1000) - this.#rate_update_ts) / (360 * 24 * 3600); // in years
		return this.#growth_factor * (1 + this.#interest_rate) ** term;
	}

	isBeingClosed(id) {
		for (let unit in this.#assocPendingCloses)
			if (this.#assocPendingCloses[unit] === id)
				return true;
		return false;
	}

	getDepositsSortedFromWeakest() {
		let deposits = [];
		for (let id in this.#assocDeposits) {
			if (this.#assocCloses[id])
				continue;
			if (this.isBeingClosed(id))
				continue;
			let deposit = this.#assocDeposits[id];
			if (deposit.ts >= Math.round(Date.now() / 1000) - this.#deposit_params.min_deposit_term) // too young
				continue;
			deposit.id = id;
			deposit.protectionRatio = getProtectionRatio(deposit);
			deposits.push(deposit);
		}
		deposits.sort((d1, d2) => d1.protectionRatio - d2.protectionRatio);
		console.log(`deposits sorted from the weakest: ${JSON.stringify(deposits, null, '\t')}`);
		return deposits;
	}

	async closeDeposit(id) {
		let unit = await dag.sendAARequest({
			close_deposit: 1,
			id: id,
		});
		console.log(`closeDeposit ${id}: ${unit}`);
		if (unit)
			this.#assocPendingCloses[unit] = id;
		return unit;
	}

	onAAResponse(objAAResponse) {
		console.log(`deposits onAAResponse`);
		delete this.#assocPendingCloses[objAAResponse.trigger_initial_unit];
		if (!objAAResponse.updatedStateVars && !objAAResponse.bounced)
			throw Error("no vars updated");
		let vars = objAAResponse.updatedStateVars[this.#deposit_aa];
		for (let var_name in vars) {
			let varInfo = vars[var_name];
			if (var_name.startsWith('deposit_')) {
				let id = var_name.substr('deposit_'.length, 44);
				console.log(`${var_name} = ${JSON.stringify(varInfo, null, '\t')}`)
				if (var_name.endsWith('_force_close')) {
					let close = varInfo.value;
					if (close)
						this.#assocCloses[id] = close;
					else
						delete this.#assocCloses[id];
				}
				else {
					let deposit = varInfo.value;
					if (deposit) // add or rewrite
						this.#assocDeposits[id] = deposit;
					else
						delete this.#assocDeposits[id];
				}
			}
		}
	}

	onAARequest(objAARequest) {
		console.log(`deposits onAARequest`);
		const objUnit = objAARequest.unit;
		const messages = objUnit.messages;
		const dataMessage = messages.find(m => m.app === 'data');
		if (!dataMessage)
			return;
		const data = dataMessage.payload;
		const id = data.id;
		if (!id)
			return;
		const deposit = this.#assocDeposits[id];
		if (!deposit)
			return console.log("onDepositAARequest: no such depoit: " + id);
		const paymentInStableAsset = messages.find(m => m.app === 'payment' && m.payload.asset === this.#stable_asset);
		if (!paymentInStableAsset)
			return;
		console.log(`saw a request to close deposit ${id}`);
		const stable_amount = paymentInStableAsset.payload.outputs.find(o => o.address === this.#deposit_aa).amount;
		const author_address = objUnit.authors[0].address;
		const expected_amount = (author_address !== deposit.owner || deposit.interest_recipient && deposit.interest_recipient !== deposit.owner) ? Math.floor(deposit.amount * this.getTargetPrice()) : deposit.stable_amount;
		if (stable_amount < expected_amount)
			return console.log("close request that would fail because it sends insufficient stable coins " + stable_amount + " < " + expected_amount + ": " + objUnit.unit);
		this.#assocPendingCloses[objUnit.unit] = id;
	}



}


function getProtectionRatio(deposit) {
	return (deposit.protection || 0) / deposit.amount;
}

module.exports = DepositAA;
