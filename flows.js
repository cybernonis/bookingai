/**
 * Pluggable booking flow engine.
 * Add a new business type by adding a case in getBookingReply
 * and implementing a handler function below.
 */

import { createBooking, getAvailableSlots, getSlotById, markSlotUnavailable } from './db.js';
import { calculateDistance } from './distance.js';
import { sendBookingConfirmation, sendAdminNotification } from './email.js';
import { sendSmsConfirmation, sendAdminSms } from './sms.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export async function getBookingReply(message, history, business, options = {}) {
  if (business.config?.system_prompt) {
    return await aiChatFlow(message, history, business, options.lang || null);
  }
  switch (business.type) {
    case 'taxi':       return await taxiFlow(message, history, business);
    case 'clinic':     return clinicFlow(message, history, business);
    case 'restaurant': return restaurantFlow(message, history, business);
    case 'salon':
    default:           return salonFlow(message, history, business);
  }
}

// ── Pricing instructions builder ─────────────────────────────────────────────

function buildPricingInstructions(pricing) {
  if (!pricing) return '';
  const {
    mode = 'combined',
    base_fare = 2, price_per_km = 0.92, min_fare = 5, currency = '€',
    rounding = 0,
    two_way_enabled = false, two_way_discount_pct = 10,
    night_surcharge_enabled = false, night_surcharge_pct = 20, night_from = '22:00', night_to = '06:00',
    extras = {}, fixed_routes = [],
  } = pricing;
  const cur = currency;
  const lines = ['\n\nPRICING:'];

  if (mode === 'per_km' || mode === 'combined') {
    lines.push(`Rates: ${cur}${base_fare.toFixed(2)} start fare + ${cur}${price_per_km.toFixed(2)}/km (minimum ${cur}${min_fare.toFixed(2)}).`);
  }
  if ((mode === 'fixed' || mode === 'combined') && fixed_routes.length > 0) {
    lines.push('Fixed prices:');
    fixed_routes.forEach(r => lines.push(`• ${r.origin} → ${r.destination}: ${cur}${Number(r.price).toFixed(2)}`));
  }
  if (mode === 'combined') {
    lines.push('For known routes use the fixed price. For others calculate based on km.');
  } else if (mode === 'fixed') {
    lines.push('You ONLY have fixed prices. If no fixed price exists, politely inform the customer.');
  }

  if (rounding > 0) {
    const ex = Math.ceil(22.35 / rounding) * rounding;
    lines.push(`Rounding: Round up to the next multiple of ${rounding} (e.g. ${cur}22.35 → ${cur}${ex}).`);
  }
  if (two_way_enabled) {
    lines.push(`Return trip: ALWAYS ask if they want a return trip (Yes/No). If yes: final price = (price × 2) × ${(1 - two_way_discount_pct / 100).toFixed(2)} (${two_way_discount_pct}% two-way discount).`);
  }
  if (night_surcharge_enabled) {
    lines.push(`Night surcharge: If pickup time is between ${night_from}–${night_to}, add +${night_surcharge_pct}% to the base price.`);
  }

  const extrasItems = [];
  if (extras.child_seat)    extrasItems.push(`Child seat (+${cur}${extras.child_seat})`);
  if (extras.extra_luggage) extrasItems.push(`Extra luggage (+${cur}${extras.extra_luggage}/pc)`);
  if (extras.pet)           extrasItems.push(`Pet (+${cur}${extras.pet})`);

  if (extrasItems.length > 0) {
    lines.push('EXTRAS — ALWAYS show EXACTLY this list:');
    extrasItems.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    lines.push(`${extrasItems.length + 1}. No extras`);
    lines.push(`If they choose 1-${extrasItems.length} ask if they want anything else with the same list. If they choose ${extrasItems.length + 1} or say "no"/"nothing" proceed.`);
  }

  return lines.join('\n');
}

// ── Zone instructions builder ─────────────────────────────────────────────────

