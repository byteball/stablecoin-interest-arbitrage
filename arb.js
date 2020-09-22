"use strict";

const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const aa_state = require('aabot/aa_state.js');
const OswapAA = require('./oswap.js');
const DepositAA = require('./deposits.js');

let interest_asset;
let stable_asset;

let deposit_aa;

let oswapAA;
let depositAA;


// above the peg

function getRequiredDepositAmount(target_price) {
	return Math.floor(oswapAA.getRequiredStableInAmount(target_price) / target_price);
}

// below the peg

async function getDepostsToClose(total_stable_amount) {
	const unlock = await aa_state.lock();
	let deposits = depositAA.getDepositsSortedFromWeakest();
	let selected_deposits = [];
	let max_allowed_protection_ratio;
	for (let i = 0; i < deposits.length; i++){
		let d = deposits[i];
		if (max_allowed_protection_ratio && d.protectionRatio > max_allowed_protection_ratio)
			break;
		let stable_amount = (d.owner === conf.arb_aa) ? d.stable_amount : Math.floor(d.amount * depositAA.getTargetPrice());
		if (stable_amount <= total_stable_amount) {
			const interest_amount = oswapAA.getOswapInput(stable_amount, interest_asset, stable_asset);
			selected_deposits.push({ id: d.id, stable_amount, interest_amount });
			total_stable_amount -= stable_amount;
			console.log(`selected deposit ${d.id}: ${stable_amount} STABLE, ${interest_amount} INTEREST, protection ${d.protectionRatio}`);
		}
		else if (!max_allowed_protection_ratio) { // we skip it but will take the next deposit only if its ratio is the same
			console.log(`deposit ${d.id} is too large: ${stable_amount} STABLE, protection ${d.protectionRatio}`);
			max_allowed_protection_ratio = d.protectionRatio;
		}
	}
	unlock();
	return selected_deposits;
}


async function openDeposit(amount) {
	let unit = await dag.sendAARequest(conf.arb_aa, {
		open_deposit: 1,
		amount: amount,
	});
	console.log(`openDeposit ${amount}: ${unit}`);
	if (unit) {
		const objJoint = await dag.readJoint(unit);
		// upcoming state vars are updated and the next request will see them
		console.log(`openDeposit: calling onAARequest manually`);
		await aa_state.onAARequest({ unit: objJoint.unit, aa_address: conf.arb_aa });
	}
}


async function closeDeposits(total_stable_amount) {
	let selected_deposits = await getDepostsToClose(total_stable_amount);
	console.log(`need to close deposits for ${total_stable_amount} STABLE, selected deposits:`, JSON.stringify(selected_deposits, null, '\t'));
	for (let i = 0; i < selected_deposits.length; i++) {
		let id = selected_deposits[i].id;
		let unit = await dag.sendAARequest(conf.arb_aa, {
			close_deposit: 1,
			id: id,
		});
		console.log(`close deposit ${id}: ${unit}`);
		if (unit) {
			const objJoint = await dag.readJoint(unit);
			// upcoming state vars are updated and the next request will see them
			console.log(`closeDeposits: calling onAARequest manually`);
			await aa_state.onAARequest({ unit: objJoint.unit, aa_address: conf.arb_aa });
		}
	}
	console.log(`done closing deposits`);
}

async function checkPricesAndArb() {
	const unlock = await aa_state.lock();
	const price = oswapAA.getPrice();
	const target_price = depositAA.getTargetPrice();
	console.log(`=== new oswap: price = ${price}, target_price = ${target_price}`);
	if (price < target_price) { // price of interest token is too low, price of stable token is too high
		console.log(`interest token is too cheap, stable token is too expensive, will open a deposit and sell stable token`);
		const deposit_amount = getRequiredDepositAmount(target_price);
		console.log(`deposit_amount = ${deposit_amount}`);
		if (deposit_amount <= 0) {
			console.log(`the difference is smaller than the fee`);
			return unlock();
		}
		
		// check that we are not losing money
		const stable_amount = Math.floor(deposit_amount * target_price);
		const out_amount = oswapAA.getOswapOutput(stable_amount, stable_asset, interest_asset);
		const profit = out_amount - deposit_amount;
		console.log(`expected profit ${profit}`);
		unlock();
		if (out_amount <= deposit_amount) {
			if (deposit_amount - out_amount <= 2) // rounding errors
				return console.log(`would lose money ${out_amount} <= ${deposit_amount}`);
			throw Error(`would lose money ${out_amount} <= ${deposit_amount}`);
		}
		
		await openDeposit(deposit_amount);
	}
	else if (price > target_price) { // price of interest token is too high, price of stable token is too low
		console.log(`interest token is too expensive, stable token is too cheap, will buy some stable token and close a few deposits`);
		const amount_to_close = oswapAA.getRequiredInterestInAmount(target_price);
		console.log(`amount_to_close = ${amount_to_close}`);
		if (amount_to_close <= 0) { // the difference is too small
			console.log(`the difference is smaller than the fee`);
			return unlock();
		}
		const stable_amount_to_close = oswapAA.getOswapOutput(amount_to_close, interest_asset, stable_asset);
		unlock();
		await closeDeposits(stable_amount_to_close);
	}
	else
		unlock();
}

