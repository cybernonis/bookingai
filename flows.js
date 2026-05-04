/**
 * Pluggable booking flow engine.
 * Add a new business type by adding a case in getBookingReply
 * and implementing a handler function below.
 */

import { createBooking, getAvailableSlots, getSlotById, markSlotUnavailable } from './db.js';
import { calculateDistance } from './distance.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export async function getBookingReply(message, history, business) {
  if (business.config?.system_prompt) {
    return await aiChatFlow(message, history, business);
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
  const lines = ['\n\nΤΙΜΟΛΟΓΗΣΗ:'];

  if (mode === 'per_km' || mode === 'combined') {
    lines.push(`Τιμοκατάλογος: ${cur}${base_fare.toFixed(2)} εκκίνηση + ${cur}${price_per_km.toFixed(2)}/χλμ (ελάχιστο ${cur}${min_fare.toFixed(2)}).`);
  }
  if ((mode === 'fixed' || mode === 'combined') && fixed_routes.length > 0) {
    lines.push('Σταθερές τιμές:');
    fixed_routes.forEach(r => lines.push(`• ${r.origin} → ${r.destination}: ${cur}${Number(r.price).toFixed(2)}`));
  }
  if (mode === 'combined') {
    lines.push('Για γνωστές διαδρομές χρησιμοποίησε τη σταθερή τιμή. Για άλλες υπολόγισε βάσει χλμ.');
  } else if (mode === 'fixed') {
    lines.push('Έχεις ΜΟΝΟ σταθερές τιμές. Αν δεν υπάρχει σταθερή τιμή, ενημέρωσε ευγενικά.');
  }

  if (rounding > 0) {
    const ex = Math.ceil(22.35 / rounding) * rounding;
    lines.push(`Στρογγυλοποίηση: Στρογγυλοποίησε στο επόμενο πολλαπλάσιο του ${rounding} (π.χ. ${cur}22.35 → ${cur}${ex}).`);
  }
  if (two_way_enabled) {
    lines.push(`Μετ' επιστροφής: Ρώτα ΠΑΝΤΑ αν θέλει επιστροφή (Ναι/Όχι). Αν ναι: τελική τιμή = (τιμή × 2) × ${(1 - two_way_discount_pct / 100).toFixed(2)} (${two_way_discount_pct}% έκπτωση two-way).`);
  }
  if (night_surcharge_enabled) {
    lines.push(`Νυχτερινή χρέωση: Αν η ώρα παραλαβής είναι ${night_from}–${night_to}, πρόσθεσε +${night_surcharge_pct}% στη βασική τιμή.`);
  }

  const extrasItems = [];
  if (extras.child_seat)    extrasItems.push(`Παιδικό κάθισμα (+${cur}${extras.child_seat})`);
  if (extras.extra_luggage) extrasItems.push(`Επιπλέον αποσκευή (+${cur}${extras.extra_luggage}/τεμ.)`);
  if (extras.pet)           extrasItems.push(`Κατοικίδιο (+${cur}${extras.pet})`);

  if (extrasItems.length > 0) {
    lines.push('EXTRAS — εμφάνισε ΠΑΝΤΑ ΑΚΡΙΒΩΣ αυτή τη λίστα:');
    extrasItems.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    lines.push(`${extrasItems.length + 1}. Χωρίς extras`);
    lines.push(`Αν επιλέξει 1-${extrasItems.length} ρώτα αν θέλει κάτι άλλο με την ίδια λίστα. Αν επιλέξει ${extrasItems.length + 1} ή πει "όχι"/"τίποτα" προχώρα.`);
  }

  return lines.join('\n');
}

// ── Zone instructions builder ─────────────────────────────────────────────────

