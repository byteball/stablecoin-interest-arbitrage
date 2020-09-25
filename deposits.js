"use strict";

const _ = require('lodash');
const conf = require('ocore/conf.js');
const walletGeneral = require('ocore/wallet_general.js');
const dag = require('aabot/dag.js');
const aa_state = require('aabot/aa_state.js');

class DepositAA {
	#deposit_aa;
	#rate_update_ts;
	#interest_rate;
	#growth_factor;
	#stable_asset;
	#deposit_params;
	
	
	constructor(deposit_aa, stable_asset, interest_rate, rate_update_ts, growth_factor, deposit_params) {
		this.#deposit_aa = deposit_aa;
		this.#stable_asset = stable_asset;
		this.#interest_rate = interest_rate;
		this.#rate_update_ts = rate_update_ts;
		this.#growth_factor = growth_factor;
		this.#deposit_params = deposit_params;
	}

	static async create(deposit_aa) {
		const params = await dag.readAAParams(deposit_aa);
		const curve_aa = params.curve_aa;
		const stable_asset = await dag.readAAStateVar(deposit_aa, 'asset');
		const deposit_params = await dag.executeGetter(deposit_aa, 'get_deposit_params');
		const growth_factor = await dag.readAAStateVar(curve_aa, 'growth_factor');
		const interest_rate = await dag.readAAStateVar(curve_aa, 'interest_rate');
		const rate_update_ts = await dag.readAAStateVar(curve_aa, 'rate_update_ts');

		await dag.readAAParams(curve_aa); // just to load the definitions of curve AA and its base
		const stateVars = await dag.readAAStateVars(curve_aa, '');
		console.log('curve stateVars', JSON.stringify(stateVars, null, 2))
		aa_state.addStateVars(curve_aa, stateVars);
		
		await aa_state.followAA(deposit_aa);

		return new DepositAA(deposit_aa, stable_asset, interest_rate, rate_update_ts, growth_factor, deposit_params);
	}



	getTargetPrice() {
		const term = (Math.round(Date.now() / 1000) - this.#rate_update_ts) / (360 * 24 * 3600); // in years
		return this.#growth_factor * (1 + this.#interest_rate) ** term;
	}


	getDepositsSortedFromWeakest() {
		let deposits = [];
	//	console.log(`upcoming state vars: ${JSON.stringify(aa_state.getUpcomingStateVars()[this.#deposit_aa], null, '\t')}`);
		const depositVars = aa_state.getUpcomingAAStateVars(this.#deposit_aa);
		for (let var_name in depositVars) {
			if (!var_name.startsWith('deposit_') || var_name.endsWith('_force_close'))
				continue;
			let id = var_name.substr('deposit_'.length, 44);
			if (depositVars[var_name + '_force_close'])
				continue;
			let deposit = depositVars[var_name];
			if (deposit.ts >= Math.round(Date.now() / 1000) - this.#deposit_params.min_deposit_term) // too young
				continue;
			deposit.id = id;
			deposit.protectionRatio = getProtectionRatio(deposit);
			deposits.push(deposit);
		}
		deposits.sort((d1, d2) => d1.protectionRatio - d2.protectionRatio);
		console.log(`deposits sorted from the weakest: ${JSON.stringify(deposits, null, 2)}`);
		return deposits;
	}


	async findOpenChallenges() {
		const unlock = await aa_state.lock();

		let deposits = this.getDepositsSortedFromWeakest();

		const getWeakerId = (force_close) => {
			for (let deposit of deposits) {
				if (deposit.protectionRatio >= force_close.protection_ratio)
					break;
				if (deposit.ts + this.#deposit_params.min_deposit_term + this.#deposit_params.challenge_immunity_period > force_close.ts)
					continue; // too young
				const weaker_protection_withdrawal_ts = deposit.protection_withdrawal_ts || 0;
				if (weaker_protection_withdrawal_ts > force_close.ts - this.#deposit_params.challenge_immunity_period)
					continue; // weaker deposit's protection was decreased recently
				return deposit.id;
			}
			return null;
		}

		const depositVars = aa_state.getUpcomingAAStateVars(this.#deposit_aa);
		let challenges = [];
		for (let var_name in depositVars) {
			if (!depositVars[var_name]) // might be set to false if the variable was only accessed but never assigned
				continue;
			if (!var_name.startsWith('deposit_') || !var_name.endsWith('_force_close'))
				continue;
			let id = var_name.substr('deposit_'.length, 44);
			let force_close = depositVars[var_name];
			console.log(`checking force-close var_name=${var_name}, id=${id}: ${JSON.stringify(force_close, null, 2)}`);
			let weaker_id = getWeakerId(force_close);
			if (weaker_id) {
				console.log(`deposit ${weaker_id} appears to be weaker than force-closed deposit ${id}`)
				challenges.push({ id, weaker_id });
			}
		}
		unlock();
		return challenges;
	}

	async getUncommittedForceCloses() {
		const unlock = await aa_state.lock();
		const depositVars = aa_state.getUpcomingAAStateVars(this.#deposit_aa);
		let ids = [];
		for (let var_name in depositVars) {
			if (!var_name.startsWith('deposit_') || !var_name.endsWith('_force_close'))
				continue;
			let id = var_name.substr('deposit_'.length, 44);
			let force_close = depositVars[var_name];
			if (force_close.closer !== conf.arb_aa) // not ours
				continue;
			if (force_close.ts + this.#deposit_params.challenging_period >= Math.round(Date.now() / 1000)) // not expired yet
				continue;
			ids.push(id);
		}
		unlock();
		return ids;
	}

}


function getProtectionRatio(deposit) {
	return (deposit.protection || 0) / deposit.amount;
}

module.exports = DepositAA;
