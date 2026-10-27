#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createSpendingMandatePayload, signMandatePayload } from '../src/mandate.js';

/**
 * PayGuard Offline Admin Mandate Signing CLI
 * 
 * Cryptographic Trust Boundary:
 * - Runs strictly offline in the Human Owner / DevOps Admin environment.
 * - Signs mandate policies using the offline admin Ed25519 private key.
 * - Private keys are NEVER passed as command-line arguments and NEVER printed.
 * - The hosted PayGuard Gateway requires ONLY the corresponding public key.
 */

function printUsage() {
  console.log(`
Usage:
  node scripts/sign-mandate.js <unsigned-mandate.json> [output-signed-mandate.json] [options]

Options:
  --key-file <path>   Path to protected local Ed25519 admin private key PEM file
  --help, -h          Show this help message

Environment Variables:
  PAYGUARD_ADMIN_PRIVATE_KEY       Admin Ed25519 private key (PEM string)
  PAYGUARD_ADMIN_PRIVATE_KEY_PATH  Path to Admin Ed25519 private key PEM file

Examples:
  node scripts/sign-mandate.js mandate-unsigned.json mandate-signed.json
  node scripts/sign-mandate.js mandate-unsigned.json mandate-signed.json --key-file ./admin_priv.pem
`);
}

function resolveAdminPrivateKey(args) {
  // 1. Check --key-file flag
  const keyFileIdx = args.indexOf('--key-file');
  if (keyFileIdx !== -1 && args[keyFileIdx + 1]) {
    const keyPath = path.resolve(process.cwd(), args[keyFileIdx + 1]);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Admin private key file not found: ${keyPath}`);
    }
    return fs.readFileSync(keyPath, 'utf8').trim();
  }

  // 2. Check PAYGUARD_ADMIN_PRIVATE_KEY_PATH env var
  if (process.env.PAYGUARD_ADMIN_PRIVATE_KEY_PATH) {
    const keyPath = path.resolve(process.cwd(), process.env.PAYGUARD_ADMIN_PRIVATE_KEY_PATH.trim());
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Admin private key file not found at PAYGUARD_ADMIN_PRIVATE_KEY_PATH: ${keyPath}`);
    }
    return fs.readFileSync(keyPath, 'utf8').trim();
  }

  // 3. Check PAYGUARD_ADMIN_PRIVATE_KEY env var
  if (process.env.PAYGUARD_ADMIN_PRIVATE_KEY) {
    let pem = process.env.PAYGUARD_ADMIN_PRIVATE_KEY.trim();
    if (pem.includes('\\n')) {
      pem = pem.replace(/\\n/g, '\n');
    }
    return pem;
  }

  throw new Error(
    'Admin private key missing. Provide it via PAYGUARD_ADMIN_PRIVATE_KEY, ' +
    'PAYGUARD_ADMIN_PRIVATE_KEY_PATH, or --key-file <path>. ' +
    'Never pass private key material directly via CLI arguments.'
  );
}

function parseCliArgs(rawArgs) {
  const args = rawArgs.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key-file') {
      i++; // skip value
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const inputFile = filteredArgs[0] ? path.resolve(process.cwd(), filteredArgs[0]) : null;
  const outputFile = filteredArgs[1] ? path.resolve(process.cwd(), filteredArgs[1]) : null;

  return { inputFile, outputFile, rawArgs: args };
}

async function main() {
  const { inputFile, outputFile, rawArgs } = parseCliArgs(process.argv);

  if (!inputFile) {
    console.error('Error: Unsigned mandate JSON input file path is required.');
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file does not exist: ${inputFile}`);
    process.exit(1);
  }

  let unsignedJson;
  try {
    const rawContent = fs.readFileSync(inputFile, 'utf8');
    unsignedJson = JSON.parse(rawContent);
  } catch (err) {
    console.error(`Error: Failed to parse input JSON file: ${err.message}`);
    process.exit(1);
  }

  let adminPrivateKey;
  try {
    adminPrivateKey = resolveAdminPrivateKey(rawArgs);
    // Validate private key format without printing key contents
    crypto.createPrivateKey(adminPrivateKey);
  } catch (err) {
    console.error(`Error loading admin private key: ${err.message}`);
    process.exit(1);
  }

  // Normalize and sign mandate payload
  try {
    const payload = createSpendingMandatePayload({
      policy: unsignedJson.policy || unsignedJson,
      authorityName: unsignedJson.authorityName || 'Human Owner',
      expiresInDays: unsignedJson.expiresInDays || 30,
      mandateId: unsignedJson.mandateId || null,
      issuedAt: unsignedJson.issuedAt || null,
      expiresAt: unsignedJson.expiresAt || null,
    });

    const signedMandate = signMandatePayload(payload, adminPrivateKey);

    if (outputFile) {
      fs.writeFileSync(outputFile, JSON.stringify(signedMandate, null, 2), { encoding: 'utf8', mode: 0o600 });
      console.log(`[PayGuard Admin CLI] Signed mandate successfully written to: ${outputFile}`);
      console.log(`[PayGuard Admin CLI] Mandate ID: ${signedMandate.mandateId}`);
      console.log(`[PayGuard Admin CLI] Policy ID: ${signedMandate.policy.policyId}`);
      console.log(`[PayGuard Admin CLI] Signature: ${signedMandate.signature.substring(0, 16)}...`);
    } else {
      process.stdout.write(JSON.stringify(signedMandate, null, 2) + '\n');
    }
  } catch (err) {
    console.error(`Error signing mandate: ${err.message}`);
    process.exit(1);
  }
}

main();
