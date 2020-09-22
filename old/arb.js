"use strict";

const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');

const dag = require('aalib/dag.js');
const operator = require('aalib/operator.js');
const OswapAA = require('./oswap.js');
const DepositAA = require('./deposits.js');

let oswap_aa;
let deposit_aa;
let interest_asset;
let stable_asset;

let oswapAA;
let depositAA;


// above the peg

function getRequiredDepositAmount(target_price) {
	return Math.floor(oswapAA.getRequiredStableInAmount(target_price) / target_price);
}

// below the peg

function getDepostsToClose(total_stable_amount) {
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
	return selected_deposits;
}


async function openDeposit(amount) {
	let unit = await dag.sendAARequest({
		open_deposit: 1,
		amount: amount,
	});
	console.log(`openDeposit ${amount}: ${unit}`);
	if (unit)
		oswapAA.applySwapAndQueue(Math.floor(amount * depositAA.getTargetPrice()), stable_asset, unit);
}


async function closeDeposits(total_stable_amount) {
	let selected_deposits = getDepostsToClose(total_stable_amount);
	console.log(`need to close deposits for ${total_stable_amount} STABLE, selected deposits:`, JSON.stringify(selected_deposits, null, '\t'));
	for (let i = 0; i < selected_deposits.length; i++) {
		let unit = await depositAA.closeDeposit(selected_deposits[i].id);
		oswapAA.applySwapAndQueue(selected_deposits[i].interest_amount, interest_asset, unit);
	}
}

async function checkPricesAndArb() {
	const price = oswapAA.getPrice();
	const target_price = depositAA.getTargetPrice();
	console.log(`=== new oswap: price = ${price}, target_price = ${target_price}`);
	if (price < target_price) { // price of interest token is too low, price of stable token is too high
		console.log(`interest token is too cheap, stable token is too expensive, will open a deposit and sell stable token`);
		const deposit_amount = getRequiredDepositAmount(target_price);
		console.log(`deposit_amount = ${deposit_amount}`);
		if (deposit_amount <= 0)
			return console.log(`the difference is smaller than the fee`);
		
		// check that we are not losing money
		const stable_amount = Math.floor(deposit_amount * target_price);
		const out_amount = oswapAA.getOswapOutput(stable_amount, stable_asset, interest_asset);
		if (out_amount <= deposit_amount)
			throw Error(`would lose money ${out_amount} <= ${deposit_amount}`);
		
		await openDeposit(deposit_amount);
	}
	else if (price > target_price) { // price of interest token is too high, price of stable token is too low
		console.log(`interest token is too expensive, stable token is too cheap, will buy some stable token and close a few deposits`);
		const amount_to_close = oswapAA.getRequiredInterestInAmount(target_price);
		console.log(`amount_to_close = ${amount_to_close}`);
		if (amount_to_close <= 0) // the difference is too small
			return console.log(`the difference is smaller than the fee`);
		const stable_amount_to_close = oswapAA.getOswapOutput(amount_to_close, interest_asset, stable_asset);
		await closeDeposits(stable_amount_to_close);
	}
}


// look for trigger units sent to oswap AA
async function onOswapAARequest(objAARequest) {
	if (!oswapAA.onAARequest(objAARequest))
		return;
	await checkPricesAndArb();
}

function onArbAAResponse(objAAResponse) {
	if (objAAResponse.bounced && objAAResponse.trigger_address === operator.getAddress()) {
		console.log(`=== our request ${objAAResponse.trigger_unit} bounced with error`, objAAResponse.response.error);
		oswapAA.removeExecutedPendingSwaps(objAAResponse.trigger_initial_unit);
		oswapAA.replayPendingSwaps();
	}
}

function onAAResponse(objAAResponse) {
	console.log(`AA response:`, JSON.stringify(objAAResponse, null, '\t'));
	if (objAAResponse.aa_address === deposit_aa)
		return depositAA.onAAResponse(objAAResponse);
	if (objAAResponse.aa_address === oswap_aa)
		return oswapAA.onAAResponse(objAAResponse);
	if (objAAResponse.aa_address === conf.arb_aa)
		return onArbAAResponse(objAAResponse);
}

function onAARequest(objAARequest) {
	console.log(`AA request:`, JSON.stringify(objAARequest, null, '\t'));
	if (objAARequest.aa_address === deposit_aa)
		return depositAA.onAARequest(objAARequest);
	if (objAARequest.aa_address === oswap_aa)
		return onOswapAARequest(objAARequest);
}

function handleJustsaying(ws, subject, body) {
	console.log(`got justsaying`, subject, body);
	switch (subject) {
		case 'light/aa_response':
			onAAResponse(body);
			break;
		case 'light/aa_request':
			onAARequest(body);
			break;
	}
}

async function startWatching() {
	oswap_aa = await dag.executeGetter(conf.arb_aa, 'get_oswap_aa');
	deposit_aa = await dag.executeGetter(conf.arb_aa, 'get_deposit_aa');
	const curve_aa = await dag.executeGetter(conf.arb_aa, 'get_curve_aa');
	const manager = await dag.executeGetter(conf.arb_aa, 'get_manager');
	if (manager !== operator.getAddress())
		throw Error("I'm not the manager of this arb AA");
	stable_asset = await dag.readAAStateVar(deposit_aa, 'asset');
	interest_asset = await dag.readAAStateVar(curve_aa, 'asset2');

	oswapAA = await OswapAA.create(oswap_aa, interest_asset, stable_asset);
	depositAA = await DepositAA.create(deposit_aa);

	eventBus.on("message_for_light", handleJustsaying);

	await checkPricesAndArb();
}


exports.startWatching = startWatching;