function buildZoneInstructions(zones) {
  if (!zones) return '';
  const { mode, areas, intra_zone } = zones;
  const list = Array.isArray(areas) && areas.length ? areas.join(', ') : null;
  let s = '\n\nΖΩΝΕΣ ΕΞΥΠΗΡΕΤΗΣΗΣ:';
  if (mode === 'whitelist' && list) {
    s += ` Εξυπηρετείς ΜΟΝΟ διαδρομές που αφορούν αυτές τις περιοχές: ${list}. Αν pickup ή προορισμός δεν ανήκουν σε αυτές, απόρριψε ευγενικά και ενημέρωσε τον πελάτη ποιες περιοχές καλύπτεις.`;
  } else if (mode === 'blacklist' && list) {
    s += ` ΔΕΝ εξυπηρετείς αυτές τις περιοχές: ${list}. Σε οποιαδήποτε άλλη περιοχή εξυπηρετείς κανονικά.`;
  } else {
    s += ' Εξυπηρετείς παγκοσμίως χωρίς περιορισμό περιοχής.';
  }
  if (intra_zone === false) {
    s += ' Transfers εντός της ίδιας περιοχής/πόλης ΔΕΝ επιτρέπονται.';
  }
  return s;
}

// ── AI Chat Flow (Claude-powered) ─────────────────────────────────────────────

