import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getAllBusinesses, getBusinessById,
  getAvailableSlots, getSlotById, markSlotUnavailable,
  getAllBookings, getBookingById, createBooking,
  updateBookingStatus, getStats, seedIfEmpty,
  getAdminByUsername, createAdmin, verifyPassword,
  setupNewBusiness, updateBusinessConfig, replaceBusinessConfig, updateBusinessMeta,
  createAiHistoryEntry, finalizeAiHistoryEntry, getAiHistory, getAiHistoryEntry, setAiHistoryStatus,
} from './db.js';
import { getBookingReply, applySettingsCommand, detectConflicts } from './flows.js';
import { sendEmailDirect } from './email.js';
import { sendSmsDirect }   from './sms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const isProd = process.env.NODE_ENV === 'production';
if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bookingai-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000, secure: isProd },
}));
app.use(express.static(join(__dirname, 'public')));

seedIfEmpty();

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/admin/login');
}

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get('/admin', (_req, res) => res.redirect('/admin/login'));

app.get('/admin/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin/dashboard');
  res.sendFile(join(__dirname, 'views', 'admin-login.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  // Super-admin via env vars
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.admin      = true;
    req.session.username   = username;
    req.session.businessId = null; // super-admin sees all
    return res.redirect('/admin/dashboard');
  }

  // Per-business admin via DB
  const admin = getAdminByUsername(username);
  if (admin && verifyPassword(password, admin.password_hash)) {
    req.session.admin      = true;
    req.session.username   = username;
    req.session.businessId = admin.business_id;
    return res.redirect('/admin/dashboard');
  }

  res.redirect('/admin/login?error=1');
});

app.get('/admin/dashboard', requireAdmin, (_req, res) =>
  res.sendFile(join(__dirname, 'views', 'admin-dashboard.html')));

app.post('/admin/logout', (req, res) =>
  req.session.destroy(() => res.redirect('/admin/login')));

// ── Business API (public) ─────────────────────────────────────────────────────

app.get('/api/businesses', (_req, res) =>
  res.json({ businesses: getAllBusinesses() }));

app.get('/api/business/:businessId', (req, res) => {
  const biz = getBusinessById(req.params.businessId);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  res.json(biz);
});

app.get('/api/business/:businessId/slots', (req, res) => {
  const { date } = req.query;
  res.json({ slots: getAvailableSlots(req.params.businessId, date || null) });
});

// ── Bookings API ──────────────────────────────────────────────────────────────

app.get('/api/bookings', (req, res) => {
  const { businessId } = req.query;
  res.json({ bookings: getAllBookings(businessId || null) });
});

app.get('/api/bookings/stats', (req, res) => {
  const { businessId } = req.query;
  res.json(getStats(businessId || null));
});

app.get('/api/bookings/:id', (req, res) => {
  const b = getBookingById(parseInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json({ booking: b });
});

app.post('/api/bookings', (req, res) => {
  const { business_id, name, email, phone, service, slotId, date, time } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  let bookingDate = date, bookingTime = time;
  if (slotId) {
    const slot = getSlotById(slotId);
    if (!slot)           return res.status(404).json({ error: 'Slot not found' });
    if (!slot.available) return res.status(409).json({ error: 'Slot not available' });
    markSlotUnavailable(slot.id);
    bookingDate = slot.date;
    bookingTime = slot.time;
  }
  if (!bookingDate || !bookingTime) return res.status(400).json({ error: 'date and time are required' });

  const booking = createBooking({ business_id, name, email, phone, service, date: bookingDate, time: bookingTime, status: 'confirmed' });
  res.status(201).json({ booking });
});

app.patch('/api/bookings/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'pending'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  const booking = getBookingById(id);
  if (!booking) return res.status(404).json({ error: 'Not found' });
  res.json({ booking: updateBookingStatus(id, status) });
});

// ── Places Autocomplete (proxies Google Places, keeps key server-side) ───────

