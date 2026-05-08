async function resendSend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('Email: RESEND_API_KEY not set, skipping.'); return null; }
  const from = process.env.RESEND_FROM || 'BooklyAI <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `status ${r.status}`);
  return data.id;
}

function buildTable(rows) {
  return rows
    .filter(r => r && r.value)
    .map(r => `
      <tr>
        <td style="padding:11px 12px;font-size:18px;width:32px;vertical-align:middle;">${r.icon}</td>
        <td style="padding:11px 6px;font-size:11px;color:#6b7280;white-space:nowrap;vertical-align:middle;text-transform:uppercase;letter-spacing:0.04em;">${esc(r.label)}</td>
        <td style="padding:11px 14px;font-size:13px;font-weight:500;color:#1a1d23;vertical-align:middle;">${esc(String(r.value))}</td>
      </tr>
      <tr><td colspan="3" style="padding:0;height:1px;background:#e5e8ed;"></td></tr>`)
    .join('');
}

function layout({ headerColor, headerLabel, headerTitle, pill, pillColor, body, footer }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation"
             style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${headerColor};padding:28px 32px;">
            <p style="margin:0 0 4px;color:rgba(255,255,255,0.7);font-size:11px;text-transform:uppercase;letter-spacing:0.1em;">${headerLabel}</p>
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;">${headerTitle}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 16px;">
            ${body}
            <div style="display:inline-block;padding:10px 18px;background:${pillColor}1a;border-left:4px solid ${pillColor};border-radius:0 8px 8px 0;margin-bottom:8px;">
              <p style="margin:0;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;">Booking Number</p>
              <p style="margin:4px 0 0;font-size:22px;font-weight:800;color:${pillColor};letter-spacing:0.05em;">${pill}</p>
            </div>
          </td>
        </tr>
        <tr><td style="padding:0 32px 28px;">${footer}</td></tr>
        <tr>
          <td style="padding:18px 32px;background:#f9fafb;border-top:1px solid #e5e8ed;">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;line-height:1.6;">
              Automated notification from BooklyAI booking system.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendBookingConfirmation({ to, businessName, bookingNum, name, rows }) {
  console.log(`Email: sendBookingConfirmation called → to=${to} bookingNum=${bookingNum}`);
  if (!to || !to.includes('@')) return;
  const html = layout({
    headerColor: '#0ea5e9',
    headerLabel: 'Booking Confirmation',
    headerTitle: esc(businessName),
    pill: esc(bookingNum),
    pillColor: '#0ea5e9',
    body: `<p style="margin:0 0 18px;font-size:14px;color:#374151;line-height:1.6;">Dear <strong>${esc(name)}</strong>,<br/>your booking has been confirmed successfully!</p>`,
    footer: `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e5e8ed;border-radius:8px;overflow:hidden;">${buildTable(rows)}</table>`,
  });
  try {
    await resendSend({ to, subject: `✅ Booking Confirmation ${bookingNum} — ${businessName}`, html });
    console.log(`Email sent to ${to} (${bookingNum})`);
  } catch (err) {
    console.error('Email send error:', err?.message || err);
  }
}

export async function sendAdminNotification({ to, businessName, bookingNum, name, rows }) {
  if (!to || !to.includes('@')) return;
  const html = layout({
    headerColor: '#16a34a',
    headerLabel: 'New Booking',
    headerTitle: esc(businessName),
    pill: esc(bookingNum),
    pillColor: '#16a34a',
    body: '',
    footer: `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #e5e8ed;border-radius:8px;overflow:hidden;">${buildTable(rows)}</table>`,
  });
  try {
    await resendSend({ to, subject: `🆕 New Booking ${bookingNum} — ${name}`, html });
    console.log(`Admin email sent to ${to} (${bookingNum})`);
  } catch (err) {
    console.error('Admin email error:', err?.message || err);
  }
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