async function aiChatFlow(message, history, business) {
  const msgs = history.map(m => ({
    role: m.role,
    content: m.content === '__init__' ? 'Γεια σου.' : m.content,
  }));

  msgs.push({ role: 'user', content: message === '__init__' ? 'Γεια σου.' : message });

  const today = new Date().toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const pricingRules = buildPricingInstructions(business.config.pricing);
  const zoneRules    = buildZoneInstructions(business.config.zones);
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `Σήμερα είναι ${today}.\n\n${business.config.system_prompt}${pricingRules}${zoneRules}`,
    messages: msgs,
  });

  let text = response.content[0].text;

  // Detect booking confirmation marker and create real DB entry
  const confirmMatch = text.match(/CONFIRMED_BOOKING:([^\n]+)/);
  if (confirmMatch) {
    const parts = confirmMatch[1].split('|').map(s => s.trim());
    const [name, phone, pickup, destination, datetime, vehicle, price] = parts;

    const timeMatch = (datetime || '').match(/\b(\d{1,2}:\d{2})\b/);
    const time = timeMatch ? timeMatch[1].padStart(5, '0') : '00:00';
    const date = new Date().toISOString().split('T')[0];

    const booking = createBooking({
      business_id: business.business_id,
      name: name || 'Πελάτης',
      email: null,
      phone: phone || null,
      service: `${pickup} → ${destination}`,
      date, time, status: 'confirmed',
      notes: JSON.stringify({ pickup, destination, datetime, vehicle, price }),
    });

    const year = new Date().getFullYear();
    const bookingNum = `#TXI-${year}-${String(booking.id).padStart(3, '0')}`;
    text = text.replace(confirmMatch[0], `\n🔖 **Αριθμός κράτησης: ${bookingNum}**`);
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
      return `Γεια σου! Καλώς ήρθες στο **${business.name}**! 💇\n\nΠοια υπηρεσία θα ήθελες;\n\n${serviceNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

    case 1: {
      const slots = getAvailableSlots(business.business_id);
      const dates = [...new Set(slots.map(sl => sl.date))];
      if (!dates.length) return 'Δεν υπάρχουν διαθέσιμα ραντεβού αυτή τη στιγμή. Επικοινωνήστε μαζί μας τηλεφωνικά.';
      const list = dates.map(d => {
        const dt = new Date(d + 'T00:00:00');
        return `• ${dt.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long' })} (${d})`;
      }).join('\n');
      return `Ωραία! 👍\n\nΠοια ημερομηνία σε βολεύει;\n\n${list}`;
    }

    case 2: {
      const dateMatch = [...um].reverse().join(' ').match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] ?? null;
      const avail = getAvailableSlots(business.business_id, date);
      const list = avail.length
        ? avail.map(sl => `• Slot #${sl.id} — ${sl.date} στις ${sl.time}`).join('\n')
        : 'Δεν υπάρχουν ώρες για αυτή την ημερομηνία. Δοκίμασε άλλη.';
      return `Διαθέσιμες ώρες:\n\n${list}\n\nΠοια ώρα σε εξυπηρετεί;`;
    }

    case 3: return 'Τέλεια! Πώς σε λένε;';
    case 4: return 'Ευχαριστώ! Ποιο είναι το τηλέφωνό σου;';
    case 5: return 'Και το email σου για την επιβεβαίωση;';

    case 6: {
      const emailMatch = message.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      const email   = emailMatch?.[0] ?? message.trim();
      const name    = um[3] ?? 'Πελάτης';
      const phone   = um[4] ?? null;
      const service = um[0] ?? null;
      const slotMatch = um.join(' ').match(/slot #?(\d+)/i) ?? um.join(' ').match(/#(\d+)/);
      const slot = slotMatch ? getSlotById(parseInt(slotMatch[1])) : null;

      if (slot?.available) {
        markSlotUnavailable(slot.id);
        const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: slot.date, time: slot.time, status: 'confirmed' });
        return `✅ Επιβεβαιώθηκε!\n\n📋 ${service ?? '—'}\n📅 ${slot.date} · ${slot.time}\n👤 ${name} · 📱 ${phone ?? '—'} · 📧 ${email}\n🔖 #${b.id}\n\nΣε περιμένουμε! 🙂`;
      }
      const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: '—', time: '—', status: 'pending' });
      return `✅ Καταχωρήθηκε!\n👤 ${name} · 📧 ${email}\n🔖 #${b.id}\n\nΘα επικοινωνήσουμε σύντομα!`;
    }

    default: return 'Μπορώ να σε βοηθήσω με κάτι άλλο;';
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
      return `Γεια! Καλώς ήρθατε στο **${business.name}**! 🚕\n\nΠού θέλετε να σας παραλάβουμε;`;

    case 1:
      return `Πού θέλετε να πάτε;`;

    case 2: {
      const pickup = um[0];
      const dest   = message;
      const lines  = [`🚩 Αναχώρηση: ${pickup}`, `🏁 Προορισμός: ${dest}`];

      // Normalize for fuzzy matching (lowercase, collapse spaces)
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
        lines.push(`💰 Σταθερή τιμή: **${cur}${fixedMatch.price.toFixed(2)}**`);
        lines.push(`_(${norm(fixedMatch.origin)} → ${norm(fixedMatch.destination)})_`);
        if (cfg.tariff_note) lines.push(`ℹ️ ${cfg.tariff_note}`);
      } else {
        try {
          const info  = await calculateDistance(pickup, dest);
          const km    = info.distance_km;
          const price = Math.max(minFare, baseFare + km * perKm);
          const note  = info.source === 'google' ? 'οδική' : 'ευθεία γραμμή';
          lines.push(`📏 Απόσταση: ~${km.toFixed(1)} χλμ (${note})`);
          if (info.duration_text) lines.push(`⏱ Εκτ. διάρκεια: ${info.duration_text}`);
          lines.push(`💰 Εκτ. τιμή: ~${cur}${price.toFixed(2)}  _(${cur}${baseFare} εκκίνηση + ${cur}${perKm}/χλμ)_`);
          if (cfg.tariff_note) lines.push(`ℹ️ ${cfg.tariff_note}`);
        } catch {
          lines.push(`💰 Τιμοκατάλογος: ${cur}${baseFare} εκκίνηση + ${cur}${perKm}/χλμ (min ${cur}${minFare})`);
          lines.push(`_(δεν ήταν δυνατός ο αυτόματος υπολογισμός απόστασης)_`);
        }
      }

      return `📍 **Διαδρομή:**\n${lines.join('\n')}\n\nΠότε θέλετε το ταξί; (π.χ. "αύριο στις 09:00")`;
    }

    case 3: return `Πώς σας λένε;`;
    case 4: return `Ποιο είναι το τηλέφωνό σας;`;

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

      return `✅ Επιβεβαιώθηκε!\n\n🚕 **${business.name}**\n🚩 ${pickup}\n🏁 ${dest}\n📅 ${datetime}\n👤 ${name} · 📱 ${phone}\n🔖 #${b.id}\n\nΤο ταξί θα σας περιμένει! Καλό ταξίδι! 🙂`;
    }

    default: return `Χρειάζεστε άλλη διαδρομή;`;
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
      return `Γεια σας! Καλώς ήρθατε στο **${business.name}**! 🏥\n\nΣε ποια ειδικότητα χρειάζεστε ραντεβού;\n\n${specialties.map((sp, i) => `${i + 1}. ${sp}`).join('\n')}`;

    case 1:
      return `Μπορείτε να μας πείτε εν συντομία τον λόγο επίσκεψης; (προαιρετικό)`;

    case 2: {
      const slots = getAvailableSlots(business.business_id);
      const dates = [...new Set(slots.map(sl => sl.date))];
      if (!dates.length) return 'Δεν υπάρχουν διαθέσιμα ραντεβού. Καλέστε μας για εξυπηρέτηση.';
      const list = dates.map(d => {
        const dt = new Date(d + 'T00:00:00');
        return `• ${dt.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long' })} (${d})`;
      }).join('\n');
      return `Διαθέσιμες ημερομηνίες:\n\n${list}\n\nΠοια σας εξυπηρετεί;`;
    }

    case 3: {
      const dateMatch = [...um].reverse().join(' ').match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch?.[0] ?? null;
      const avail = getAvailableSlots(business.business_id, date);
      const list = avail.length
        ? avail.map(sl => `• Slot #${sl.id} — ${sl.date} στις ${sl.time}`).join('\n')
        : 'Δεν υπάρχουν ελεύθερες ώρες για αυτή την ημερομηνία.';
      return `Διαθέσιμες ώρες:\n\n${list}`;
    }

    case 4: return `Πώς σας λένε; (Ονοματεπώνυμο)`;
    case 5: return `Ποιο είναι το τηλέφωνό σας;`;
    case 6: return `Και το email σας για την επιβεβαίωση;`;

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
        return `✅ Το ραντεβού σας επιβεβαιώθηκε!\n\n🏥 ${specialty}\n📅 ${slot.date} · ${slot.time}\n👤 ${name} · 📱 ${phone}\n📧 ${email}\n🔖 #${b.id}\n\nΣας περιμένουμε!`;
      }
      const b = createBooking({ business_id: business.business_id, name, email, phone, service, date: '—', time: '—', status: 'pending' });
      return `✅ Καταχωρήθηκε!\n👤 ${name} · 📧 ${email}\n🔖 #${b.id}\n\nΘα επικοινωνήσουμε για επιβεβαίωση.`;
    }

    default: return `Μπορώ να σας βοηθήσω με νέο ραντεβού;`;
  }
}

