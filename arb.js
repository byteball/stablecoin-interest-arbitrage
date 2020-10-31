"use strict";

const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const aa_state = require('aabot/aa_state.js');
const OswapAA = require('./oswap.js');
const DepositAA = require('./deposits.js');


class Arb {
	#arb_aa;
	
	#interest_asset;
	#stable_asset;

	#oswapAA;
	#depositAA;

	constructor(arb_aa, interest_asset, stable_asset, oswapAA, depositAA) {
		this.#arb_aa = arb_aa;
		this.#interest_asset = interest_asset;
		this.#stable_asset = stable_asset;
		this.#oswapAA = oswapAA;
		this.#depositAA = depositAA;

		const oswap_aa = oswapAA.getAA();
		const deposit_aa = depositAA.getAA();

		eventBus.on("aa_request_applied-" + oswap_aa, () => this.checkPricesAndArb());
		eventBus.on("aa_request_applied-" + deposit_aa, () => this.checkForChallengeableCloses());
	//	eventBus.on("aa_request_applied-" + arb_aa, () => this.checkForChallengeableCloses());
	
		eventBus.on("aa_response_applied-" + oswap_aa, () => this.checkPricesAndArb());
		eventBus.on("aa_response_applied-" + arb_aa, (objAAResponse) => this.onArbAAResponse(objAAResponse));
		eventBus.on("aa_response_applied-" + deposit_aa, () => this.checkForChallengeableCloses());
	
		setInterval(() => this.commitForceCloses(), 3600 * 1000);
		this.commitForceCloses();
	
		setInterval(() => this.unlockForceCloses(), 24 * 3600 * 1000);
		this.unlockForceCloses();
	
		setInterval(() => this.withdrawFromBankAA(), 24 * 3600 * 1000);
		this.withdrawFromBankAA();
	
		this.checkPricesAndArb();
	}

	static async create(arb_aa) {
		const params = await dag.readAAParams(arb_aa);
		const oswap_aa = params.oswap_aa;
		const deposit_aa = params.deposit_aa;
		const curve_aa = await dag.executeGetter(arb_aa, 'get_curve_aa');
		if (params.manager !== operator.getAddress())
			throw Error("I'm not the manager of this arb AA: " + arb_aa);
		const stable_asset = await dag.readAAStateVar(deposit_aa, 'asset');
		const interest_asset = await dag.readAAStateVar(curve_aa, 'asset2');
	
		const oswapAA = await OswapAA.create(oswap_aa, interest_asset, stable_asset);
		const depositAA = await DepositAA.create(deposit_aa);
	
		return new Arb(arb_aa, interest_asset, stable_asset, oswapAA, depositAA);
	}

