function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) return '30' + digits.slice(1);
  if (digits.length === 10 && !digits.startsWith('0')) return '30' + digits;
  if (digits.startsWith('30') && digits.length === 12) return digits;
  return digits;
}

// ── Internal senders ──────────────────────────────────────────────────────────

async function vonageSend(to, from, text, apiKey, apiSecret) {
  if (!apiKey || !apiSecret) throw new Error('Vonage credentials missing');
  const r = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret, from, to, text }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json();
  const msg = data.messages?.[0];
  if (msg?.status !== '0') throw new Error(msg?.['error-text'] || `Vonage status ${msg?.status}`);
  return msg['message-id'];
}

async function brevoSend(to, sender, text, apiKey) {
  if (!apiKey) throw new Error('Brevo API key missing');
  const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, recipient: to, content: text }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `Brevo status ${r.status}`);
  return data.messageId;
}

async function twilioSend(to, from, text, sid, token) {
  if (!sid || !token) throw new Error('Twilio credentials missing');
  const body = new URLSearchParams({ To: `+${to}`, From: from, Body: text });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `Twilio status ${r.status}`);
  return data.sid;
}

// ── Dispatch: providerConfig or env-var fallback ───────────────────────────────

export async function sendSmsDirect({ to, text, providerConfig }) {
  const recipient = normalizePhone(to);
  if (!recipient) return null;
  const p = providerConfig;
  if (p?.provider === 'brevo')  return brevoSend(recipient, p.creds?.sender || 'BooklyAi', text, p.creds?.api_key);
  if (p?.provider === 'twilio') return twilioSend(recipient, p.creds?.from, text, p.creds?.sid, p.creds?.token);
  if (p?.provider === 'vonage') return vonageSend(recipient, p.creds?.from || 'BooklyAi', text, p.creds?.api_key, p.creds?.api_secret);
  const envKey = process.env.VONAGE_API_KEY;
  if (envKey) return vonageSend(recipient, process.env.VONAGE_FROM || 'BooklyAi', text, envKey, process.env.VONAGE_API_SECRET);
  console.warn('SMS: no provider configured, skipping.');
  return null;
}

export async function sendSmsConfirmation({ to, businessName, bookingNum, pickup, destination, datetime, vehicle, price, providerConfig }) {
  if (!normalizePhone(to)) return;

  const lines = [
    `Booking ${bookingNum} confirmed!`,
    `${pickup} -> ${destination}`,
    `${datetime}`,
    vehicle && `${vehicle}`,
    price   && `${price}`,
    `- ${businessName}`,
  ].filter(Boolean);

  try {
    const id = await sendSmsDirect({ to, text: lines.join('\n'), providerConfig });
    console.log(`SMS sent to ${normalizePhone(to)} (${bookingNum}) id: ${id}`);
  } catch (err) {
    console.error('SMS send error:', err?.message || err);
  }
}

export async function sendAdminSms({ to, businessName, bookingNum, name, phone, pickup, destination, datetime, vehicle, price, providerConfig }) {
  if (!normalizePhone(to)) return;

  const lines = [
    `New booking ${bookingNum}`,
    `${name}${phone ? ` | ${phone}` : ''}`,
    `${pickup} -> ${destination}`,
    `${datetime}`,
    vehicle && `${vehicle}`,
    price   && `${price}`,
  ].filter(Boolean);

  try {
    const id = await sendSmsDirect({ to, text: lines.join('\n'), providerConfig });
    console.log(`Admin SMS sent to ${normalizePhone(to)} (${bookingNum}) id: ${id}`);
  } catch (err) {
    console.error('Admin SMS error:', err?.message || err);
  }
}