function buildZoneInstructions(zones) {
  if (!zones) return '';
  const { mode, areas, intra_zone } = zones;
  const list = Array.isArray(areas) && areas.length ? areas.join(', ') : null;
  let s = '\n\nSERVICE ZONES:';
  if (mode === 'whitelist' && list) {
    s += ` You serve ONLY routes involving these areas: ${list}. If pickup or destination do not belong to these, politely decline and inform the customer which areas you cover.`;
  } else if (mode === 'blacklist' && list) {
    s += ` You do NOT serve these areas: ${list}. You serve normally anywhere else.`;
  } else {
    s += ' You serve worldwide with no area restrictions.';
  }
  if (intra_zone === false) {
    s += '\nINTRA-ZONE RULE (applies globally, regardless of zones above): Transfers within the same city or area are NOT allowed. If pickup and destination refer to the same city/village/area, politely decline and explain you only serve between different locations. Examples NOT ALLOWED: Chania → Chania, New York → New York, Heraklion → Heraklion. Examples ALLOWED: Chania → Heraklion, New York → Los Angeles, Athens → Thessaloniki.';
  }
  return s;
}

function buildVehicleInstructions(vehicles) {
  if (!Array.isArray(vehicles) || !vehicles.length) return '';
  const enabled = vehicles.filter(v => v.enabled !== false);
  if (!enabled.length) return '';
  const lines = ['\n\nVEHICLES — ALWAYS show this list:'];
  enabled.forEach((v, i) => {
    let surcharge = '';
    if (v.surcharge_type === 'fixed' && v.surcharge_value > 0) surcharge = ` (+€${v.surcharge_value})`;
    else if (v.surcharge_type === 'pct'   && v.surcharge_value > 0) surcharge = ` (+${v.surcharge_value}%)`;
    lines.push(`${i + 1}. ${v.icon || ''} ${v.label} (${v.capacity} passengers)${surcharge}`);
  });
  lines.push(`${enabled.length + 1}. I don't know yet`);
  lines.push('If passengers > 4 → automatically suggest Van. ALWAYS ask for vehicle choice BEFORE calculating the final price. Vehicle selection affects the final amount.');
  return lines.join('\n');
}

// ── Pricing Zone instructions builder ────────────────────────────────────────

function buildPricingZoneInstructions(pricingZones) {
  if (!Array.isArray(pricingZones) || !pricingZones.length) return '';
  const lines = ['\n\nPRICING ZONES — apply ALWAYS based on pickup/destination:'];
  pricingZones.forEach(z => {
    let desc;
    if (z.surcharge_type === 'pct')            desc = `+${z.surcharge_value}% on top of price`;
    else if (z.surcharge_type === 'fixed')     desc = `+€${z.surcharge_value} fixed`;
    else if (z.surcharge_type === 'multiplier') desc = `×${z.surcharge_value} (multiply base price)`;
    else                                        desc = `+${z.surcharge_value}`;
    const kwds = Array.isArray(z.keywords) && z.keywords.length ? z.keywords.join(', ') : z.name.toLowerCase();
    lines.push(`• "${z.name}": if pickup or destination contains [${kwds}] → ${desc}`);
  });
  lines.push('ZONE RULE: Before giving a final price, check IF pickup or destination matches any zone. If yes, apply the zone surcharge on top and inform the customer (e.g. "Zone surcharge \'South Rethymno\' applied: +€10, final price €X").');
  return lines.join('\n');
}

// ── AI Chat Flow (Claude-powered) ─────────────────────────────────────────────

const LANG_NAMES = { el: 'Greek', en: 'English', fr: 'French', de: 'German', it: 'Italian', es: 'Spanish', ru: 'Russian' };

