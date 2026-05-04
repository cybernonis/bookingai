import Database from 'better-sqlite3';
import crypto from 'crypto';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'bookings.db');
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'salon',
    services    TEXT    NOT NULL DEFAULT '[]',
    hours       TEXT    NOT NULL DEFAULT '{}',
    theme_color TEXT    NOT NULL DEFAULT '#1a1a2e',
    config      TEXT    NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS slots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT    NOT NULL,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    available   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT,
    name        TEXT    NOT NULL,
    email       TEXT,
    phone       TEXT,
    service     TEXT,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id  TEXT    NOT NULL,
    username     TEXT    NOT NULL UNIQUE,
    password_hash TEXT   NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────

function addColIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

addColIfMissing('businesses', 'type',   "TEXT NOT NULL DEFAULT 'salon'");
addColIfMissing('businesses', 'config', "TEXT NOT NULL DEFAULT '{}'");
addColIfMissing('bookings',   'business_id', 'TEXT');
addColIfMissing('bookings',   'notes',       'TEXT');

// backfill existing bookings that have no business_id
db.exec("UPDATE bookings SET business_id = 'eclat' WHERE business_id IS NULL");

// ── Prepared statements ───────────────────────────────────────────────────────

const q = {
  // businesses
  bizAll:    db.prepare('SELECT * FROM businesses ORDER BY name'),
  bizById:   db.prepare('SELECT * FROM businesses WHERE business_id = ?'),
  bizUpsert: db.prepare(`
    INSERT INTO businesses (business_id, name, type, services, hours, theme_color, config)
    VALUES (@business_id, @name, @type, @services, @hours, @theme_color, @config)
    ON CONFLICT(business_id) DO UPDATE SET
      type        = excluded.type,
      config      = excluded.config,
      theme_color = excluded.theme_color
  `),
  bizCount:  db.prepare('SELECT COUNT(*) AS n FROM businesses'),

  // slots
  slotsAll:    db.prepare('SELECT * FROM slots WHERE business_id = ? AND available = 1 ORDER BY date, time'),
  slotsByDate: db.prepare('SELECT * FROM slots WHERE business_id = ? AND date = ? AND available = 1 ORDER BY time'),
  slotById:    db.prepare('SELECT * FROM slots WHERE id = ?'),
  slotMark:    db.prepare('UPDATE slots SET available = 0 WHERE id = ?'),
  slotInsert:  db.prepare('INSERT INTO slots (business_id, date, time) VALUES (@business_id, @date, @time)'),
  slotCount:   db.prepare('SELECT COUNT(*) AS n FROM slots'),

  // bookings
  bookAll:    db.prepare('SELECT * FROM bookings ORDER BY created_at DESC'),
  bookByBiz:  db.prepare('SELECT * FROM bookings WHERE business_id = ? ORDER BY created_at DESC'),
  bookById:   db.prepare('SELECT * FROM bookings WHERE id = ?'),
  bookInsert: db.prepare(`
    INSERT INTO bookings (business_id, name, email, phone, service, date, time, status, notes)
    VALUES (@business_id, @name, @email, @phone, @service, @date, @time, @status, @notes)
  `),
  bookPatch:  db.prepare('UPDATE bookings SET status = @status WHERE id = @id'),
  bookCount:  db.prepare('SELECT COUNT(*) AS n FROM bookings'),

  // admins
  adminByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
  adminByBiz:      db.prepare('SELECT * FROM admins WHERE business_id = ?'),
  adminInsert:     db.prepare('INSERT INTO admins (business_id, username, password_hash) VALUES (@business_id, @username, @password_hash)'),

  statsAll: db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(status='confirmed') AS confirmed,
      SUM(status='pending')   AS pending,
      SUM(status='cancelled') AS cancelled
    FROM bookings`),
  statsByBiz: db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(status='confirmed') AS confirmed,
      SUM(status='pending')   AS pending,
      SUM(status='cancelled') AS cancelled
    FROM bookings WHERE business_id = ?`),
};

// ── Public API ────────────────────────────────────────────────────────────────

function parseBiz(row) {
  if (!row) return null;
  return {
    ...row,
    services: JSON.parse(row.services),
    hours:    JSON.parse(row.hours),
    config:   JSON.parse(row.config || '{}'),
  };
}

export function getAllBusinesses()   { return q.bizAll.all().map(parseBiz); }
export function getBusinessById(id) { return parseBiz(q.bizById.get(id)); }

