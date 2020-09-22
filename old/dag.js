"use strict";

const constants = require('ocore/constants.js');
const objectHash = require('ocore/object_hash.js');
const db = require('ocore/db.js');
const storage = require('ocore/storage.js');
const network = require('ocore/network.js');
var formulaEvaluation = require('ocore/formula/evaluation.js');
const conf = require('ocore/conf.js');
const operator = require('./operator.js');
const headlessWallet = require('headless-obyte');



function readAAStateVar(aa_address, var_name, cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVar(aa_address, var_name, resolve));
	console.error('----- readAAStateVar', aa_address, var_name);
	readAAStateVars(aa_address, var_name, assocVars => {
		cb(assocVars[var_name]);
	});
}

function readAAStateVars(aa_address, var_prefix, cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVars(aa_address, var_prefix, resolve));
	conf.bLight ? readAAStateVarsLight(aa_address, var_prefix, cb) : readAAStateVarsFull(aa_address, var_prefix, cb);
}

function readAAStateVarsFull(aa_address, var_prefix, cb) {
	storage.readAAStateVars(aa_address, var_prefix, var_prefix, 0, cb);
}

function readAAStateVarsLight(aa_address, var_prefix, cb) {
	requestFromLightVendorWithRetries('light/get_aa_state_vars', { address: aa_address, var_prefix: var_prefix }, function (response) {
		let assocVars = response;
		cb(assocVars);
	});
}

function executeGetter(aa_address, getter, args, cb) {
	if (!cb)
		return new Promise((resolve, reject) => executeGetter(aa_address, getter, args, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	let params = { address: aa_address, getter };
	if (args)
		params.args = args;
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/execute_getter', params, response => cb(response.error, response.result));
	else
		formulaEvaluation.executeGetter(db, aa_address, getter, args || [], cb);
}

function readAABalances(aa_address, cb) {
	if (!cb)
		return new Promise((resolve, reject) => readAABalances(aa_address, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_aa_balances', { address: aa_address }, response => cb(response.error, response.balances));
	else
		db.query("SELECT asset, balance FROM aa_balances WHERE address=?", [aa_address], function (rows) {
			var assocBalances = {};
			rows.forEach(function (row) {
				assocBalances[row.asset] = row.balance;
			});
			cb(null, assocBalances);
		});
}

function readAADefinition(aa_address, cb) {
	if (!cb)
		return new Promise((resolve, reject) => readAADefinition(aa_address, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_definition', aa_address, response => cb(response.error, response));
	else
		storage.readAADefinition(db, aa_address, arrDefinition => {
			cb(null, arrDefinition);
		});
}

function requestFromLightVendorWithRetries(command, params, cb, count_retries) {
	count_retries = count_retries || 0;
	network.requestFromLightVendor(command, params, (ws, request, response) => {
		if (response.error && Object.keys(response).length === 1 && response.error.startsWith('[internal]')) {
			console.log(`got ${response.error} from ${command} ${params}`);
			if (count_retries > 3)
				throw Error("got error after 3 retries: " + response.error);
			return setTimeout(() => requestFromLightVendorWithRetries(command, params, cb, count_retries + 1), 5000);
		}
		cb(response);
	});
}

function readJoint(unit, cb, bRetrying) {
	if (!cb)
		return new Promise(resolve => readJoint(unit, resolve));
	storage.readJoint(db, unit, {
		ifFound: cb,
		ifNotFound() {
			if (!conf.bLight || bRetrying)
				throw Error("unit not found: " + unit);
			network.requestHistoryFor([unit], [], () => {
				readJoint(unit, cb, true);
			});
		}
	});
}

async function sendAARequest(data) {
	let json = JSON.stringify(data);
	let message = {
		app: 'data',
		payload_location: 'inline',
		payload: data
	};
	message.payload_hash = objectHash.getBase64Hash(message.payload, true);
	let opts = {
		messages: [message],
		amount: constants.MIN_BYTES_BOUNCE_FEE,
		to_address: conf.arb_aa,
		paying_addresses: [operator.getAddress()],
		change_address: operator.getAddress(),
		spend_unconfirmed: 'all',
	};
	try {
		let { unit } = await headlessWallet.sendMultiPayment(opts);
		console.log("sent " + json + " request, unit " + unit);
		return unit;
	}
	catch (e) {
		console.error("failed to send " + json + " request: " + e);
		return null;
	}
}


exports.readJoint = readJoint;
exports.readAADefinition = readAADefinition;
exports.readAAStateVar = readAAStateVar;
exports.readAAStateVars = readAAStateVars;
exports.readAABalances = readAABalances;
exports.executeGetter = executeGetter;
exports.sendAARequest = sendAARequest;