async function aiChatFlow(message, history, business, lang) {
  const msgs = history.map(m => ({
    role: m.role,
    content: m.content === '__init__' ? 'Hello.' : m.content,
  }));

  msgs.push({ role: 'user', content: message === '__init__' ? 'Hello.' : message });

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const pricingRules      = buildPricingInstructions(business.config.pricing);
  const vehicleRules      = buildVehicleInstructions(business.config.vehicles);
  const zoneRules         = buildZoneInstructions(business.config.zones);
  const pricingZoneRules  = buildPricingZoneInstructions(business.config.pricing_zones);

  // Session language: customer selected a specific language in the widget
  const sessionLang = lang && LANG_NAMES[lang]
    ? `\n\nSESSION LANGUAGE: The customer selected ${LANG_NAMES[lang]}. ALWAYS respond in ${LANG_NAMES[lang]}. Never switch language.`
    : `\n\nDEFAULT LANGUAGE: Respond in English. If the customer writes in a different language you may continue in that language.`;

  const distanceMarker = `\n\nDISTANCE MARKER: When showing the booking summary before asking for final confirmation, include exactly this on its own line (replace with actual values): PRE_CONFIRM:pickup|destination\nThis marker will be replaced with the real road distance and duration shown to the customer. Do NOT include it after the customer confirms — only in the summary step.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `Today is ${today}.\n\n${business.config.system_prompt}${pricingRules}${vehicleRules}${zoneRules}${pricingZoneRules}${sessionLang}${distanceMarker}`,
    messages: msgs,
  });

  let text = response.content[0].text;

  // Inject distance into pre-confirmation summary
  const preConfirmMatch = text.match(/PRE_CONFIRM:([^\n]+)/);
  if (preConfirmMatch) {
    const [prePickup, preDest] = preConfirmMatch[1].split('|').map(s => s.trim());
    let distLine = '';
    if (prePickup && preDest && prePickup.toLowerCase() !== 'skip' && preDest.toLowerCase() !== 'skip') {
      try {
        const d = await calculateDistance(prePickup, preDest);
        distLine = `📏 **Distance: ${d.distance_text}${d.duration_text ? ` · ⏱ ${d.duration_text}` : ''}**`;
      } catch { /* silent — no distance shown */ }
    }
    text = text.replace(preConfirmMatch[0], distLine);
  }

  // Detect booking confirmation marker and create real DB entry
  const confirmMatch = text.match(/CONFIRMED_BOOKING:([^\n]+)/);
  if (confirmMatch) {
    const parts = confirmMatch[1].split('|').map(s => s.trim());
    const [name, phone, email, pickup, destination, datetime, vehicle, price] = parts;

    const timeMatch = (datetime || '').match(/\b(\d{1,2}:\d{2})\b/);
    const time = timeMatch ? timeMatch[1].padStart(5, '0') : '00:00';
    const date = new Date().toISOString().split('T')[0];

    const cleanEmail = email && email.toLowerCase() !== 'skip' && email.includes('@') ? email : null;

    // Calculate real road distance
    let distInfo = null;
    if (pickup && destination && pickup.toLowerCase() !== 'skip' && destination.toLowerCase() !== 'skip') {
      try {
        distInfo = await calculateDistance(pickup, destination);
      } catch (err) {
        console.warn('Distance calc failed:', err.message);
      }
    }

    const booking = createBooking({
      business_id: business.business_id,
      name: name || 'Customer',
      email: cleanEmail,
      phone: phone || null,
      service: `${pickup} → ${destination}`,
      date, time, status: 'confirmed',
      notes: JSON.stringify({
        pickup, destination, datetime, vehicle, price,
        ...(distInfo ? { distance_km: distInfo.distance_km, duration_mins: distInfo.duration_mins } : {}),
      }),
    });

    const year = new Date().getFullYear();
    const bookingNum = `#TXI-${year}-${String(booking.id).padStart(3, '0')}`;

    if (cleanEmail) {
      sendBookingConfirmation({
        to: cleanEmail,
        businessName: business.name,
        bookingNum,
        name: name || 'Customer',
        rows: [
          { icon: '🚩', label: 'Pickup',       value: pickup },
          { icon: '🏁', label: 'Destination',  value: destination },
          { icon: '📅', label: 'Date & Time',  value: datetime },
          ...(distInfo ? [
            { icon: '📏', label: 'Distance',   value: distInfo.distance_text },
            { icon: '⏱',  label: 'Duration',   value: distInfo.duration_text },
          ] : []),
          { icon: '🚗', label: 'Vehicle',      value: vehicle },
          { icon: '💰', label: 'Price',        value: price },
        ],
      }).catch(e => console.error('Email err:', e?.message));
    }

    if (phone) {
      sendSmsConfirmation({
        to: phone,
        businessName: business.name,
        bookingNum,
        pickup, destination, datetime, vehicle, price,
      }).catch(e => console.error('SMS err:', e?.message));
    }

    const adminEmail = business.config?.email;
    const adminPhone = business.config?.phone;

    if (adminEmail) {
      sendAdminNotification({
        to: adminEmail,
        businessName: business.name,
        bookingNum,
        name: name || 'Customer',
        phone, email: cleanEmail,
        rows: [
          { icon: '👤', label: 'Customer',     value: name },
          { icon: '📱', label: 'Phone',        value: phone },
          { icon: '📧', label: 'Email',        value: cleanEmail },
          { icon: '🚩', label: 'Pickup',       value: pickup },
          { icon: '🏁', label: 'Destination',  value: destination },
          { icon: '📅', label: 'Date & Time',  value: datetime },
          ...(distInfo ? [
            { icon: '📏', label: 'Distance',   value: distInfo.distance_text },
            { icon: '⏱',  label: 'Duration',   value: distInfo.duration_text },
          ] : []),
          { icon: '🚗', label: 'Vehicle',      value: vehicle },
          { icon: '💰', label: 'Price',        value: price },
        ],
      }).catch(e => console.error('Admin email err:', e?.message));
    }

    if (adminPhone) {
      sendAdminSms({
        to: adminPhone,
        businessName: business.name,
        bookingNum,
        name: name || 'Customer',
        phone, pickup, destination, datetime, vehicle, price,
      }).catch(e => console.error('Admin SMS err:', e?.message));
    }

    const distLine = distInfo
      ? `\n📏 **Distance: ${distInfo.distance_text}${distInfo.duration_text ? ` · ⏱ ${distInfo.duration_text}` : ''}**`
      : '';
    text = text.replace(confirmMatch[0], `${distLine}\n🔖 **Booking #: ${bookingNum}**`);
  }

  return text;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const step = h => h.filter(m => m.role === 'assistant').length;
