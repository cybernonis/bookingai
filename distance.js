/**
 * Distance calculation between two text addresses.
 * Priority: OpenRouteService (ORS) → Google Maps → Nominatim + Haversine (straight-line)
 *
 * Set ORS_API_KEY in .env for real road distance (free tier: 2000 req/day).
 * Get a free key at https://openrouteservice.org
 */

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BookingAI/1.0' },
    signal: AbortSignal.timeout(6000),
  });
  const data = await res.json();
  if (!data.length) throw new Error(`Cannot geocode: ${query}`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name.split(',').slice(0, 2).join(', ') };
}

async function nominatimDistance(origin, destination) {
  // Nominatim ToS: max 1 req/sec — geocode sequentially
  const o = await geocodeNominatim(origin);
  await new Promise(r => setTimeout(r, 1100));
  const d = await geocodeNominatim(destination);
  const km = haversineKm(o.lat, o.lon, d.lat, d.lon);
  return {
    distance_km: km,
    distance_text: `${km.toFixed(1)} km`,
    duration_text: null,
    duration_mins: null,
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
  url.searchParams.set('language', 'en');

  const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const data = await res.json();
  if (data.status !== 'OK') throw new Error(`Maps API: ${data.status}`);

  const el = data.rows[0]?.elements[0];
  if (el?.status !== 'OK') throw new Error(`Element status: ${el?.status}`);

  const mins = Math.round(el.duration.value / 60);
  return {
    distance_km: el.distance.value / 1000,
    distance_text: `${(el.distance.value / 1000).toFixed(1)} km`,
    duration_text: `~${mins} min`,
    duration_mins: mins,
    source: 'google',
    origin_label: data.origin_addresses[0],
    dest_label: data.destination_addresses[0],
  };
}

async function openRouteServiceDistance(origin, destination, apiKey) {
  const geocodeORS = async (text) => {
    const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(apiKey)}&text=${encodeURIComponent(text)}&size=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (!data.features?.length) throw new Error(`ORS geocode failed: ${text}`);
    const [lon, lat] = data.features[0].geometry.coordinates;
    return { lat, lon, label: data.features[0].properties.label };
  };

  const o = await geocodeORS(origin);
  const d = await geocodeORS(destination);

  const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/json', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ coordinates: [[o.lon, o.lat], [d.lon, d.lat]] }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.routes?.length) throw new Error('ORS: no route found');

  const summary = data.routes[0].summary;
  const km   = summary.distance / 1000;
  const mins = Math.round(summary.duration / 60);

  return {
    distance_km: km,
    distance_text: `${km.toFixed(1)} km`,
    duration_text: `~${mins} min`,
    duration_mins: mins,
    source: 'ors',
    origin_label: o.label,
    dest_label: d.label,
  };
}

export async function calculateDistance(origin, destination) {
  const orsKey    = process.env.ORS_API_KEY;
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;

  if (orsKey) {
    try { return await openRouteServiceDistance(origin, destination, orsKey); }
    catch (err) { console.warn('ORS fallback to next provider:', err.message); }
  }
  if (googleKey && googleKey !== 'your_google_maps_api_key') {
    try { return await googleMapsDistance(origin, destination, googleKey); }
    catch (err) { console.warn('Google Maps fallback to Nominatim:', err.message); }
  }
  return await nominatimDistance(origin, destination);
}