export function getAvailableSlots(businessId, date = null) {
  return date ? q.slotsByDate.all(businessId, date) : q.slotsAll.all(businessId);
}
export function getSlotById(id)         { return q.slotById.get(id); }
export function markSlotUnavailable(id) { q.slotMark.run(id); }

export function getAllBookings(businessId = null) {
  return businessId ? q.bookByBiz.all(businessId) : q.bookAll.all();
}
export function getBookingById(id) { return q.bookById.get(id); }

export function createBooking({ business_id, name, email, phone, service, date, time, status = 'pending', notes = null }) {
  const r = q.bookInsert.run({
    business_id: business_id ?? null,
    name, email: email ?? null, phone: phone ?? null,
    service: service ?? null, date, time, status,
    notes: notes ?? null,
  });
  return q.bookById.get(r.lastInsertRowid);
}

export function updateBookingStatus(id, status) {
  q.bookPatch.run({ id, status });
  return q.bookById.get(id);
}

export function getStats(businessId = null) {
  return businessId ? q.statsByBiz.get(businessId) : q.statsAll.get();
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export function seedIfEmpty() {
  // Always upsert businesses so type/config stay current
  const businesses = [
    {
      business_id: 'eclat',
      name: 'Éclat Hair Studio',
      type: 'salon',
      theme_color: '#1a1a2e',
      services: JSON.stringify([
        { name: 'Κούρεμα',         price: 25, duration: 45 },
        { name: 'Βαφή',            price: 45, duration: 90 },
        { name: 'Θεραπείες',       price: 35, duration: 60 },
        { name: 'Νυφικό Χτένισμα', price: 80, duration: 120 },
        { name: 'Μπούκλες',        price: 55, duration: 90 },
        { name: 'Styling',         price: 20, duration: 30 },
      ]),
      hours: JSON.stringify({ 'Δευτέρα': '09:00–20:00', 'Τρίτη': '09:00–20:00', 'Τετάρτη': '09:00–20:00', 'Πέμπτη': '09:00–21:00', 'Παρασκευή': '09:00–21:00', 'Σάββατο': '09:00–18:00', 'Κυριακή': null }),
      config: JSON.stringify({}),
    },
    {
      business_id: 'nails-sofia',
      name: 'Nails by Sofia',
      type: 'salon',
      theme_color: '#7c3aed',
      services: JSON.stringify([
        { name: 'Manicure',     price: 20, duration: 45 },
        { name: 'Pedicure',     price: 25, duration: 60 },
        { name: 'Gel Νυχιών',   price: 35, duration: 75 },
        { name: 'Nail Art',     price: 15, duration: 30 },
        { name: 'Αφαίρεση Gel', price: 10, duration: 20 },
      ]),
      hours: JSON.stringify({ 'Δευτέρα': '10:00–19:00', 'Τρίτη': '10:00–19:00', 'Τετάρτη': '10:00–19:00', 'Πέμπτη': '10:00–20:00', 'Παρασκευή': '10:00–20:00', 'Σάββατο': '10:00–17:00', 'Κυριακή': null }),
      config: JSON.stringify({}),
    },
    {
      business_id: 'taxi-thess',
      name: 'ΤαξίApp Θεσσαλονίκη',
      type: 'taxi',
      theme_color: '#d97706',
      services: JSON.stringify([]),
      hours: JSON.stringify({ 'Δευτέρα': '24/7', 'Τρίτη': '24/7', 'Τετάρτη': '24/7', 'Πέμπτη': '24/7', 'Παρασκευή': '24/7', 'Σάββατο': '24/7', 'Κυριακή': '24/7' }),
      config: JSON.stringify({
        base_fare:    3.50,
        price_per_km: 1.50,
        min_fare:     4.50,
        currency:     '€',
        tariff_note:  'Τιμοκατάλογος Α εντός πόλης. Νυχτερινό +20%.',
        fixed_routes: [
          { origin: 'Αεροδρόμιο Θεσσαλονίκης', destination: 'Κέντρο Θεσσαλονίκης', price: 25 },
          { origin: 'Κέντρο Θεσσαλονίκης',      destination: 'Αεροδρόμιο Θεσσαλονίκης', price: 25 },
          { origin: 'Αεροδρόμιο Θεσσαλονίκης', destination: 'Χαλκιδική', price: 45 },
        ],
      }),
    },
    {
      business_id: 'taxi-crete',
      name: 'Crete Transfers',
      type: 'taxi',
      theme_color: '#0ea5e9',
      services: JSON.stringify([]),
      hours: JSON.stringify({ 'Δευτέρα': '24/7', 'Τρίτη': '24/7', 'Τετάρτη': '24/7', 'Πέμπτη': '24/7', 'Παρασκευή': '24/7', 'Σάββατο': '24/7', 'Κυριακή': '24/7' }),
      config: JSON.stringify({
        base_fare: 2.00,
        price_per_km: 0.92,
        min_fare: 5.00,
        currency: '€',
        system_prompt: `Είσαι AI assistant για υπηρεσία ταξί και airport transfers. Στόχος σου είναι να βοηθάς τον πελάτη να κλείσει, αλλάξει ή ακυρώσει μια διαδρομή γρήγορα και ξεκάθαρα. ΚΑΝΟΝΕΣ: Μίλα απλά, φιλικά και επαγγελματικά. Κάνε ΜΙΑ ερώτηση κάθε φορά. Χρησιμοποίησε σύντομες απαντήσεις. Πάντα επιβεβαίωσε πριν ολοκληρώσεις ενέργεια. ΜΟΡΦΟΠΟΙΗΣΗ ΕΠΙΛΟΓΩΝ: Όταν δίνεις επιλογές στον πελάτη, χρησιμοποίησε ΠΑΝΤΑ αριθμημένη λίστα, μία επιλογή ανά γραμμή, π.χ.:\n1. Economy\n2. Van\n3. VIP\nΓια ερωτήσεις επιβεβαίωσης χρησιμοποίησε πάντα (Ναι/Όχι) στο τέλος της ερώτησης. BOOKING FLOW: 1)Ζήτα pickup location 2)Ζήτα προορισμό 3)Ζήτα ημερομηνία και ώρα 4)Ζήτα αριθμό επιβατών - αν >4 πρότεινε VAN 5)Τύπος οχήματος: Economy, Van, VIP 6)Extras: παιδικό κάθισμα, επιπλέον αποσκευές, κατοικίδιο 7)Υπολόγισε τιμή 8)Δείξε σύνοψη 9)Ζήτα επιβεβαίωση (Ναι/Όχι) 10)Ζήτα όνομα 11)Ζήτα τηλέφωνο 12)Στείλε επιβεβαίωση. ΑΡΙΘΜΟΣ ΚΡΑΤΗΣΗΣ — ΚΡΙΣΙΜΟ: ΠΟΤΕ μην γράψεις αριθμό κράτησης μόνος σου (π.χ. CRT-xxx, TXI-xxx ή οποιοδήποτε άλλο format). Ο αριθμός κράτησης παράγεται ΜΟΝΟ από το σύστημα. Μόλις έχεις ΟΛΑ: pickup, destination, datetime, vehicle, price, name ΚΑΙ phone, γράψε ΑΚΡΙΒΩΣ αυτή τη γραμμή στο τέλος του μηνύματός σου (μία φορά, χωρίς κενά):\nCONFIRMED_BOOKING:{name}|{phone}|{pickup}|{destination}|{datetime}|{vehicle}|{price}\nΤο σύστημα θα την αντικαταστήσει αυτόματα με τον πραγματικό αριθμό κράτησης.\n\nΕΤΑΙΡΕΙΑ: Crete Transfers — 24/7 taxi & airport transfers σε όλη την Κρήτη.\nΤΙΜΟΚΑΤΑΛΟΓΟΣ: €2.00 εκκίνηση + €0.92/χλμ (ελάχιστο €5.00). Νυχτερινό (00:00–05:00) +30%.\nΣΤΑΘΕΡΕΣ ΤΙΜΕΣ ΑΕΡΟΔΡΟΜΙΟΥ:\n• Αεροδρόμιο Ηρακλείου ↔ Ηράκλειο Κέντρο: €15\n• Αεροδρόμιο Ηρακλείου → Ρέθυμνο: €55\n• Αεροδρόμιο Ηρακλείου → Χανιά: €95\n• Αεροδρόμιο Χανίων ↔ Χανιά Κέντρο: €12\n• Αεροδρόμιο Χανίων → Ρέθυμνο: €40\nΤΥΠΟΙ ΟΧΗΜΑΤΩΝ: Economy/Standard (1-4 άτομα), Van (5-8 άτομα, +€10), VIP/Mercedes (1-4 άτομα, +50%)\nEXTRAS: Παιδικό κάθισμα +€5, Επιπλέον αποσκευή +€3/τεμ., Κατοικίδιο +€5`,
      }),
    },
    {
      business_id: 'clinic-demo',
      name: 'MediCare Κλινική',
      type: 'clinic',
      theme_color: '#0891b2',
      services: JSON.stringify([
        { name: 'Παθολόγος',    price: 50 },
        { name: 'Καρδιολόγος',  price: 80 },
        { name: 'Δερματολόγος', price: 60 },
        { name: 'Ορθοπεδικός',  price: 70 },
      ]),
      hours: JSON.stringify({ 'Δευτέρα': '08:00–20:00', 'Τρίτη': '08:00–20:00', 'Τετάρτη': '08:00–20:00', 'Πέμπτη': '08:00–20:00', 'Παρασκευή': '08:00–18:00', 'Σάββατο': '09:00–14:00', 'Κυριακή': null }),
      config: JSON.stringify({
        specialties: ['Παθολόγος', 'Καρδιολόγος', 'Δερματολόγος', 'Ορθοπεδικός'],
      }),
    },
  ];
  businesses.forEach(b => q.bizUpsert.run(b));

  // Slots — only seed once
  if (q.slotCount.get().n === 0) {
    const DATES = ['2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14'];
    const slotDefs = [
      { business_id: 'eclat',       times: ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'] },
      { business_id: 'nails-sofia', times: ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'] },
      { business_id: 'clinic-demo', times: ['08:30', '09:00', '09:30', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00'] },
      // taxi has no slots — on-demand
    ];
    slotDefs.forEach(({ business_id, times }) => {
      DATES.forEach(date => times.forEach(time => q.slotInsert.run({ business_id, date, time })));
    });
  }

  // Demo bookings — only seed once
  if (q.bookCount.get().n === 0) {
    const seeds = [
      { business_id: 'eclat',        name: 'Μαρία Παπαδοπούλου', email: 'maria@example.com',   phone: '6971234567', service: 'Βαφή',            date: '2026-05-10', time: '10:00', status: 'confirmed', notes: null },
      { business_id: 'eclat',        name: 'Γιώργος Νικολάου',   email: 'giorgos@example.com', phone: '6982345678', service: 'Κούρεμα',         date: '2026-05-10', time: '11:00', status: 'pending',   notes: null },
      { business_id: 'nails-sofia',  name: 'Σοφία Δημητρίου',    email: 'sofia@example.com',   phone: '6904567890', service: 'Gel Νυχιών',      date: '2026-05-10', time: '11:00', status: 'confirmed', notes: null },
      { business_id: 'taxi-thess',   name: 'Νίκος Αλεξίου',      email: null,                  phone: '6915678901', service: 'Κέντρο → ΑΠΘ',   date: '2026-05-10', time: '09:00', status: 'confirmed', notes: JSON.stringify({ pickup: 'Πλατεία Αριστοτέλους', destination: 'ΑΠΘ', datetime: '10 Μαΐου 09:00' }) },
      { business_id: 'clinic-demo',  name: 'Ελένη Κωστοπούλου',  email: 'eleni@example.com',   phone: '6993456789', service: 'Καρδιολόγος',    date: '2026-05-11', time: '10:00', status: 'pending',   notes: null },
    ];
    seeds.forEach(s => q.bookInsert.run(s));
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setupNewBusiness({ business_id, name, type, services, hours, theme_color, config }) {
  q.bizUpsert.run({
    business_id, name, type,
    services: JSON.stringify(services || []),
    hours:    JSON.stringify(hours    || {}),
    theme_color: theme_color || '#1a1a2e',
    config:   JSON.stringify(config   || {}),
  });

  // Generate default slots for next 14 days (not for on-demand types)
  if (!['taxi', 'restaurant'].includes(type)) {
    const defaultTimes = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];
    for (let i = 1; i <= 14; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      if (d.getDay() === 0) continue; // skip Sundays
      const date = d.toISOString().split('T')[0];
      defaultTimes.forEach(time => q.slotInsert.run({ business_id, date, time }));
    }
  }
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(plain, salt, 100_000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(plain, salt, 100_000, 64, 'sha512').toString('hex');
  return check === hash;
}

export function getAdminByUsername(username) { return q.adminByUsername.get(username); }
export function getAdminByBusinessId(bizId)  { return q.adminByBiz.get(bizId); }

export function createAdmin(business_id, username, plainPassword) {
  const password_hash = hashPassword(plainPassword);
  q.adminInsert.run({ business_id, username, password_hash });
  return q.adminByUsername.get(username);
}

export default db;