// Filter out the widget's __init__ trigger so flow indices start from the first real user message
const userMsgs = h => h.filter(m => m.role === 'user' && m.content !== '__init__').map(m => m.content);

// ── Salon Flow ────────────────────────────────────────────────────────────────

function salonFlow(message, history, business) {
  const s  = step(history);
  const um = userMsgs(history);
  const serviceNames = business.services.map(sv => sv.name);

  switch (s) {
    case 0:
      return `Hello! Welcome to **${business.name}**! 💇\n\nWhich service would you like?\n\n${serviceNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

    case 1: {
      const slots = getAvailableSlots(business.business_id);
      const dates = [...new Set(slots.map(sl => sl.date))];
      if (!dates.length) return 'No appointments available at the moment. Please contact us by phone.';
      const list = dates.map(d => {
        const dt = new Date(d + 'T00:00:00');
        return `• ${dt.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })} (${d})`;
      }).join('\n');
      return `Great! 👍\n\nWhich date suits you?\n\n${list}`;
    }

    case 2: {
      const dateMatch = [...um].reverse().join(' ').match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] ?? null;
      const avail = getAvailableSlots(business.business_id, date);
      const list = avail.length
        ? avail.map(sl => `• Slot #${sl.id} — ${sl.date} at ${sl.time}`).join('\n')
        : 'No available times for this date. Please try another.';
      return `Available times:\n\n${list}\n\nWhich time works for you?`;
    }

    case 3: return 'Perfect! What is your name?';
    case 4: return 'Thank you! What is your phone number?';
    case 5: return 'And your email for the confirmation?';

    case 6: {
      const emailMatch = message.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      const email   = emailMatch?.[0] ?? message.trim();
      const name    = um[3] ?? 'Customer';
      const phone   = um[4] ?? null;
      const service = um[0] ?? null;
      const slotMatch = um.join(' ').match(/slot #?(\d+)/i) ?? um.join(' ').match(/#(\d+)/);
      const slot = slotMatch ? getSlotById(parseInt(slotMatch[1])) : null;

      if (slot?.available) {
        markSlotUnavailable(slot.id);
        const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: slot.date, time: slot.time, status: 'confirmed' });
        sendBookingConfirmation({
          to: email, businessName: business.name, bookingNum: `#${b.id}`, name,
          rows: [
            { icon: '💇', label: 'Service', value: service },
            { icon: '📅', label: 'Date',    value: slot.date },
            { icon: '🕐', label: 'Time',    value: slot.time },
          ],
        }).catch(e => console.error('Email err:', e?.message));
        return `✅ Confirmed!\n\n📋 ${service ?? '—'}\n📅 ${slot.date} · ${slot.time}\n👤 ${name} · 📱 ${phone ?? '—'} · 📧 ${email}\n🔖 #${b.id}\n\nWe look forward to seeing you! 🙂`;
      }
      const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: '—', time: '—', status: 'pending' });
      sendBookingConfirmation({
        to: email, businessName: business.name, bookingNum: `#${b.id}`, name,
        rows: [{ icon: '💇', label: 'Service', value: service }],
      }).catch(e => console.error('Email err:', e?.message));
      return `✅ Booking registered!\n👤 ${name} · 📧 ${email}\n🔖 #${b.id}\n\nWe'll be in touch soon!`;
    }

    default: return 'Can I help you with anything else?';
  }
}