app.get('/api/places/autocomplete', async (req, res) => {
  const { input } = req.query;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !input?.trim()) return res.json({ suggestions: [] });
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await r.json();
    const suggestions = (data.suggestions || []).slice(0, 5).map(s => ({
      text: s.placePrediction?.text?.text || s.queryPrediction?.text?.text || '',
    })).filter(s => s.text);
    res.json({ suggestions });
  } catch {
    res.json({ suggestions: [] });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, history, businessId = 'eclat', lang } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const business = getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const safeHistory = Array.isArray(history) ? history : [];
  const messages = [...safeHistory, { role: 'user', content: message }];
  try {
    const reply = await getBookingReply(message, safeHistory, business, { lang: lang || null });
    messages.push({ role: 'assistant', content: reply });
    res.json({ reply, history: messages });
  } catch (err) {
    console.error('Flow error:', err?.message || err);
    console.error('Stack:', err?.stack);
    console.error('Message:', message, 'HistoryLen:', safeHistory.length);
    res.status(500).json({ error: 'Σφάλμα επεξεργασίας. Δοκίμασε ξανά.' });
  }
});

// ── Admin: zones & pricing ────────────────────────────────────────────────────

app.patch('/api/admin/business/:id/pricing', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const { pricing } = req.body;
  if (!pricing || typeof pricing !== 'object')
    return res.status(400).json({ error: 'pricing object required' });
  const biz = updateBusinessConfig(bizId, { pricing });
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  clearAiMeta(bizId, 'pricing');
  res.json({ business: getBusinessById(bizId) });
});

app.patch('/api/admin/business/:id/zones', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const { zones } = req.body;
  if (!zones || typeof zones !== 'object')
    return res.status(400).json({ error: 'zones object required' });
  const biz = updateBusinessConfig(bizId, { zones });
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  clearAiMeta(bizId, 'zones');
  res.json({ business: getBusinessById(bizId) });
});

app.patch('/api/admin/business/:id/vehicles', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const { vehicles } = req.body;
  if (!Array.isArray(vehicles))
    return res.status(400).json({ error: 'vehicles array required' });
  const biz = updateBusinessConfig(bizId, { vehicles });
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  clearAiMeta(bizId, 'vehicles');
  res.json({ business: getBusinessById(bizId) });
});

app.patch('/api/admin/business/:id/pricing-zones', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const { pricing_zones } = req.body;
  if (!Array.isArray(pricing_zones))
    return res.status(400).json({ error: 'pricing_zones array required' });
  const biz = updateBusinessConfig(bizId, { pricing_zones });
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  clearAiMeta(bizId, 'pricing_zones');
  res.json({ business: getBusinessById(bizId) });
});

app.patch('/api/admin/business/:id/app-settings', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });

  const { name, theme_color, config } = req.body;
  let biz;

  if (name !== undefined || theme_color !== undefined) {
    biz = updateBusinessMeta(bizId, { name, theme_color });
    if (!biz) return res.status(404).json({ error: 'Business not found' });
  }

  if (config && typeof config === 'object') {
    biz = updateBusinessConfig(bizId, config);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
  }

  if (!biz) {
    biz = getBusinessById(bizId);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
  }

  res.json({ business: biz });
});

function safeMergeFixedRoutes(currentRoutes, patchRoutes, command) {
  if (!Array.isArray(patchRoutes)) return currentRoutes;
  const cmdLower = command.toLowerCase();
  const norm = s => s.toLowerCase().replace(/[.,\-–→]/g, ' ').replace(/\s+/g, ' ').trim();
  const isMentioned = route => {
    const words = [...norm(route.origin).split(' '), ...norm(route.destination).split(' ')];
    return words.some(w => w.length >= 4 && cmdLower.includes(w));
  };
  const currentMap = new Map();
  for (const r of currentRoutes) currentMap.set(norm(r.origin) + '|' + norm(r.destination), r);

  const result = [];
  const seenKeys = new Set();
  for (const pr of patchRoutes) {
    const key = norm(pr.origin) + '|' + norm(pr.destination);
    seenKeys.add(key);
    const existing = currentMap.get(key);
    if (!existing) {
      result.push(pr); // new route
    } else if (Math.abs(Number(existing.price) - Number(pr.price)) > 0.001) {
      // price changed — only accept if this route is mentioned in the command
      result.push(isMentioned(pr) ? pr : existing);
    } else {
      result.push(pr);
    }
  }
  // restore routes Claude omitted unless they appear to be intentional deletes
  for (const [key, r] of currentMap) {
    if (!seenKeys.has(key) && !isMentioned(r)) result.push(r);
  }
  return result;
}

