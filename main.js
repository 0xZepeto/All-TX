#!/usr/bin/env node
/**
 * main.js
 * Auto-send BEP20 / native tokens across networks listed in rpc.json
 * Node 22.x, ethers 6.15, works with require() style (CommonJS)
 *
 * Quick install (recommended exact versions):
 *   npm init -y
 *   npm i ethers@6.15 inquirer@8 dotenv fs-extra cli-progress p-limit ora chalk@4
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

dotenv.config();

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

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

async function chooseNetwork(rpcs) {
  const choices = rpcs.map((r, idx) => ({ name: `${r.name}`, value: idx }));
  const { idx } = await inquirer.prompt([{ type: 'list', name: 'idx', message: 'Pilih jaringan', choices }]);
  return rpcs[idx];
}

async function main() {
  console.log(chalk.cyan('\nAuto-send BEP20 / Native - Node (ethers v6.15)\n'));

  const rpcPath = path.resolve(process.cwd(), 'rpc.json');
  if (!fs.existsSync(rpcPath)) {
    console.error(chalk.red('Tidak menemukan rpc.json di direktori kerja. Buat file rpc.json yang berisi array object: [{"name":"BNB","endpoint":"https://...","chainId":56}]'));
    process.exit(1);
  }
  const rpcs = JSON.parse(fs.readFileSync(rpcPath, 'utf8'));
  const network = await chooseNetwork(rpcs);
  const provider = new ethers.JsonRpcProvider(network.endpoint);

  const { mainChoice } = await inquirer.prompt([{
    type: 'list', name: 'mainChoice', message: 'Pilih opsi',
    choices: [{ name: 'KIRIM TOKEN (BEP20/ERC20)', value: 'token' }, { name: 'KIRIM NATIVE (BNB/ETH/etc.)', value: 'native' }]
  }]);

  let isToken = mainChoice === 'token';
  let tokenContract = null;
  let tokenDecimals = 18, tokenSymbol = '';

  if (isToken) {
    const { tokenAddr } = await inquirer.prompt([{ type: 'input', name: 'tokenAddr', message: 'Masukkan contract token (0x...)' }]);
    tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    try { tokenDecimals = await tokenContract.decimals(); tokenSymbol = await tokenContract.symbol(); } catch (e) {
      console.log(chalk.yellow('Gagal baca decimals/symbol, default 18.'));
    }
  }

  const { subMode } = await inquirer.prompt([{ type: 'list', name: 'subMode', message: 'Mode pengiriman', choices: [{ name: '1 wallet -> banyak address', value: 'oneToMany' }, { name: 'banyak wallet -> 1 address', value: 'manyToOne' }] }]);

  const pkLines = readLinesTrim(path.resolve(process.cwd(), 'pk.txt'));
  let senders = [];

  if (subMode === 'oneToMany') {
    const { pkSource } = await inquirer.prompt([{ type: 'list', name: 'pkSource', message: 'Sumber private key untuk sender', choices: [{ name: '.env PRIVATE_KEY (single)', value: 'env' }, { name: 'pk.txt (perbaris)', value: 'file' }] }]);
    if (pkSource === 'env') {
      if (!process.env.PRIVATE_KEY) { console.error(chalk.red('PRIVATE_KEY tidak ditemukan di .env')); process.exit(1); }
      senders = [process.env.PRIVATE_KEY.trim()];
    } else {
      if (pkLines.length === 0) { console.error(chalk.red('pk.txt kosong')); process.exit(1); }
      if (pkLines.length > 1) {
        const { pickIndex } = await inquirer.prompt([{ type: 'list', name: 'pickIndex', message: 'Pilih index private key sebagai sender', choices: pkLines.map((k, idx) => ({ name: `#${idx+1}`, value: idx })) }]);
        senders = [pkLines[pickIndex]];
      } else senders = [pkLines[0]];
    }
  } else {
    if (pkLines.length === 0) { console.error(chalk.red('pk.txt kosong')); process.exit(1); }
    senders = pkLines.slice();
  }

  let recipients = [];
  let singleRecipient = null;
  if (subMode === 'oneToMany') {
    const addrFile = path.resolve(process.cwd(), 'address.txt');
    if (!fs.existsSync(addrFile)) { console.error(chalk.red('address.txt tidak ditemukan')); process.exit(1); }
    recipients = readLinesTrim(addrFile);
    if (recipients.length === 0) { console.error(chalk.red('address.txt kosong')); process.exit(1); }
  } else {
    const { recipientFromFile } = await inquirer.prompt([{ type: 'confirm', name: 'recipientFromFile', message: 'Ambil alamat tujuan dari address.txt (1 alamat)?', default: false }]);
    if (recipientFromFile) {
      const addrs = readLinesTrim(path.resolve(process.cwd(), 'address.txt'));
      if (addrs.length === 0) { console.error(chalk.red('address.txt kosong')); process.exit(1); }
      singleRecipient = addrs[0];
    } else {
      const { recipient } = await inquirer.prompt([{ type: 'input', name: 'recipient', message: 'Masukkan alamat tujuan (0x...)' }]);
      singleRecipient = recipient.trim();
    }
  }

  let amountInput = null;
  let amountMode = 'fixed';
  if (isToken) {
    if (subMode === 'oneToMany') {
      const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: `Jumlah token per penerima (contoh 1.5) [decimals ${tokenDecimals}]` }]);
      amountInput = amt;
    } else {
      const { manyMode } = await inquirer.prompt([{ type: 'list', name: 'manyMode', message: 'Untuk tiap wallet pengirim', choices: [{ name: 'Jumlah tetap per wallet', value: 'fixed' }, { name: 'Kirim semua token (balance)', value: 'balance' }] }]);
      amountMode = manyMode;
      if (manyMode === 'fixed') { const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: 'Jumlah token per wallet' }]); amountInput = amt; }
    }
  } else {
    if (subMode === 'oneToMany') {
      const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: 'Jumlah native per penerima (contoh 0.01)' }]);
      amountInput = amt;
    } else {
      const { manyMode } = await inquirer.prompt([{ type: 'list', name: 'manyMode', message: 'Untuk tiap wallet pengirim', choices: [{ name: 'Jumlah tetap per wallet', value: 'fixed' }, { name: 'Kirim semua native (balance - gas)', value: 'all' }] }]);
      amountMode = manyMode;
      if (manyMode === 'fixed') { const { amt } = await inquirer.prompt([{ type: 'input', name: 'amt', message: 'Jumlah native per wallet' }]); amountInput = amt; }
    }
  }

  const { conc } = await inquirer.prompt([{ type: 'number', name: 'conc', message: 'Concurrency (parallel wallets)', default: 4 }]);
  const concurrency = Math.max(1, Math.min(50, conc || 4));
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

  console.log(chalk.yellow('\n--- PREVIEW TRANSACTIONS ---'));
  previewList.forEach((p, i) => console.log(`${i+1}. from: ${p.from} -> to: ${p.to} | ${p.value} ${p.token}`));
  const { confirmSend } = await inquirer.prompt([{ type: 'confirm', name: 'confirmSend', message: 'Lanjut kirim semua transaksi?', default: false }]);
  if (!confirmSend) { console.log('Dibatalkan.'); process.exit(0); }

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
      results.push({ ok: false, from: p.from, to: p.to, error: e.message });
      console.error(chalk.red(`\nTx FAILED from ${p.from} -> ${p.to}: ${e.message}`));
    }
  }));

  await Promise.all(tasks);
  multibar.stop();

  const out = results.map(r => `${r.ok ? 'OK' : 'FAIL'},${r.from},${r.to},${r.hash || ''},"${r.error || ''}"`).join('\n');
  const outPath = path.resolve(process.cwd(), `send_results_${Date.now()}.csv`);
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(chalk.cyan(`\nSelesai. Hasil disimpan di: ${outPath}`));
}

main().catch(e => { console.error(chalk.red('Error: ' + (e && e.message) || e)); process.exit(1); });