// ── Taxi Flow ─────────────────────────────────────────────────────────────────

async function taxiFlow(message, history, business) {
  const s   = step(history);
  const um  = userMsgs(history);
  const cfg = business.config;
  const baseFare = cfg.base_fare    ?? 3.50;
  const perKm    = cfg.price_per_km ?? 1.50;
  const minFare  = cfg.min_fare     ?? 4.50;
  const cur      = cfg.currency     ?? '€';

  switch (s) {
    case 0:
      return `Hi! Welcome to **${business.name}**! 🚕\n\nWhere would you like to be picked up?`;

    case 1:
      return `Where would you like to go?`;

    case 2: {
      const pickup = um[0];
      const dest   = message;
      const lines  = [`🚩 Pickup: ${pickup}`, `🏁 Destination: ${dest}`];

      const norm = s => s.toLowerCase().replace(/[.,\-–]/g, ' ').replace(/\s+/g, ' ').trim();
      const fixedRoutes = cfg.fixed_routes ?? [];
      const fixedMatch  = fixedRoutes.find(r => {
        const o = norm(r.origin);
        const d = norm(r.destination);
        const p = norm(pickup);
        const ds = norm(dest);
        return (p.includes(o) || o.includes(p)) && (ds.includes(d) || d.includes(ds));
      });

      if (fixedMatch) {
        lines.push(`💰 Fixed price: **${cur}${fixedMatch.price.toFixed(2)}**`);
        lines.push(`_(${norm(fixedMatch.origin)} → ${norm(fixedMatch.destination)})_`);
        if (cfg.tariff_note) lines.push(`ℹ️ ${cfg.tariff_note}`);
      } else {
        try {
          const info  = await calculateDistance(pickup, dest);
          const km    = info.distance_km;
          const price = Math.max(minFare, baseFare + km * perKm);
          const note  = (info.source === 'ors' || info.source === 'google') ? 'road distance' : 'straight-line';
          lines.push(`📏 Distance: ~${km.toFixed(1)} km (${note})`);
          if (info.duration_text) lines.push(`⏱ Est. duration: ${info.duration_text}`);
          lines.push(`💰 Est. price: ~${cur}${price.toFixed(2)}  _(${cur}${baseFare} start + ${cur}${perKm}/km)_`);
          if (cfg.tariff_note) lines.push(`ℹ️ ${cfg.tariff_note}`);
        } catch {
          lines.push(`💰 Rate: ${cur}${baseFare} start + ${cur}${perKm}/km (min ${cur}${minFare})`);
          lines.push(`_(automatic distance calculation unavailable)_`);
        }
      }

      return `📍 **Route:**\n${lines.join('\n')}\n\nWhen do you need the taxi? (e.g. "tomorrow at 09:00")`;
    }

    case 3: return `What is your name?`;
    case 4: return `What is your phone number?`;

    case 5: {
      const pickup   = um[0];
      const dest     = um[1];
      const datetime = um[2];
      const name     = um[3];
      const phone    = message;

      const timeMatch = datetime.match(/\b(\d{1,2}:\d{2})\b/);
      const time  = timeMatch ? timeMatch[1].padStart(5, '0') : '00:00';
      const today = new Date().toISOString().split('T')[0];

      const b = createBooking({
        business_id: business.business_id,
        name, email: null, phone,
        service: `${pickup} → ${dest}`,
        date: today, time, status: 'confirmed',
        notes: JSON.stringify({ pickup, destination: dest, datetime }),
      });

      return `✅ Confirmed!\n\n🚕 **${business.name}**\n🚩 ${pickup}\n🏁 ${dest}\n📅 ${datetime}\n👤 ${name} · 📱 ${phone}\n🔖 #${b.id}\n\nThe taxi will be waiting for you! Have a great trip! 🙂`;
    }

    default: return `Do you need another ride?`;
  }
}

