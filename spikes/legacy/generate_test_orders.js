import { createOrder } from './paypal_client.js';

async function generateOrders() {
  console.log('Generating fresh Sandbox CAPTURE Order...');
  const captureOrderRes = await createOrder({ amount: '20.00', currency: 'USD', intent: 'CAPTURE' });
  const captureOrderData = captureOrderRes.data;
  const captureApproveLink = (captureOrderData.links || []).find(l => l.rel === 'approve');

  console.log('=== CAPTURE ORDER ===');
  console.log(`Order ID: ${captureOrderData.id}`);
  console.log(`Approval URL: ${captureApproveLink ? captureApproveLink.href : 'N/A'}`);

  console.log('\nGenerating fresh Sandbox AUTHORIZE Order...');
  const authOrderRes = await createOrder({ amount: '20.00', currency: 'USD', intent: 'AUTHORIZE' });
  const authOrderData = authOrderRes.data;
  const authApproveLink = (authOrderData.links || []).find(l => l.rel === 'approve');

  console.log('=== AUTHORIZE ORDER ===');
  console.log(`Order ID: ${authOrderData.id}`);
  console.log(`Approval URL: ${authApproveLink ? authApproveLink.href : 'N/A'}`);
}

generateOrders();
