import { createOrder, captureOrder, authorizeOrder, captureAuthorization } from './paypal_client.js';

const command = process.argv[2];
const targetId = process.argv[3];

if (!command || !targetId) {
  console.log('Usage: node test_step4_capture.js <capture|authorize|capture-auth> <ID>');
  process.exit(1);
}

async function run() {
  if (command === 'capture') {
    console.log(`Attempting capture on approved Order: ${targetId}`);
    const res = await captureOrder(targetId);
    console.log(`HTTP Status: ${res.status}`);
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } else if (command === 'authorize') {
    console.log(`Attempting authorize on approved Order: ${targetId}`);
    const res = await authorizeOrder(targetId);
    console.log(`HTTP Status: ${res.status}`);
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } else if (command === 'capture-auth') {
    console.log(`Attempting capture on Authorization: ${targetId}`);
    const res = await captureAuthorization(targetId, { amount: '20.00', currency: 'USD' });
    console.log(`HTTP Status: ${res.status}`);
    console.log('Response:', JSON.stringify(res.data, null, 2));
  }
}

run();