// ── Restaurant Flow ───────────────────────────────────────────────────────────

function restaurantFlow(message, history, business) {
  const s   = step(history);
  const um  = userMsgs(history);
  const cfg = business.config;
  const maxTables   = cfg.tables ?? 10;
  const resDuration = cfg.reservation_duration ?? 90;

  switch (s) {
    case 0:
      return `Γεια σας! Καλώς ήρθατε στο **${business.name}**! 🍽️\n\nΠόσα άτομα θα είστε;`;

    case 1: {
      const today = new Date();
      const days  = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(today.getDate() + i + 1);
        return d.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long' });
      });
      return `Πότε θέλετε να κάνετε κράτηση;\n\n${days.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
    }

    case 2:
      return `Τι ώρα θα προτιμούσατε; (π.χ. "19:30", "20:00")`;

    case 3:
      return `Πώς σας λένε; (Ονοματεπώνυμο)`;

    case 4:
      return `Ποιο είναι το τηλέφωνό σας;`;

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
        service: `${guests} άτομα`,
        date: today, time, status: 'confirmed',
        notes: JSON.stringify({ guests, date: dateDesc, time: timeStr, duration_min: resDuration }),
      });

      return `✅ Η κράτησή σας επιβεβαιώθηκε!\n\n🍽️ **${business.name}**\n👥 ${guests} άτομα\n📅 ${dateDesc} · ${time}\n⏱ Διάρκεια: ~${resDuration} λεπτά\n👤 ${name} · 📱 ${phone}\n🔖 #${b.id}\n\nΣας περιμένουμε! 🥂`;
    }

    default: return `Μπορώ να σας βοηθήσω με νέα κράτηση;`;
  }
}
