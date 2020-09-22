const headlessWallet = require('headless-obyte');
const conf = require('ocore/conf.js');

let address;

function getAddress() {
	if (!address)
		throw Error("operator address not set");
	return address;
}

async function start() {
//	if (!conf.admin_email || !conf.from_email)
//		throw Error("Please set admin_email and from_email in your conf");
	return new Promise(resolve => {
		headlessWallet.readFirstAddress(async (addr) => {
			address = addr;
			resolve();
		});
	});
}

exports.getAddress = getAddress;
exports.start = start;
