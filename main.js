#!/usr/bin/env node
/**
 * main.js (UI-updated)
 * Clean CLI UI for Auto-send BEP20 / Native tokens
 * Node 22.x, ethers 6.15, CommonJS (require)
 *
 * Dependencies:
 *  ethers@6.15, inquirer@8, dotenv, fs-extra, cli-progress, p-limit, ora, chalk@4, boxen@7, figlet@1.6
 *
 * WARNING: This script WILL send real funds if you confirm. Test with small amounts first.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const inquirerModule = require('inquirer');
const inquirer = inquirerModule && inquirerModule.default ? inquirerModule.default : inquirerModule;
const dotenv = require('dotenv');
const { ethers } = require('ethers');
const PLimit = require('p-limit');
const cliProgress = require('cli-progress');
const chalk = require('chalk');
const boxen = require('boxen');
const figlet = require('figlet');

dotenv.config();

// --- Config ---
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

// helper
function readLinesTrim(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const data = fs.readFileSync(filePath, 'utf8');
  return data.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function handleRetrySend(signer, txRequest, provider, retries = 4) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    try {
      const populated = await signer.populateTransaction(txRequest);
      const response = await signer.sendTransaction(populated);
      return response;
    } catch (e) {
      lastError = e;
      const msg = (e && e.message) ? e.message.toLowerCase() : '';
      if (msg.includes('nonce too low') || msg.includes('replacement transaction') || msg.includes('underpriced') || msg.includes('already known')) {
        attempt++;
        try {
          const feeData = await provider.getFeeData();
          if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            const bumpFactor = BigInt(1 + attempt);
            txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * bumpFactor;
            txRequest.maxFeePerGas = feeData.maxFeePerGas * bumpFactor;
          } else if (feeData.gasPrice) {
            txRequest.gasPrice = feeData.gasPrice * BigInt(1 + attempt);
          }
        } catch (_) {}
        try { txRequest.nonce = await provider.getTransactionCount(await signer.getAddress(), 'latest'); } catch (_) {}
        await sleep(1000 * attempt);
        continue;
      }
      if (msg.includes('timeout') || msg.includes('network') || msg.includes('rate limit') || msg.includes('failed')) {
        attempt++;
        await sleep(1000 * attempt);
        continue;
      }
      break;
    }
  }
  throw new Error('Gagal kirim tx: ' + (lastError ? lastError.message : 'unknown'));
}

// Nice CLI header
function printHeader(networks) {
  let title;
  try {
    title = figlet.textSync('AUTO SEND', { font: 'Standard' });
  } catch (e) {
    title = 'AUTO SEND';
  }

  const lines = [
    chalk.bold.cyan(title),
    chalk.green('Multi-chain BEP20 / Native Sender'),
    chalk.gray('Version: 1.0.0  •  ethers v6.15  •  inquirer v8'),
    '',
    chalk.white('Usage: follow prompts. ALWAYS test on small amounts first.')
  ].join('\n');

  console.clear();
  console.log(boxen(lines, { padding: 1, margin: 1, borderColor: 'cyan', borderStyle: 'round' }));

  // show short list of networks (friendly names)
  if (Array.isArray(networks) && networks.length) {
    console.log(chalk.yellow('Available networks:'));
    networks.forEach((r, i) => {
      console.log('  ' + chalk.bold(`${i + 1}.`) + ' ' + chalk.white(r.name));
    });
    console.log('');
  }
}

// Present only friendly names for selection
async function chooseNetwork(rpcs) {
  const choices = rpcs.map((r, idx) => ({ name: `${r.name}`, value: idx }));
  const { idx } = await inquirer.prompt([{ type: 'list', name: 'idx', message: chalk.blueBright('Pilih jaringan'), choices }]);
  return rpcs[idx];
}

// Main flow
async function main() {
  // load rpc.json
  const rpcPath = path.resolve(process.cwd(), 'rpc.json');
  if (!fs.existsSync(rpcPath)) {
    console.error(chalk.red('rpc.json tidak ditemukan. Buat file rpc.json berisi array object { name, endpoint, chainId }'));
    process.exit(1);
  }
  const rpcs = JSON.parse(fs.readFileSync(rpcPath, 'utf8'));

  // header
  printHeader(rpcs);

  const network = await chooseNetwork(rpcs);
  const provider = new ethers.JsonRpcProvider(network.endpoint);

  // choice token/native
  const { mainChoice } = await inquirer.prompt([{
    type: 'list', name: 'mainChoice', message: chalk.blue('Pilih opsi'),
    choices: [{ name: 'KIRIM TOKEN (BEP20/ERC20)', value: 'token' }, { name: 'KIRIM NATIVE (BNB/ETH/etc.)', value: 'native' }]
  }]);

  const isToken = mainChoice === 'token';
  let tokenContract = null;
  let tokenDecimals = 18, tokenSymbol = '';

  if (isToken) {
    const { tokenAddr } = await inquirer.prompt([{ type: 'input', name: 'tokenAddr', message: chalk.blue('Masukkan contract token (0x...)') }]);
    tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    try { tokenDecimals = await tokenContract.decimals(); tokenSymbol = await tokenContract.symbol(); } catch (e) {
      console.log(chalk.yellow('Gagal baca decimals/symbol, default 18 (pastikan contract BEP20 kompatibel).'));
    }
  }

  const { subMode } = await inquirer.prompt([{ type: 'list', name: 'subMode', message: chalk.blue('Mode pengiriman'), choices: [{ name: '1 wallet -> banyak address', value: 'oneToMany' }, { name: 'banyak wallet -> 1 address', value: 'manyToOne' }] }]);

  const pkLines = readLinesTrim(path.resolve(process.cwd(), 'pk.txt'));
  let senders = [];

  if (subMode === 'oneToMany') {
    const { pkSource } = await inquirer.prompt([{ type: 'list', name: 'pkSource', message: chalk.blue('Sumber private key untuk sender'), choices: [{ name: '.env PRIVATE_KEY (single)', value: 'env' }, { name: 'pk.txt (perbaris)', value: 'file' }] }]);
    if (pkSource === 'env') {
      if (!process.env.PRIVATE_KEY) { console.error(chalk.red('PRIVATE_KEY tidak ditemukan di .env')); process.exit(1); }
      senders = [process.env.PRIVATE_KEY.trim()];
    } else {
      if (pkLines.length === 0) { console.error(chalk.red('pk.txt kosong (masukkan private key per baris)')); process.exit(1); }
      if (pkLines.length > 1) {
        const { pickIndex } = await inquirer.prompt([{ type: 'list', name: 'pickIndex', message: chalk.blue('Pilih sender (index)'), choices: pkLines.map((k, idx) => ({ name: `#${idx+1}`, value: idx })) }]);
        senders = [pkLines[pickIndex]];
      } else senders = [pkLines[0]];
    }
  } else {
    if (pkLines.length === 0) { console.error(chalk.red('pk.txt kosong (masukkan private key per baris)')); process.exit(1); }
    senders = pkLines.slice();
  }

  let recipients = [];
  let singleRecipient = null;
  if (subMode === 'oneToMany') {
    const addressFile = path.resolve(process.cwd(), 'address.txt');
    if (!fs.existsSync(addressFile)) { console.error(chalk.red('address.txt tidak ditemukan (buat address.txt dengan alamat tujuan per baris)')); process.exit(1); }
    recipients = readLinesTrim(addressFile);
    if (recipients.length === 0) { console.error(chalk.red('address.txt kosong')); process.exit(1); }
  } else {
    const { recipientFromFile } = await inquirer.prompt([{ type: 'confirm', name: 'recipientFromFile', message: chalk.blue('Ambil alamat tujuan dari address.txt (1 alamat)?'), default: false }]);
    if (recipientFromFile) {
      const addrs = readLinesTrim(path.resolve(process.cwd(), 'address.txt'));
      if (addrs.length === 0) { console.error(chalk.red('address.txt kosong')); process.exit(1); }
      singleRecipient = addrs[0];
    } else {
      const { recipient } = await inquirer.prompt([{ type: 'input', name: 'recipient', message: chalk.blue('Masukkan alamat tujuan (0x...)') }]);
      singleRecipient = recipient.trim();
    }
  }

  // Amount selection
  let amountMode = 'fixed';
  let amountInput = null;
  if (isToken) {
    if (subMode === 'oneToMany') {
      const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: chalk.blue(`Jumlah token per penerima (contoh 1.5) [decimals ${tokenDecimals}]`) }]);
      amountInput = amt;
    } else {
      const { manyMode } = await inquirer.prompt([{ type: 'list', name: 'manyMode', message: chalk.blue('Untuk tiap wallet pengirim'), choices: [{ name: 'Jumlah tetap per wallet', value: 'fixed' }, { name: 'Kirim semua token (balance)', value: 'balance' }] }]);
      amountMode = manyMode;
      if (manyMode === 'fixed') { const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: chalk.blue('Jumlah token per wallet') }]); amountInput = amt; }
    }
  } else {
    if (subMode === 'oneToMany') {
      const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: chalk.blue('Jumlah native per penerima (contoh 0.01)') }]);
      amountInput = amt;
    } else {
      const { manyMode } = await inquirer.prompt([{ type: 'list', name: 'manyMode', message: chalk.blue('Untuk tiap wallet pengirim'), choices: [{ name: 'Jumlah tetap per wallet', value: 'fixed' }, { name: 'Kirim semua native (balance - gas)', value: 'all' }] }]);
      amountMode = manyMode;
      if (manyMode === 'fixed') { const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: chalk.blue('Jumlah native per wallet') }]); amountInput = amt; }
    }
  }

  const { conc } = await inquirer.prompt([{ type: 'number', name: 'conc', message: chalk.blue('Concurrency (parallel wallets)'), default: 4 }]);
  const concurrency = Math.max(1, Math.min(50, conc || 4));

  // Build preview list
  const previewList = [];
  if (subMode === 'oneToMany') {
    const pk = senders[0];
    const wallet = new ethers.Wallet(pk, provider);
    for (const to of recipients) {
      let amtBn;
      if (isToken) amtBn = ethers.parseUnits(String(amountInput), tokenDecimals);
      else amtBn = ethers.parseEther(String(amountInput));
      previewList.push({ from: await wallet.getAddress(), pk, to, value: amtBn.toString(), token: isToken ? (tokenSymbol || 'TOKEN') : 'NATIVE' });
    }
  } else {
    for (const pk of senders) {
      const wallet = new ethers.Wallet(pk, provider);
      const from = await wallet.getAddress();
      let amtVal;
      if (isToken) {
        if (amountMode === 'balance') {
          const bal = await tokenContract.balanceOf(from);
          amtVal = bal.toString();
        } else amtVal = ethers.parseUnits(String(amountInput), tokenDecimals).toString();
      } else {
        if (amountMode === 'all') amtVal = 'send_all_native';
        else amtVal = ethers.parseEther(String(amountInput)).toString();
      }
      previewList.push({ from, pk, to: singleRecipient, value: amtVal, token: isToken ? (tokenSymbol || 'TOKEN') : 'NATIVE' });
    }
  }

  // Pretty preview
  console.log(chalk.magenta('\n--- PREVIEW TRANSACTIONS ---\n'));
  previewList.forEach((p, i) => {
    console.log(chalk.gray(`${i + 1}.`) + ' ' + chalk.yellow(p.from) + ' -> ' + chalk.green(p.to) + ' | ' + chalk.white(p.value) + ' ' + chalk.cyan(p.token));
  });
  console.log('');
  const { confirmSend } = await inquirer.prompt([{ type: 'confirm', name: 'confirmSend', message: chalk.red('Lanjut kirim semua transaksi? (PASTIKAN ini mainnet!)'), default: false }]);
  if (!confirmSend) { console.log(chalk.yellow('Dibatalkan.')); process.exit(0); }

  // Execution
  const limit = PLimit(concurrency);
  const multibar = new cliProgress.MultiBar({ clearOnComplete: false, hideCursor: true, format: '{wallet} |{bar}| {value}/{total} Tx' }, cliProgress.Presets.shades_classic);
  const bars = {};
  const results = [];

  async function sendTokenFromPK(pk, to, amountBn) {
    const wallet = new ethers.Wallet(pk, provider);
    const signer = wallet.connect(provider);
    const contractWithSigner = new ethers.Contract(tokenContract.target || tokenContract.address, ERC20_ABI, signer);
    const txReq = await contractWithSigner.populateTransaction.transfer(to, amountBn);
    const est = await provider.estimateGas(txReq).catch(() => null);
    if (est) txReq.gasLimit = est + BigInt(10000);
    txReq.chainId = network.chainId;
    return await handleRetrySend(signer, txReq, provider, 4);
  }

  async function sendNativeFromPK(pk, to, amountBn) {
    const wallet = new ethers.Wallet(pk, provider);
    const signer = wallet.connect(provider);
    const txReq = { to, value: amountBn };
    const est = await provider.estimateGas(txReq).catch(() => null);
    if (est) txReq.gasLimit = est + BigInt(10000);
    txReq.chainId = network.chainId;
    return await handleRetrySend(signer, txReq, provider, 4);
  }

  const tasks = previewList.map((p) => limit(async () => {
    const walletShort = (p.from || '').slice(0, 10);
    if (!bars[p.from]) bars[p.from] = multibar.create(1, 0, { wallet: walletShort });
    const bar = bars[p.from];
    try {
      let txResp;
      if (p.value === 'send_all_native') {
        const wallet = new ethers.Wallet(p.pk, provider);
        const bal = await provider.getBalance(await wallet.getAddress());
        const gasEst = await provider.estimateGas({ to: p.to, value: 0 }).catch(() => BigInt(21000));
        const feeData = await provider.getFeeData();
        const maxFee = feeData.maxFeePerGas || feeData.gasPrice || BigInt(0);
        const gasCost = gasEst * maxFee;
        const sendAmt = bal > gasCost ? (bal - gasCost) : BigInt(0);
        if (sendAmt === BigInt(0)) throw new Error('Saldo tidak cukup untuk gas');
        txResp = await sendNativeFromPK(p.pk, p.to, sendAmt);
      } else {
        if (p.token === 'NATIVE') txResp = await sendNativeFromPK(p.pk, p.to, ethers.BigInt(p.value));
        else txResp = await sendTokenFromPK(p.pk, p.to, ethers.BigInt(p.value));
      }
      bar.increment();
      results.push({ ok: true, from: p.from, to: p.to, hash: txResp.hash });
      console.log(chalk.green(`\nTx OK: ${txResp.hash} | from ${p.from} -> ${p.to}`));
    } catch (e) {
      bar.increment();
      results.push({ ok: false, from: p.from, to: p.to, error: e && e.message ? e.message : String(e) });
      console.error(chalk.red(`\nTx FAILED from ${p.from} -> ${p.to}: ${e && e.message ? e.message : String(e)}`));
    }
  }));

  await Promise.all(tasks);
  multibar.stop();

  const out = results.map(r => `${r.ok ? 'OK' : 'FAIL'},${r.from},${r.to},${r.hash || ''},"${r.error || ''}"`).join('\n');
  const outPath = path.resolve(process.cwd(), `send_results_${Date.now()}.csv`);
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(chalk.cyan(`\nSelesai. Hasil disimpan di: ${outPath}`));
}

// run
main().catch(e => { console.error(chalk.red('Fatal error: ' + (e && e.message ? e.message : String(e)))); process.exit(1); });
