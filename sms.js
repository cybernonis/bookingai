function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) return '30' + digits.slice(1);
  if (digits.length === 10 && !digits.startsWith('0')) return '30' + digits;
  if (digits.startsWith('30') && digits.length === 12) return digits;
  return digits;
}

export async function sendSmsConfirmation({ to, businessName, bookingNum, pickup, destination, datetime, vehicle, price }) {
  const apiKey    = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) { console.warn('SMS: VONAGE_* env vars not set, skipping.'); return; }

  const from      = process.env.VONAGE_FROM || 'BooklyAi';
  const recipient = normalizePhone(to);
  if (!recipient) return;

  const lines = [
    `✅ ${bookingNum} confirmed!`,
    `📍 ${pickup} → ${destination}`,
    `📅 ${datetime}`,
    vehicle && `🚗 ${vehicle}`,
    price   && `💰 ${price}`,
    `— ${businessName}`,
  ].filter(Boolean);

  try {
    const r = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret, from, to: recipient, text: lines.join('\n') }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const msg = data.messages?.[0];
    if (msg?.status !== '0') throw new Error(msg?.['error-text'] || `status ${msg?.status}`);
    console.log(`SMS sent to ${recipient} (${bookingNum}) — messageId: ${msg['message-id']}`);
  } catch (err) {
    console.error('SMS send error:', err?.message || err);
  }
}
