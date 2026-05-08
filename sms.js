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
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('SMS: BREVO_API_KEY not set, skipping.'); return; }

  const sender = (process.env.BREVO_SENDER || businessName || 'Booking').slice(0, 11);
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
    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, recipient, content: lines.join('\n') }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.message || r.status);
    console.log(`SMS sent to ${recipient} (${bookingNum}) — messageId: ${data.messageId}`);
  } catch (err) {
    console.error('SMS send error:', err?.message || err);
  }
}