// ── Clinic Flow ───────────────────────────────────────────────────────────────

function clinicFlow(message, history, business) {
  const s   = step(history);
  const um  = userMsgs(history);
  const cfg = business.config;
  const specialties = cfg.specialties ?? business.services.map(sv => sv.name);

  switch (s) {
    case 0:
      return `Good day! Welcome to **${business.name}**! 🏥\n\nWhich specialty do you need an appointment for?\n\n${specialties.map((sp, i) => `${i + 1}. ${sp}`).join('\n')}`;

    case 1:
      return `Could you briefly tell us the reason for your visit? (optional)`;

    case 2: {
      const slots = getAvailableSlots(business.business_id);
      const dates = [...new Set(slots.map(sl => sl.date))];
      if (!dates.length) return 'No appointments available. Please call us for assistance.';
      const list = dates.map(d => {
        const dt = new Date(d + 'T00:00:00');
        return `• ${dt.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })} (${d})`;
      }).join('\n');
      return `Available dates:\n\n${list}\n\nWhich suits you?`;
    }

    case 3: {
      const dateMatch = [...um].reverse().join(' ').match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] ?? null;
      const avail = getAvailableSlots(business.business_id, date);
      const list = avail.length
        ? avail.map(sl => `• Slot #${sl.id} — ${sl.date} at ${sl.time}`).join('\n')
        : 'No available times for this date.';
      return `Available times:\n\n${list}`;
    }

    case 4: return `What is your full name?`;
    case 5: return `What is your phone number?`;
    case 6: return `And your email for the confirmation?`;

    case 7: {
      const emailMatch = message.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      const email     = emailMatch?.[0] ?? message.trim();
      const specialty = um[0];
      const reason    = um[1];
      const name      = um[4];
      const phone     = um[5];
      const slotMatch = um.join(' ').match(/slot #?(\d+)/i) ?? um.join(' ').match(/#(\d+)/);
      const slot = slotMatch ? getSlotById(parseInt(slotMatch[1])) : null;

      const service = reason && reason.length > 3 ? `${specialty} — ${reason}` : specialty;

      if (slot?.available) {
        markSlotUnavailable(slot.id);
        const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: slot.date, time: slot.time, status: 'confirmed' });
        sendBookingConfirmation({
          to: email, businessName: business.name, bookingNum: `#${b.id}`, name,
          rows: [
            { icon: '🏥', label: 'Specialty', value: specialty },
            { icon: '📅', label: 'Date',      value: slot.date },
            { icon: '🕐', label: 'Time',      value: slot.time },
          ],
        }).catch(e => console.error('Email err:', e?.message));
        return `✅ Your appointment is confirmed!\n\n🏥 ${specialty}\n📅 ${slot.date} · ${slot.time}\n👤 ${name} · 📱 ${phone}\n📧 ${email}\n🔖 #${b.id}\n\nWe look forward to seeing you!`;
      }
      const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: '—', time: '—', status: 'pending' });
      sendBookingConfirmation({
        to: email, businessName: business.name, bookingNum: `#${b.id}`, name,
        rows: [{ icon: '🏥', label: 'Specialty', value: specialty }],
      }).catch(e => console.error('Email err:', e?.message));
      return `✅ Registered!\n👤 ${name} · 📧 ${email}\n🔖 #${b.id}\n\nWe'll contact you to confirm.`;
    }

    default: return `Can I help you book a new appointment?`;
  }
}