	getRequiredDepositAmount(target_price) {
		return Math.floor(this.#oswapAA.getRequiredStableInAmount(target_price) / target_price);
	}

	async getDepostsToClose(total_stable_amount) {
		const unlock = await aa_state.lock();
		let deposits = this.#depositAA.getDepositsSortedFromWeakest();
		let selected_deposits = [];
		let max_allowed_protection_ratio;
		for (let i = 0; i < deposits.length; i++){
			let d = deposits[i];
			if (max_allowed_protection_ratio !== undefined && d.protectionRatio > max_allowed_protection_ratio)
				break;
			let stable_amount = (d.owner === this.#arb_aa) ? d.stable_amount : Math.floor(d.amount * this.#depositAA.getTargetPrice());
			if (stable_amount <= total_stable_amount) {
				const interest_amount = this.#oswapAA.getOswapInput(stable_amount, this.#interest_asset, this.#stable_asset);
				selected_deposits.push({ id: d.id, stable_amount, interest_amount });
				total_stable_amount -= stable_amount;
				console.log(`arb ${this.#arb_aa}: selected deposit ${d.id}: ${stable_amount} STABLE, ${interest_amount} INTEREST, protection ${d.protectionRatio}`);
			}
			else if (!max_allowed_protection_ratio) { // we skip it but will take the next deposit only if its ratio is the same
				console.log(`arb ${this.#arb_aa}: deposit ${d.id} is too large: ${stable_amount} STABLE, protection ${d.protectionRatio}`);
				max_allowed_protection_ratio = d.protectionRatio;
			}
		}
		unlock();
		return selected_deposits;
	}


	async openDeposit(amount) {
		let unit = await dag.sendAARequest(this.#arb_aa, {
			open_deposit: 1,
			amount: amount,
		});
		console.log(`arb ${this.#arb_aa}: openDeposit ${amount}: ${unit}`);
		if (unit) {
			const objJoint = await dag.readJoint(unit);
			// upcoming state vars are updated and the next request will see them
			console.log(`arb ${this.#arb_aa}: openDeposit: calling onAARequest manually`);
			await aa_state.onAARequest({ unit: objJoint.unit, aa_address: this.#arb_aa });
		}
	}


	async closeDeposits(total_stable_amount) {
		let selected_deposits = await this.getDepostsToClose(total_stable_amount);
		console.log(`arb ${this.#arb_aa}: need to close deposits for ${total_stable_amount} STABLE, selected deposits:`, JSON.stringify(selected_deposits, null, '\t'));
		for (let i = 0; i < selected_deposits.length; i++) {
			let id = selected_deposits[i].id;
			let unit = await dag.sendAARequest(this.#arb_aa, {
				close_deposit: 1,
				id: id,
			});
			console.log(`arb ${this.#arb_aa}: close deposit ${id}: ${unit}`);
			if (unit) {
				const objJoint = await dag.readJoint(unit);
				// upcoming state vars are updated and the next request will see them
				console.log(`arb ${this.#arb_aa}: closeDeposits: calling onAARequest manually`);
				await aa_state.onAARequest({ unit: objJoint.unit, aa_address: this.#arb_aa });
			}
		}
		console.log(`arb ${this.#arb_aa}: done closing deposits`);
	}


	async checkPricesAndArb() {
		const unlock = await aa_state.lock();
		const price = this.#oswapAA.getPrice();
		const target_price = this.#depositAA.getTargetPrice();
		console.log(`=== new oswap on arb ${this.#arb_aa}: price = ${price}, target_price = ${target_price}`);
		if (price < target_price) { // price of interest token is too low, price of stable token is too high
			console.log(`arb ${this.#arb_aa}: interest token is too cheap, stable token is too expensive, will open a deposit and sell stable token`);
			const deposit_amount = this.getRequiredDepositAmount(target_price);
			console.log(`arb ${this.#arb_aa}: deposit_amount = ${deposit_amount}`);
			if (deposit_amount <= 0) {
				console.log(`arb ${this.#arb_aa}: the difference is smaller than the fee`);
				return unlock();
			}
			
			// check that we are not losing money
			const stable_amount = Math.floor(deposit_amount * target_price);
			const out_amount = this.#oswapAA.getOswapOutput(stable_amount, this.#stable_asset, this.#interest_asset);
			const profit = out_amount - deposit_amount;
			console.log(`arb ${this.#arb_aa}: expected profit ${profit}`);
			unlock();
			if (out_amount <= deposit_amount) {
				if (deposit_amount - out_amount <= 2) // rounding errors
					return console.log(`arb ${this.#arb_aa}: would lose money ${out_amount} <= ${deposit_amount}`);
				throw Error(`arb ${this.#arb_aa}: would lose money ${out_amount} <= ${deposit_amount}`);
			}
			
			await this.openDeposit(deposit_amount);
		}
		else if (price > target_price) { // price of interest token is too high, price of stable token is too low
			console.log(`arb ${this.#arb_aa}: interest token is too expensive, stable token is too cheap, will buy some stable token and close a few deposits`);
			const amount_to_close = this.#oswapAA.getRequiredInterestInAmount(target_price);
			console.log(`arb ${this.#arb_aa}: amount_to_close = ${amount_to_close}`);
			if (amount_to_close <= 0) { // the difference is too small
				console.log(`arb ${this.#arb_aa}: the difference is smaller than the fee`);
				return unlock();
			}
			const stable_amount_to_close = this.#oswapAA.getOswapOutput(amount_to_close, this.#interest_asset, this.#stable_asset);
			unlock();
			await this.closeDeposits(stable_amount_to_close);
		}
		else
			unlock();
	}


	async checkForChallengeableCloses() {
		console.log(`arb ${this.#arb_aa}: looking for challengeable force-closes`);
		let challenges = await this.#depositAA.findOpenChallenges();
		console.log(`arb ${this.#arb_aa}: challengeable force-closes:`, challenges);
		for (let challenge of challenges) {
			let unit = await dag.sendAARequest(this.#arb_aa, {
				challenge_force_close: 1,
				id: challenge.id,
				weaker_id: challenge.weaker_id,
			});
			console.log(`arb ${this.#arb_aa}: challenged force-close of ${challenge.id} with ${challenge.weaker_id}: ${unit}`);
		}
		console.log(`arb ${this.#arb_aa}: done looking for challengeable force-closes`);
	}

	async commitForceCloses() {
		console.log(`arb ${this.#arb_aa}: committing force-closes`);
		let ids = await this.#depositAA.getUncommittedForceCloses();
		console.log(`arb ${this.#arb_aa}: force-closes to commit: `, ids);
		for (let id of ids) {
			let unit = await dag.sendAARequest(this.#depositAA.getAA(), {
				commit_force_close: 1,
				id: id,
			});
			console.log(`arb ${this.#arb_aa}: committed force-close of ${id}: ${unit}`);
			let unit2 = await dag.sendAARequest(this.#arb_aa, {
				unlock: 1,
				id: id,
			});
			console.log(`arb ${this.#arb_aa}: requested unlock of ${id}: ${unit2}`);
		}
		console.log(`arb ${this.#arb_aa}: done committing force-closes`);
	}

	async unlockForceCloses() {
		const unlock = await aa_state.lock();
		console.log(`arb ${this.#arb_aa}: unlocking force-closes`);
		const arbVars = aa_state.getUpcomingAAStateVars(this.#arb_aa);
		let ids = [];
		for (let var_name in arbVars) {
			if (!var_name.startsWith('amount_'))
				continue;
			let amount = arbVars[var_name];
			if (!amount) // deleted var set to false
				continue;
			let id = var_name.substr('amount_'.length, 44);
			console.log(`arb ${this.#arb_aa}: will unlock ${amount} from force-closing deposit ${id}`);
			ids.push(id);
		}
		console.log(`arb ${this.#arb_aa}: force-closes to unlock: `, ids);
		for (let id of ids) {
			let unit = await dag.sendAARequest(this.#arb_aa, {
				unlock: 1,
				id: id,
			});
			console.log(`arb ${this.#arb_aa}: requested unlock of ${id}: ${unit}`);
		}
		console.log(`arb ${this.#arb_aa}: done unlocking force-closes`);
		unlock();
	}

	async withdrawFromBankAA() {
		const prefix = 'balance_' + this.#arb_aa + '_';
		const balances = await dag.readAAStateVars(conf.bank_aa, prefix);
		console.log(`arb ${this.#arb_aa}: bank balances`, balances);
		for (let asset of [this.#interest_asset, this.#stable_asset]) {
			if (balances[prefix + asset]) {
				let unit = await dag.sendAARequest(conf.bank_aa, {
					withdraw: 1,
					recipients: [{ address: this.#arb_aa, asset, amount: balances[prefix + asset] }],
				});
				console.log(`arb ${this.#arb_aa}: requested withdrawal from bank of ${asset}: ${unit}`);
			}
		}
	}

	onArbAAResponse(objAAResponse) {
		if (objAAResponse.bounced && objAAResponse.trigger_address === operator.getAddress())
			console.log(`=== our request ${objAAResponse.trigger_unit} to arb ${this.#arb_aa} bounced with error`, objAAResponse.response.error);
	}	

}


let arbAAs = {};

async function startWatching() {
	for (let arb_aa of conf.arb_aas)
		arbAAs[arb_aa] = await Arb.create(arb_aa);
}


exports.startWatching = startWatching;