function detectAiCategory(patch) {
  if (!patch) return 'general';
  const keys = Object.keys(patch);
  if (keys.includes('pricing_zones')) return 'pricing_zones';
  if (keys.includes('pricing'))       return 'pricing';
  if (keys.includes('zones'))         return 'zones';
  if (keys.includes('vehicles'))      return 'vehicles';
  return 'general';
}

function setAiMeta(bizId, category, cmd) {
  const biz = getBusinessById(bizId);
  if (!biz) return;
  const meta = { ...(biz.config._ai_meta || {}) };
  meta[category] = { cmd, at: new Date().toISOString() };
  updateBusinessConfig(bizId, { _ai_meta: meta });
}

function clearAiMeta(bizId, category) {
  const biz = getBusinessById(bizId);
  if (!biz || !biz.config._ai_meta?.[category]) return;
  const meta = { ...biz.config._ai_meta };
  delete meta[category];
  updateBusinessConfig(bizId, { _ai_meta: meta });
}

app.post('/api/admin/business/:id/ai-settings', requireAdmin, async (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });

  const { message, confirm_zone } = req.body;

  // Confirmation path: save a pending geographic zone without another Claude call
  if (confirm_zone && typeof confirm_zone === 'object') {
    const biz = getBusinessById(bizId);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const snapshotBefore = { ...biz.config };
    const existingZones = Array.isArray(biz.config?.pricing_zones) ? biz.config.pricing_zones : [];
    updateBusinessConfig(bizId, { pricing_zones: [...existingZones, confirm_zone] });
    const s = confirm_zone.surcharge_type, v = confirm_zone.surcharge_value;
    const label = s === 'pct' ? `+${v}%` : s === 'fixed' ? `+€${v}` : `×${v}`;
    const summary = `Ζώνη "${confirm_zone.name}" (${label}) — ${confirm_zone.keywords?.length || 0} τοποθεσίες`;
    const cmd = `Confirm zone: ${confirm_zone.name}`;
    const histId = createAiHistoryEntry({ business_id: bizId, command: cmd, summary, category: 'pricing_zones', snapshot_before: snapshotBefore });
    finalizeAiHistoryEntry(histId, getBusinessById(bizId).config);
    setAiMeta(bizId, 'pricing_zones', cmd);
    return res.json({ message: `✅ ${summary}`, business: getBusinessById(bizId) });
  }

  if (!message) return res.status(400).json({ error: 'message required' });
  const biz = getBusinessById(bizId);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  try {
    const snapshotBefore = { ...biz.config };
    const result = await applySettingsCommand(message, biz);
    // result.message = English (for DB/logs), result.reply = admin's language (for display)
    const englishSummary = result.message || '';
    let displayReply     = result.reply || englishSummary;
    let saved = false;

    if (result.patch && !result.pending_zone) {
      // Conflict detection — warn admin before applying
      const conflicts = detectConflicts(biz.config, result.patch);
      if (conflicts.length > 0) {
        displayReply += '\n\n⚠️ **Προσοχή:**\n' + conflicts.map(c => `• ${c}`).join('\n');
      }

      // Deep-merge nested objects so a partial patch never wipes sibling fields
      const DEEP_MERGE_KEYS = ['pricing', 'zones', 'widget_lang', 'region'];
      for (const key of DEEP_MERGE_KEYS) {
        if (result.patch[key] && typeof result.patch[key] === 'object' && !Array.isArray(result.patch[key])) {
          result.patch[key] = { ...(biz.config[key] || {}), ...result.patch[key] };
        }
      }
      // Protect fixed routes from collateral changes
      if (Array.isArray(result.patch.pricing?.fixed_routes)) {
        const currentRoutes = biz.config?.pricing?.fixed_routes || [];
        result.patch.pricing.fixed_routes = safeMergeFixedRoutes(currentRoutes, result.patch.pricing.fixed_routes, message);
      }
      const category = detectAiCategory(result.patch);
      console.log(`[AI-SAVE] bizId=${bizId} category=${category} keys=${Object.keys(result.patch).join(',')} summary="${englishSummary}"`);
      updateBusinessConfig(bizId, result.patch);
      saved = true;
      const snapshotAfter = { ...getBusinessById(bizId).config };
      const histId = createAiHistoryEntry({ business_id: bizId, command: message, summary: englishSummary, category, snapshot_before: snapshotBefore });
      finalizeAiHistoryEntry(histId, snapshotAfter);
      setAiMeta(bizId, category, message);
    } else if (!result.pending_zone) {
      const isInfo    = /^INFO:/i.test(englishSummary);
      const isCannot  = /^CANNOT:/i.test(englishSummary);
      console.log(`[AI-NOSAVE] bizId=${bizId} type=${isInfo?'info':isCannot?'cannot':'unsaved'} summary="${englishSummary.slice(0, 80)}"`);
      if (isCannot) {
        displayReply = `❌ ${displayReply}`;
      } else if (!isInfo) {
        // Modification command that returned no patch — flag it clearly
        displayReply = `❌ Δεν εφαρμόστηκε — ${displayReply}`;
      }
    }
    const updated = getBusinessById(bizId);
    res.json({ message: displayReply, saved, pending_zone: result.pending_zone || null, business: updated });
  } catch (err) {
    console.error('AI settings error:', err);
    res.status(500).json({ error: 'Σφάλμα επεξεργασίας.' });
  }
});

