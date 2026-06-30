/**
 * utils/summary.js
 * ================
 * Pure helper functions used by multiple components and hooks.
 * No React, no side-effects — safe to import anywhere.
 */

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}  e.g. "1.4 MB"
 */
export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${["B", "KB", "MB", "GB"][i]}`;
}

// ── RTT ───────────────────────────────────────────────────────────────────────

/**
 * Return a CSS class name for colour-coding an RTT value.
 * @param {number|null} rtt  milliseconds
 * @returns {string}
 */
export function getRttClass(rtt) {
  if (rtt == null) return "";
  if (rtt < 50)   return "rtt-low";
  if (rtt < 150)  return "rtt-medium";
  if (rtt < 300)  return "rtt-high";
  return "rtt-very-high";
}

// ── Hop classification ────────────────────────────────────────────────────────

/**
 * Return a human-readable status label for a hop object.
 * @param {object} h  hop from the backend
 * @returns {string}
 */
export function hopStatusLabel(h) {
  if (h.timeout)     return "Timeout";
  if (h.is_private)  return "Private Network";
  if (h.no_location) return "Reachable (No Geo)";
  return "Reachable";
}

// ── City/country parsing ──────────────────────────────────────────────────────

/**
 * Split a backend city string into city and country parts.
 * The string format is "City, Country [ISP]" — the ISP suffix is stripped.
 *
 * @param {string|null} cityStr
 * @returns {{ city: string|null, country: string|null }}
 */
export function parseCityCountry(cityStr) {
  if (!cityStr) return { city: null, country: null };
  const withoutIsp = cityStr.replace(/\s*\[.*?\]\s*$/, "");
  const parts = withoutIsp.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], country: parts[parts.length - 1] };
  return { city: parts[0] || cityStr, country: null };
}

// ── ASN grouping ──────────────────────────────────────────────────────────────

/**
 * Group consecutive hops that share the same non-null ASN into a single
 * group object, otherwise each hop forms a singleton group.
 *
 * @param {Array} hops
 * @returns {Array<{ asn: number|null, org: string|null, hops: Array }>}
 */
export function groupHopsByASN(hops) {
  const groups = [];
  for (const hop of hops) {
    const last = groups[groups.length - 1];
    if (last && hop.asn != null && last.asn === hop.asn) {
      last.hops.push(hop);
    } else {
      groups.push({ asn: hop.asn ?? null, org: hop.org ?? null, hops: [hop] });
    }
  }
  return groups;
}

// ── Geography ─────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine great-circle distance in km between two lat/lng points.
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number}
 */
export function haversineDistanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const sinDL = Math.sin(dLat / 2);
  const sinDG = Math.sin(dLng / 2);
  const h =
    sinDL * sinDL +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDG * sinDG;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Infer the international exit point from a list of hops.
 * Returns the last hop in the origin country before the route changes
 * countries, or null if the trace never left the origin country.
 *
 * @param {Array} hops
 * @returns {object|null}
 */
export function inferExitPoint(hops) {
  const withCountry = hops
    .filter(h => h.lat != null && h.lng != null)
    .map(h => ({ hop: h, country: parseCityCountry(h.city).country }))
    .filter(entry => entry.country);

  if (withCountry.length === 0) return null;

  const originCountry = withCountry[0].country;
  let lastInOrigin = null;
  let leftOrigin   = false;

  for (const entry of withCountry) {
    if (entry.country === originCountry) {
      lastInOrigin = entry.hop;
    } else {
      leftOrigin = true;
      break;
    }
  }

  return leftOrigin ? lastInOrigin : null;
}

// ── Summary generation ────────────────────────────────────────────────────────

/**
 * Compute the full trace summary object from a completed hop list.
 *
 * @param {Array} hops
 * @returns {object|null}  null when hops is empty
 */
export function generateSummary(hops) {
  if (!hops || hops.length === 0) return null;

  const totalHops   = hops.length;
  const privateHops = hops.filter(h => h.is_private).length;
  const timeoutHops = hops.filter(h => h.timeout).length;
  const publicHops  = totalHops - privateHops - timeoutHops;

  const rtts   = hops.map(h => h.rtt).filter(r => r != null);
  const minRtt = rtts.length ? Math.min(...rtts) : null;
  const maxRtt = rtts.length ? Math.max(...rtts) : null;
  const avgRtt = rtts.length
    ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10
    : null;

  const uniqueASNs      = new Set(hops.map(h => h.asn).filter(v => v != null)).size;
  const uniqueOrgs      = new Set(hops.map(h => h.org).filter(Boolean)).size;
  const uniqueCountries = new Set(
    hops.map(h => parseCityCountry(h.city).country).filter(Boolean)
  ).size;

  const geoHops = hops.filter(h => h.lat != null && h.lng != null);
  let distanceKm = 0;
  for (let i = 1; i < geoHops.length; i++) {
    distanceKm += haversineDistanceKm(geoHops[i - 1], geoHops[i]);
  }

  return {
    totalHops, publicHops, privateHops, timeoutHops,
    minRtt, maxRtt, avgRtt,
    uniqueASNs, uniqueOrgs, uniqueCountries,
    distanceKm: Math.round(distanceKm),
    exitPoint: inferExitPoint(hops),
  };
}
