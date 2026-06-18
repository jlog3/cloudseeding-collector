// ─── GEO / METEOROLOGY HELPERS ──────────────────────────────────────────────
// Pure functions (no I/O) so they can be unit-tested directly. These power the
// wind-aware coupling that the old detector lacked: a seeding effect shows up
// DOWNWIND of the aircraft after a lag, so to find the responsible aircraft you
// project from the anomaly back UPWIND and look there.

const R_EARTH_KM = 6371.0088;
const KTS_TO_KMH = 1.852;
const DEG = Math.PI / 180;

function toRad(d) { return d * DEG; }
function toDeg(r) { return r / DEG; }

/** Great-circle distance in km. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (deg, 0=N, clockwise) from point 1 to point 2. */
function bearingDeg(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Destination point given start, bearing (deg), distance (km). */
function destinationPoint(lat, lng, bearing, distKm) {
  const d = distKm / R_EARTH_KM;
  const br = toRad(bearing);
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/**
 * Where did the air now over (lat,lng) come from `lagHours` ago?
 * windFromDir is the meteorological "wind direction" = the direction the wind is
 * coming FROM (e.g. 270 = wind from the west). The source (upwind) point lies in
 * that from-direction at distance = speed * lag.
 */
function upwindPoint(lat, lng, windFromDirDeg, windSpeedKts, lagHours) {
  const distKm = windSpeedKts * KTS_TO_KMH * lagHours;
  // The upwind/source point is located toward the direction the wind comes from.
  return destinationPoint(lat, lng, windFromDirDeg, distKm);
}

/** Smallest absolute difference between two bearings, 0..180. */
function angularDiff(a, b) {
  let d = Math.abs(((a - b) % 360 + 360) % 360);
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * How perpendicular is a track heading to the wind? Seeding legs are typically
 * flown roughly perpendicular to the low-level wind (so the plume advects across
 * the target). Returns 0..1 where 1 = exactly perpendicular.
 */
function perpendicularityToWind(trackHeadingDeg, windFromDirDeg) {
  const diff = angularDiff(trackHeadingDeg, windFromDirDeg); // 0..180
  // perpendicular (90°) → 1 ; parallel (0/180) → 0
  return 1 - Math.abs(90 - diff) / 90;
}

/**
 * Classify the geometry of one airframe's positions within a window.
 * Input: array of {lat,lng,altitude_ft,speed_kts,heading,time?} (any order ok;
 * sorted by time if `time` present).
 *
 * Returns features used by the candidate scorer:
 *   sightings        – number of fixes
 *   pathKm           – total path length
 *   spanKm           – max straight-line extent (bounding diagonal)
 *   straightness     – spanKm / pathKm (1 = straight line, →0 = tight orbit)
 *   isRacetrack      – many fixes, long path, but small net displacement & repeated reversals
 *   isStraightPass   – long, very straight transit
 *   meanHeading      – circular-mean heading
 *   headingReversals – count of large (>120°) heading changes (racetrack turns)
 *   centroid         – {lat,lng}
 *   avgAltFt, avgSpeedKts
 */
function trackGeometry(points) {
  const pts = points
    .filter((p) => p.lat != null && p.lng != null)
    .slice()
    .sort((a, b) =>
      a.time && b.time ? new Date(a.time) - new Date(b.time) : 0
    );

  const n = pts.length;
  const out = {
    sightings: n,
    pathKm: 0,
    spanKm: 0,
    straightness: 0,
    isRacetrack: false,
    isStraightPass: false,
    meanHeading: 0,
    headingReversals: 0,
    centroid: { lat: 0, lng: 0 },
    avgAltFt: 0,
    avgSpeedKts: 0,
  };
  if (n === 0) return out;

  let sumLat = 0, sumLng = 0, sumAlt = 0, sumSpd = 0, sumSin = 0, sumCos = 0;
  for (const p of pts) {
    sumLat += p.lat; sumLng += p.lng;
    sumAlt += p.altitude_ft || 0;
    sumSpd += p.speed_kts || 0;
    if (p.heading != null) { sumSin += Math.sin(toRad(p.heading)); sumCos += Math.cos(toRad(p.heading)); }
  }
  out.centroid = { lat: sumLat / n, lng: sumLng / n };
  out.avgAltFt = sumAlt / n;
  out.avgSpeedKts = sumSpd / n;
  out.meanHeading = (toDeg(Math.atan2(sumSin, sumCos)) + 360) % 360;

  // Path length + heading reversals (consecutive leg bearings flipping ~180°)
  let prevLegBearing = null;
  for (let i = 1; i < n; i++) {
    const seg = haversineKm(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    out.pathKm += seg;
    if (seg > 0.05) {
      const legB = bearingDeg(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      if (prevLegBearing != null && angularDiff(legB, prevLegBearing) > 120) {
        out.headingReversals++;
      }
      prevLegBearing = legB;
    }
  }

  // Max pairwise extent (cheap bounding-diagonal proxy)
  let maxSpan = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng);
      if (d > maxSpan) maxSpan = d;
    }
  }
  out.spanKm = maxSpan;
  out.straightness = out.pathKm > 0 ? maxSpan / out.pathKm : 0;

  // Racetrack / orbit: lots of flying (long path) folded into a small area
  // (low straightness). Covers both sharp-turn holding patterns (which also
  // show heading reversals) and smooth circular orbits (which don't). The
  // reversal count is kept as a feature for the scorer rather than a gate.
  out.isRacetrack = n >= 6 && out.pathKm > 15 && out.straightness < 0.55;

  // Straight pass: a long, very straight transit (a seeding "line" or a
  // fly-through). Direction (⊥ to wind) is judged separately by the scorer.
  out.isStraightPass = out.spanKm > 20 && out.straightness > 0.8;

  return out;
}

module.exports = {
  R_EARTH_KM,
  KTS_TO_KMH,
  haversineKm,
  bearingDeg,
  destinationPoint,
  upwindPoint,
  angularDiff,
  perpendicularityToWind,
  trackGeometry,
};
