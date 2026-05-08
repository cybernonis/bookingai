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

// make email nullable (SQLite requires table recreation to drop NOT NULL)
(function migrateEmailNullable() {
  const emailCol = db.prepare('PRAGMA table_info(bookings)').all().find(c => c.name === 'email');
  if (emailCol && emailCol.notnull === 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE bookings_new (
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
      INSERT INTO bookings_new (id, business_id, name, email, phone, service, date, time, status, notes, created_at)
        SELECT id, business_id, name, email, phone, service, date, time, status, notes, created_at FROM bookings;
      DROP TABLE bookings;
      ALTER TABLE bookings_new RENAME TO bookings;
      COMMIT;
    `);
    console.log('Migration: email column is now nullable');
  }
})();

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
      theme_color = excluded.theme_color,
      config      = excluded.config
  `),
  bizCount:      db.prepare('SELECT COUNT(*) AS n FROM businesses'),
  bizPatchConfig: db.prepare('UPDATE businesses SET config = ? WHERE business_id = ?'),

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

export function updateBusinessConfig(businessId, patch) {
  const row = q.bizById.get(businessId);
  if (!row) return null;
  const merged = { ...JSON.parse(row.config || '{}'), ...patch };
  q.bizPatchConfig.run(JSON.stringify(merged), businessId);
  return parseBiz(q.bizById.get(businessId));
}

export function updateBusinessMeta(businessId, { name, theme_color } = {}) {
  const row = q.bizById.get(businessId);
  if (!row) return null;
  const fields = [], params = [];
  if (name !== undefined)        { fields.push('name = ?');        params.push(name); }
  if (theme_color !== undefined) { fields.push('theme_color = ?'); params.push(theme_color); }
  if (fields.length) {
    params.push(businessId);
    db.prepare(`UPDATE businesses SET ${fields.join(', ')} WHERE business_id = ?`).run(...params);
  }
  return parseBiz(q.bizById.get(businessId));
}

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
      business_id: 'taxi-crete',
      name: 'Crete Transfers',
      type: 'taxi',
      theme_color: '#0ea5e9',
      services: JSON.stringify([]),
      hours: JSON.stringify({ 'Δευτέρα': '24/7', 'Τρίτη': '24/7', 'Τετάρτη': '24/7', 'Πέμπτη': '24/7', 'Παρασκευή': '24/7', 'Σάββατο': '24/7', 'Κυριακή': '24/7' }),
      config: JSON.stringify({
        zones: {
          mode: 'whitelist',
          areas: ['Κρήτη', 'Αεροδρόμιο Ηρακλείου', 'Αεροδρόμιο Χανίων', 'Ηράκλειο', 'Χανιά', 'Ρέθυμνο', 'Αγ. Νικόλαος', 'Ιεράπετρα', 'Σητεία', 'Μάλια', 'Ελούντα', 'Ανώγεια'],
          intra_zone: false,
        },
        pricing: {
          mode: 'combined',
          base_fare: 2.00,
          price_per_km: 0.92,
          min_fare: 5.00,
          currency: '€',
          rounding: 2,
          two_way_enabled: true,
          two_way_discount_pct: 10,
          night_surcharge_enabled: true,
          night_surcharge_pct: 20,
          night_from: '22:00',
          night_to: '06:00',
          extras: { child_seat: 5, extra_luggage: 3, pet: 5 },
          fixed_routes: [
            { origin: 'Αεροδρόμιο Ηρακλείου', destination: 'Ηράκλειο Κέντρο', price: 15 },
            { origin: 'Αεροδρόμιο Ηρακλείου', destination: 'Ρέθυμνο', price: 55 },
            { origin: 'Αεροδρόμιο Ηρακλείου', destination: 'Χανιά', price: 95 },
            { origin: 'Αεροδρόμιο Χανίων', destination: 'Χανιά Κέντρο', price: 12 },
            { origin: 'Αεροδρόμιο Χανίων', destination: 'Ρέθυμνο', price: 40 },
          ],
        },
        vehicles: [
          { id: 'economy', label: 'Economy',      icon: '🚗', capacity: '1-4', surcharge_type: 'none',  surcharge_value: 0,  enabled: true },
          { id: 'van',     label: 'Van',           icon: '🚐', capacity: '5-8', surcharge_type: 'fixed', surcharge_value: 10, enabled: true },
          { id: 'vip',     label: 'VIP/Mercedes',  icon: '🚘', capacity: '1-4', surcharge_type: 'pct',   surcharge_value: 50, enabled: true },
        ],
        system_prompt: `Είσαι AI assistant για υπηρεσία ταξί και airport transfers. Βοήθα τον πελάτη να κλείσει, αλλάξει ή ακυρώσει διαδρομή γρήγορα. ΚΑΝΟΝΕΣ: Μίλα απλά, φιλικά, επαγγελματικά. Κάνε ΜΙΑ ερώτηση κάθε φορά. ΜΟΡΦΟΠΟΙΗΣΗ: Επιλογές ως αριθμημένη λίστα. Επιβεβαίωση με (Ναι/Όχι). BOOKING FLOW: 1)Pickup 2)Προορισμός 3)Ημερομηνία+ώρα 4)Επιβάτες 5)Όχημα βάσει λίστας 6)Two-way & Extras σύμφωνα με τιμολόγιο 7)Υπολόγισε τιμή βάσει τιμολογίου 8)Σύνοψη 9)Επιβεβαίωση (Ναι/Όχι) 10)Όνομα 11)Τηλέφωνο 12)Email για επιβεβαίωση (αν δεν θέλει πες "skip") 13)Αποστολή. ΑΡΙΘΜΟΣ ΚΡΑΤΗΣΗΣ: ΠΟΤΕ μην γράψεις αριθμό μόνος σου. Μόλις έχεις ΟΛΑ τα στοιχεία γράψε ΑΚΡΙΒΩΣ:
CONFIRMED_BOOKING:{name}|{phone}|{email}|{pickup}|{destination}|{datetime}|{vehicle}|{price}

ΕΤΑΙΡΕΙΑ: Crete Transfers — 24/7 transfers σε όλη την Κρήτη.`,
      }),
    },
  ];
  businesses.forEach(b => {
    const existing = q.bizById.get(b.business_id);
    if (existing) {
      const cur = JSON.parse(existing.config || '{}');
      const seed = JSON.parse(b.config);
      // Preserve admin-set fields; update code-owned fields (system_prompt, etc.)
      const merged = { ...seed };
      if (cur.zones    !== undefined) merged.zones    = cur.zones;
      if (cur.pricing  !== undefined) merged.pricing  = cur.pricing;
      if (cur.vehicles !== undefined) merged.vehicles = cur.vehicles;
      q.bizUpsert.run({ ...b, config: JSON.stringify(merged) });
    } else {
      q.bizUpsert.run(b);
    }
  });

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
