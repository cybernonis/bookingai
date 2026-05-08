import twilio from 'twilio';

function getClient() {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) return '+30' + digits.slice(1);
  if (digits.length === 10 && !digits.startsWith('0')) return '+30' + digits;
  if (digits.startsWith('30') && digits.length === 12) return '+' + digits;
  return '+' + digits;
}

export async function sendSmsConfirmation({ to, businessName, bookingNum, pickup, destination, datetime, vehicle, price }) {
  const client = getClient();
  if (!client) { console.warn('SMS: TWILIO_* env vars not set, skipping.'); return; }

  const normalized = normalizePhone(to);
  if (!normalized) return;

  const from = process.env.TWILIO_FROM;
  if (!from) { console.warn('SMS: TWILIO_FROM not set, skipping.'); return; }

  const lines = [
    `✅ ${bookingNum} confirmed!`,
    `📍 ${pickup} → ${destination}`,
    `📅 ${datetime}`,
    vehicle && `🚗 ${vehicle}`,
    price   && `💰 ${price}`,
    `— ${businessName}`,
  ].filter(Boolean);

  try {
    const msg = await client.messages.create({ from, to: normalized, body: lines.join('\n') });
    console.log(`SMS sent to ${normalized} (${bookingNum}) — ${msg.sid}`);
  } catch (err) {
    console.error('SMS send error:', err?.message || err);
  }
}