async function checkForChallengeableCloses() {
	console.log(`looking for challengeable force-closes`);
	let challenges = await depositAA.findOpenChallenges();
	console.log(`challengeable force-closes:`, challenges);
	for (let challenge of challenges) {
		let unit = await dag.sendAARequest(conf.arb_aa, {
			challenge_force_close: 1,
			id: challenge.id,
			weaker_id: challenge.weaker_id,
		});
		console.log(`challenged force-close of ${challenge.id} with ${challenge.weaker_id}: ${unit}`);
	}
	console.log(`done looking for challengeable force-closes`);
}

async function commitForceCloses() {
	console.log(`committing force-closes`);
	let ids = await depositAA.getUncommittedForceCloses();
	console.log(`force-closes to commit: `, ids);
	for (let id of ids) {
		let unit = await dag.sendAARequest(deposit_aa, {
			commit_force_close: 1,
			id: id,
		});
		console.log(`committed force-close of ${id}: ${unit}`);
		let unit2 = await dag.sendAARequest(conf.arb_aa, {
			unlock: 1,
			id: id,
		});
		console.log(`requested unlock of ${id}: ${unit2}`);
	}
	console.log(`done committing force-closes`);
}

async function unlockForceCloses() {
	const unlock = await aa_state.lock();
	console.log(`unlocking force-closes`);
	const arbVars = aa_state.getUpcomingAAStateVars(conf.arb_aa);
	let ids = [];
	for (let var_name in arbVars) {
		if (!var_name.startsWith('amount_'))
			continue;
		let id = var_name.substr('amount_'.length, 44);
		ids.push(id);
	}
	console.log(`force-closes to unlock: `, ids);
	for (let id of ids) {
		let unit = await dag.sendAARequest(conf.arb_aa, {
			unlock: 1,
			id: id,
		});
		console.log(`requested unlock of ${id}: ${unit}`);
	}
	console.log(`done unlocking force-closes`);
	unlock();
}


function onArbAAResponse(objAAResponse) {
	if (objAAResponse.bounced && objAAResponse.trigger_address === operator.getAddress())
		console.log(`=== our request ${objAAResponse.trigger_unit} bounced with error`, objAAResponse.response.error);
}




async function startWatching() {
	const params = await dag.readAAParams(conf.arb_aa);
	const oswap_aa = params.oswap_aa;
	deposit_aa = params.deposit_aa;
	const curve_aa = await dag.executeGetter(conf.arb_aa, 'get_curve_aa');
	if (params.manager !== operator.getAddress())
		throw Error("I'm not the manager of this arb AA");
	stable_asset = await dag.readAAStateVar(deposit_aa, 'asset');
	interest_asset = await dag.readAAStateVar(curve_aa, 'asset2');

	oswapAA = await OswapAA.create(oswap_aa, interest_asset, stable_asset);
	depositAA = await DepositAA.create(deposit_aa);

	eventBus.on("aa_request_applied-" + oswap_aa, checkPricesAndArb);
	eventBus.on("aa_request_applied-" + deposit_aa, checkForChallengeableCloses);
//	eventBus.on("aa_request_applied-" + conf.arb_aa, checkForChallengeableCloses);

	eventBus.on("aa_response_applied-" + oswap_aa, checkPricesAndArb);
	eventBus.on("aa_response_applied-" + conf.arb_aa, onArbAAResponse);
	eventBus.on("aa_response_applied-" + deposit_aa, checkForChallengeableCloses);

	setInterval(commitForceCloses, 3600 * 1000);
	await commitForceCloses();

	setInterval(unlockForceCloses, 24 * 3600 * 1000);
	await unlockForceCloses();

	await checkPricesAndArb();
}


exports.startWatching = startWatching;

