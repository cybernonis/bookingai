/**
 * Distance calculation between two text addresses.
 * Uses Google Maps Distance Matrix if GOOGLE_MAPS_API_KEY is set,
 * otherwise falls back to Nominatim (OpenStreetMap) geocoding + Haversine.
 */

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=el`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BookingAI/1.0 (demo)' },
    signal: AbortSignal.timeout(6000),
  });
  const data = await res.json();
  if (!data.length) throw new Error(`Cannot geocode: ${query}`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name.split(',').slice(0, 2).join(', ') };
}

async function nominatimDistance(origin, destination) {
  // Nominatim ToS: max 1 req/sec — geocode sequentially
  const o = await geocode(origin);
  await new Promise(r => setTimeout(r, 1100));
  const d = await geocode(destination);
  const km = haversineKm(o.lat, o.lon, d.lat, d.lon);
  return {
    distance_km: km,
    distance_text: `${km.toFixed(1)} χλμ`,
    duration_text: null,
    source: 'nominatim',
    origin_label: o.label,
    dest_label: d.label,
  };
}

async function googleMapsDistance(origin, destination, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origin);
  url.searchParams.set('destinations', destination);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'el');

  const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (data.status !== 'OK') throw new Error(`Maps API: ${data.status}`);

  const el = data.rows[0]?.elements[0];
  if (el?.status !== 'OK') throw new Error(`Element status: ${el?.status}`);

  return {
    distance_km: el.distance.value / 1000,
    distance_text: el.distance.text,
    duration_text: el.duration.text,
    source: 'google',
    origin_label: data.origin_addresses[0],
    dest_label: data.destination_addresses[0],
  };
}

export async function calculateDistance(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key && key !== 'your_google_maps_api_key') {
    try {
      return await googleMapsDistance(origin, destination, key);
    } catch (err) {
      console.warn('Google Maps fallback to Nominatim:', err.message);
    }
  }
  return await nominatimDistance(origin, destination);
}
