import { createOrder, captureOrder } from './paypal_client.js';

async function runStep2And3() {
  console.log('=== STEP 2: TEST CREATE ORDER (intent: CAPTURE) ===');
  const createRes = await createOrder({ amount: '20.00', currency: 'USD', intent: 'CAPTURE' });

  console.log(`HTTP Status: ${createRes.status}`);
  if (!createRes.ok) {
    console.error('Create order failed:', JSON.stringify(createRes.data, null, 2));
    return;
  }

  const order = createRes.data;
  const orderId = order.id;
  const orderStatus = order.status;
  const links = order.links || [];

  console.log(`Order ID: ${orderId}`);
  console.log(`Order Status: ${orderStatus}`);
  console.log('HATEOAS Links:');
  links.forEach(link => {
    console.log(`  - [${link.rel}] (${link.method}): ${link.href}`);
  });

  const approveLink = links.find(link => link.rel === 'approve' || link.rel === 'payer-action');
  console.log(`Approval URL exists: ${Boolean(approveLink)}`);
  if (approveLink) {
    console.log(`Approval URL: ${approveLink.href}`);
  }

  console.log('\n=== STEP 3: ATTEMPT CAPTURE BEFORE PAYER APPROVAL ===');
  console.log(`Attempting POST /v2/checkout/orders/${orderId}/capture prior to buyer approval...`);
  const captureRes = await captureOrder(orderId);

  console.log(`Pre-approval Capture HTTP Status: ${captureRes.status}`);
  console.log('Pre-approval Capture Response:');
  console.log(JSON.stringify(captureRes.data, null, 2));
}

runStep2And3();
