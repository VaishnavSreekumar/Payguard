import { createOrder, authorizeOrder } from './paypal_client.js';

async function runStep5() {
  console.log('=== STEP 5: TEST CREATE ORDER (intent: AUTHORIZE) ===');
  const createRes = await createOrder({ amount: '20.00', currency: 'USD', intent: 'AUTHORIZE' });

  console.log(`HTTP Status: ${createRes.status}`);
  if (!createRes.ok) {
    console.error('Create order (AUTHORIZE) failed:', JSON.stringify(createRes.data, null, 2));
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

  console.log('\n=== ATTEMPT AUTHORIZE BEFORE PAYER APPROVAL ===');
  console.log(`Attempting POST /v2/checkout/orders/${orderId}/authorize prior to buyer approval...`);
  const authRes = await authorizeOrder(orderId);

  console.log(`Pre-approval Authorize HTTP Status: ${authRes.status}`);
  console.log('Pre-approval Authorize Response:');
  console.log(JSON.stringify(authRes.data, null, 2));
}

runStep5();