app.get('/api/admin/business/:id/ai-history', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  res.json({ history: getAiHistory(bizId) });
});

app.post('/api/admin/business/:id/ai-revert/:historyId', requireAdmin, (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const entry = getAiHistoryEntry(parseInt(req.params.historyId));
  if (!entry || entry.business_id !== bizId)
    return res.status(404).json({ error: 'Δεν βρέθηκε η καταχώριση' });
  if (!entry.snapshot_before)
    return res.status(400).json({ error: 'Δεν υπάρχει snapshot για αναίρεση' });
  if (entry.status === 'reverted')
    return res.status(400).json({ error: 'Έχει ήδη αναιρεθεί' });
  if (!getBusinessById(bizId))
    return res.status(404).json({ error: 'Business not found' });
  replaceBusinessConfig(bizId, entry.snapshot_before);
  setAiHistoryStatus(entry.id, 'reverted');
  res.json({ message: '↩️ Αναίρεση επιτυχής', business: getBusinessById(bizId) });
});

// ── Setup wizard ──────────────────────────────────────────────────────────────

app.get('/setup', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'setup.html')));

app.post('/api/setup/test-email', async (req, res) => {
  const { to, provider, creds } = req.body;
  if (!to?.includes('@')) return res.status(400).json({ error: 'Invalid email address' });
  if (!provider || provider === 'none') return res.status(400).json({ error: 'No provider selected' });
  try {
    await sendEmailDirect({
      to,
      subject: 'BooklyAI — Test Email',
      html: '<p style="font-family:sans-serif;font-size:15px">Test email from BooklyAI setup wizard. If you see this, your email provider is configured correctly!</p>',
      providerConfig: { provider, creds },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post('/api/setup/test-sms', async (req, res) => {
  const { to, provider, creds } = req.body;
  if (!to) return res.status(400).json({ error: 'Phone number required' });
  if (!provider || provider === 'none') return res.status(400).json({ error: 'No provider selected' });
  try {
    await sendSmsDirect({
      to,
      text: 'BooklyAI test SMS - setup OK!',
      providerConfig: { provider, creds },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.post('/api/setup', (req, res) => {
  const { name, phone, address, theme_color, config, admin_username, admin_password } = req.body;

  if (!name || !config?.email || !admin_username || !admin_password)
    return res.status(400).json({ error: 'name, email, admin_username and admin_password are required' });

  const business_id = name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40) + '-' + Date.now().toString(36);

  if (config && !config.system_prompt) {
    const LANG_NAMES = { el:'Ελληνικά', en:'English', fr:'Français', de:'Deutsch', it:'Italiano', es:'Español', ru:'Русский' };

    const r = config.region;
    const regionDesc = r
      ? r.country === 'greece' ? `Ελλάδα${r.prefecture ? ` (${r.prefecture})` : ''}`
        : r.country === 'cyprus' ? 'Κύπρος'
        : r.custom || 'Άλλη χώρα'
      : 'Ελλάδα';

    let langInstruction = '';
    const wl = config.widget_lang;
    if (wl?.mode === 'single' && wl.lang) {
      langInstruction = `\nΓΛΩΣΣΑ: Απάντα ΠΑΝΤΑ στα ${LANG_NAMES[wl.lang] || wl.lang}. Μην αλλάζεις γλώσσα.`;
    } else if (wl?.mode === 'multi') {
      const list = (wl.langs || ['el', 'en']).map(l => LANG_NAMES[l] || l).join(', ');
      langInstruction = `\nΓΛΩΣΣΑ: Υποστηριζόμενες γλώσσες: ${list}. Απάντα στη γλώσσα που σου δηλώνεται ανά συνεδρία.`;
    }

    config.system_prompt = `Είσαι AI assistant για υπηρεσία ταξί και μεταφορές "${name}". Βοήθα τον πελάτη να κλείσει, αλλάξει ή ακυρώσει διαδρομή γρήγορα. ΚΑΝΟΝΕΣ: Μίλα απλά, φιλικά, επαγγελματικά. Κάνε ΜΙΑ ερώτηση κάθε φορά. ΜΟΡΦΟΠΟΙΗΣΗ: Επιλογές ως αριθμημένη λίστα. Επιβεβαίωση με (Ναι/Όχι). BOOKING FLOW: 1)Pickup 2)Προορισμός 3)Ημερομηνία+ώρα 4)Επιβάτες 5)Όχημα βάσει λίστας 6)Two-way & Extras σύμφωνα με τιμολόγιο 7)Υπολόγισε τιμή βάσει τιμολογίου 8)Σύνοψη 9)Επιβεβαίωση (Ναι/Όχι) 10)Όνομα 11)Τηλέφωνο 12)Email για επιβεβαίωση (αν δεν θέλει πες "skip") 13)Αποστολή. ΑΡΙΘΜΟΣ ΚΡΑΤΗΣΗΣ: ΠΟΤΕ μην γράψεις αριθμό μόνος σου. Μόλις έχεις ΟΛΑ τα στοιχεία γράψε ΑΚΡΙΒΩΣ:
CONFIRMED_BOOKING:{name}|{phone}|{email}|{pickup}|{destination}|{datetime}|{vehicle}|{price}${langInstruction}

ΕΤΑΙΡΕΙΑ: ${name} — υπηρεσίες μεταφοράς 24/7. ΠΕΡΙΟΧΗ ΔΡΑΣΤΗΡΙΟΤΗΤΑΣ: ${regionDesc}.`;
  }

  try {
    setupNewBusiness({
      business_id,
      name,
      type: 'taxi',
      services: [],
      hours: {},
      theme_color: theme_color || '#1a1a2e',
      config: { phone: phone || null, address: address || null, ...config },
    });

    createAdmin(business_id, admin_username, admin_password);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: admins.username'))
      return res.status(409).json({ error: 'Το username χρησιμοποιείται ήδη. Επέλεξε άλλο.' });
    console.error('Setup error:', err);
    return res.status(500).json({ error: 'Σφάλμα κατά τη δημιουργία.' });
  }

  const base  = `${req.protocol}://${req.get('host')}`;
  const embed = `<script src="${base}/booking-widget.js"\n        data-api-url="${base}"\n        data-business-id="${business_id}"></script>`;

  res.status(201).json({ business_id, embed });
});

// ── Public pages ──────────────────────────────────────────────────────────────

app.get('/dashboard', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () =>
  console.log(`BookingAI server listening on http://localhost:${PORT}`));