// ── Restaurant Flow ───────────────────────────────────────────────────────────

function restaurantFlow(message, history, business) {
  const s   = step(history);
  const um  = userMsgs(history);
  const cfg = business.config;
  const resDuration = cfg.reservation_duration ?? 90;

  switch (s) {
    case 0:
      return `Good evening! Welcome to **${business.name}**! 🍽️\n\nHow many guests will there be?`;

    case 1: {
      const today = new Date();
      const days  = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() + i + 1);
        return d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
      });
      return `When would you like to make a reservation?\n\n${days.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
    }

    case 2:
      return `What time would you prefer? (e.g. "7:30 PM", "8:00 PM")`;

    case 3:
      return `What is your full name?`;

    case 4:
      return `What is your phone number?`;

    case 5: {
      const guests   = um[0];
      const dateDesc = um[1];
      const timeStr  = um[2];
      const name     = um[3];
      const phone    = message;

      const timeMatch = timeStr.match(/\b(\d{1,2}:\d{2})\b/) ?? timeStr.match(/\b(\d{1,2})\b/);
      let time = '20:00';
      if (timeMatch) {
        const parts = timeMatch[1].split(':');
        time = parts.length === 2 ? timeMatch[1].padStart(5, '0') : `${parts[0].padStart(2, '0')}:00`;
      }

      const today = new Date().toISOString().split('T')[0];
      const b = createBooking({
        business_id: business.business_id,
        name, email: null, phone,
        service: `${guests} guests`,
        date: today, time, status: 'confirmed',
        notes: JSON.stringify({ guests, date: dateDesc, time: timeStr, duration_min: resDuration }),
      });

      return `✅ Your reservation is confirmed!\n\n🍽️ **${business.name}**\n👥 ${guests} guests\n📅 ${dateDesc} · ${time}\n⏱ Duration: ~${resDuration} min\n👤 ${name} · 📱 ${phone}\n🔖 #${b.id}\n\nWe look forward to seeing you! 🥂`;
    }

    default: return `Can I help you with a new reservation?`;
  }
}

// ── AI Settings Command ───────────────────────────────────────────────────────

// Detects commands that describe a geographic area for a pricing zone
const GEO_DIRECTION_RE = /νότι|βόρει|ανατολι|δυτι|χωριά|χωριό|χωρι[οό]\b|ορειν|παραλι|γύρω|γυρω|κοντά|κοντα|κοντιν|ημιορειν|south|north|east|west|village|mountain|coastal|rural/i;
const SURCHARGE_RE     = /\+\s*[€$]?\s*\d|\d+\s*%|x\s*\d+[.,]?\d*|×\s*\d+|επιπλέον.*\d|\d.*επιπλέον/i;

function isGeographicZoneCommand(msg) {
  return GEO_DIRECTION_RE.test(msg) && SURCHARGE_RE.test(msg);
}

