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
  setupNewBusiness, updateBusinessConfig,
} from './db.js';
import { getBookingReply, applySettingsCommand } from './flows.js';

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

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, history, businessId = 'eclat' } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const business = getBusinessById(businessId);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const safeHistory = Array.isArray(history) ? history : [];
  const messages = [...safeHistory, { role: 'user', content: message }];
  try {
    const reply = await getBookingReply(message, safeHistory, business);
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
  res.json({ business: biz });
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
  res.json({ business: biz });
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
  res.json({ business: biz });
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
  res.json({ business: biz });
});

app.post('/api/admin/business/:id/ai-settings', requireAdmin, async (req, res) => {
  const bizId = req.params.id;
  if (req.session.businessId && req.session.businessId !== bizId)
    return res.status(403).json({ error: 'Forbidden' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const biz = getBusinessById(bizId);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  try {
    const result = await applySettingsCommand(message, biz);
    if (result.patch) updateBusinessConfig(bizId, result.patch);
    const updated = getBusinessById(bizId);
    res.json({ message: result.message, business: updated });
  } catch (err) {
    console.error('AI settings error:', err);
    res.status(500).json({ error: 'Σφάλμα επεξεργασίας.' });
  }
});

// ── Setup wizard ──────────────────────────────────────────────────────────────

app.get('/setup', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'setup.html')));

app.post('/api/setup', (req, res) => {
  const { type, name, phone, address, theme_color, services, config, admin_username, admin_password } = req.body;

  if (!name || !admin_username || !admin_password)
    return res.status(400).json({ error: 'name, admin_username and admin_password are required' });

  const business_id = name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40) + '-' + Date.now().toString(36);

  if (type === 'taxi' && config && !config.system_prompt) {
    config.system_prompt = `Είσαι AI assistant για υπηρεσία ταξί και μεταφορές "${name}". Βοήθα τον πελάτη να κλείσει, αλλάξει ή ακυρώσει διαδρομή γρήγορα. ΚΑΝΟΝΕΣ: Μίλα απλά, φιλικά, επαγγελματικά. Κάνε ΜΙΑ ερώτηση κάθε φορά. ΜΟΡΦΟΠΟΙΗΣΗ: Επιλογές ως αριθμημένη λίστα. Επιβεβαίωση με (Ναι/Όχι). BOOKING FLOW: 1)Pickup 2)Προορισμός 3)Ημερομηνία+ώρα 4)Επιβάτες 5)Όχημα βάσει λίστας 6)Two-way & Extras σύμφωνα με τιμολόγιο 7)Υπολόγισε τιμή βάσει τιμολογίου 8)Σύνοψη 9)Επιβεβαίωση (Ναι/Όχι) 10)Όνομα 11)Τηλέφωνο 12)Email για επιβεβαίωση (αν δεν θέλει πες "skip") 13)Αποστολή. ΑΡΙΘΜΟΣ ΚΡΑΤΗΣΗΣ: ΠΟΤΕ μην γράψεις αριθμό μόνος σου. Μόλις έχεις ΟΛΑ τα στοιχεία γράψε ΑΚΡΙΒΩΣ:
CONFIRMED_BOOKING:{name}|{phone}|{email}|{pickup}|{destination}|{datetime}|{vehicle}|{price}

ΕΤΑΙΡΕΙΑ: ${name} — υπηρεσίες μεταφοράς 24/7.`;
  }

  try {
    setupNewBusiness({
      business_id,
      name,
      type: type || 'salon',
      services: services || [],
      hours: {},
      theme_color: theme_color || '#1a1a2e',
      config: { ...config, phone: phone || null, address: address || null },
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

// ── Version check ─────────────────────────────────────────────────────────────

app.get('/api/version', (_req, res) => res.json({ version: 'pricing-zones-v1', routes: ['ai-settings','pricing-zones'] }));

// ── Public pages ──────────────────────────────────────────────────────────────

app.get('/dashboard', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () =>
  console.log(`BookingAI server listening on http://localhost:${PORT}`));