// Two-call path: Claude identifies which specific places match the
// geographic description and generates comprehensive keywords.
async function applyGeographicZone(message, business) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: `You are a geography expert helping a taxi company define pricing zones.
The admin describes a geographic zone in natural language.

Your task:
1. Identify the specific villages / areas / cities that belong to the geographic description
2. Explain the requested surcharge
3. Create a comprehensive keyword list for recognising these locations

Return ONLY valid JSON (no markdown, no explanations):
{
  "zone_name": "Short display name for the zone",
  "surcharge_type": "pct" or "fixed" or "multiplier",
  "surcharge_value": number,
  "keywords": ["location1", "location2", ...],
  "preview": "5-6 key locations separated by comma"
}

Rules:
- keywords: 10-25 village/area names, lowercase, in the local language of the described region
- Add spelling variants for each location if needed
- surcharge_type "pct": +N% → surcharge_value = N (e.g. 20 for +20%)
- surcharge_type "fixed": +€N → surcharge_value = N (e.g. 10 for +€10)
- surcharge_type "multiplier": ×N → surcharge_value = N (e.g. 1.3 for ×1.3)`,
    messages: [{ role: 'user', content: message }],
  });

  const raw = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { message: 'Could not parse the geographic zone. Please be more specific.', patch: null };

  let zone;
  try { zone = JSON.parse(match[0]); }
  catch { return { message: 'Parse error. Please try again.', patch: null }; }

  const newZone = {
    id:              'geo_' + Date.now().toString(36),
    name:            zone.zone_name,
    surcharge_type:  zone.surcharge_type,
    surcharge_value: zone.surcharge_value,
    keywords:        Array.isArray(zone.keywords) ? zone.keywords : [],
  };

  let surchargeLabel;
  if (zone.surcharge_type === 'pct')        surchargeLabel = `+${zone.surcharge_value}%`;
  else if (zone.surcharge_type === 'fixed') surchargeLabel = `+€${zone.surcharge_value}`;
  else                                      surchargeLabel = `×${zone.surcharge_value}`;

  return {
    message: `🗺 Found **${newZone.keywords.length} locations** for zone "${zone.zone_name}" (${surchargeLabel}). Save it?`,
    pending_zone: newZone,
    patch: null,
  };
}

export async function applySettingsCommand(message, business) {
  if (isGeographicZoneCommand(message)) {
    return await applyGeographicZone(message, business);
  }

  const configJson = JSON.stringify(business.config, null, 2);
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: `You are an AI assistant for managing taxi business settings.
The admin writes a command in their preferred language. You convert it into a JSON patch to update the config.

CURRENT CONFIG:
${configJson}

CONFIG STRUCTURE:
- email: string (business email)
- office_address: string (physical address)
- region: { country:"greece"|"cyprus"|"other", prefecture?:string, custom?:string }
- dashboard_lang: "el"|"en"|"fr"|"de"|"it"|"es"|"ru"
- widget_lang: { mode:"auto"|"single"|"multi", lang?:string, langs?:string[] }
  • "auto": reply in customer's language
  • "single": always in language lang
  • "multi": customer chooses from langs
- zones: { mode: "whitelist"|"blacklist"|"open", areas: string[], intra_zone: boolean }
- pricing: { mode, base_fare, price_per_km, min_fare, currency, rounding, two_way_enabled, two_way_discount_pct, night_surcharge_enabled, night_surcharge_pct, night_from, night_to, extras:{child_seat,extra_luggage,pet}, fixed_routes:[{origin,destination,price}] }
- vehicles: [{ id, label, icon, capacity, surcharge_type:"none"|"fixed"|"pct", surcharge_value, enabled }]
- pricing_zones: [{ id, name, surcharge_type:"pct"|"fixed"|"multiplier", surcharge_value, keywords:string[] }]
  • surcharge_type "pct": +N%, "fixed": +€N, "multiplier": ×N
  • keywords: list of words (lowercase) for location matching

RULES:
1. Return ONLY valid JSON: {"message":"...English...","patch":{...} or null}
2. In patch include ONLY top-level keys that change
3. For arrays/objects send the FULL element (not partial)
4. Examples:
   - "Add Rethymno to areas" → patch: { zones: { ...currentZones, areas: [...currentAreas, "Rethymno"] } }
   - "Change Heraklion-Rethymno price to €60" → patch: { pricing: { ...currentPricing, fixed_routes: [...updatedRoutes] } }
   - "Enable night surcharge +25%" → patch: { pricing: { ...currentPricing, night_surcharge_enabled:true, night_surcharge_pct:25 } }
   - "Lasithi area ×1.2" → patch: { pricing_zones: [...currentZones, { id:"zone_1", name:"Lasithi Area", surcharge_type:"multiplier", surcharge_value:1.2, keywords:["lasithi","ierapetra","sitia","agios nikolaos"] }] }
   - "Delete Lasithi zone" → filter pricing_zones array, patch: { pricing_zones: [filteredArray] }
   - "Show pricing zones" → message with list, patch: null
5. Write nothing outside JSON`,
    messages: [{ role: 'user', content: message }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { message: 'Could not understand the command. Please try again.', patch: null };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { message: 'Parse error. Please try again.', patch: null };
  }
}
