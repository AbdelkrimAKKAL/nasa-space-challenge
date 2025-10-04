import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// Heuristiques/Seuils (tu peux ajuster selon le besoin)
const THRESHOLDS = {
  veryHotC: 30,       // > 30°C
  veryColdC: 0,       // < 0°C
  veryWindyMS: 8.3,   // > 30 km/h ≈ 8.3 m/s
  veryHumidPct: 80,   // > 80% RH
};

// Simple helper pour arrondir 0–100
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

function monthFromISO(dateStr) {
  // "2025-07-15" -> 7
  const m = new Date(dateStr).getMonth() + 1;
  return isNaN(m) ? 7 : m;
}

/**
 * API NASA POWER (climatology par mois) :
 * https://power.larc.nasa.gov/api/temporal/climatology/point
 * parameters: T2M (temp 2m °C), RH2M (%), PRECTOTCORR (mm/j), WS10M (m/s)
 */
async function getClimatology(lat, lon) {
  const params = [
    "T2M",          // temp
    "RH2M",         // humidité relative
    "PRECTOTCORR",  // précipitations
    "WS10M"         // vent 10m
  ].join(",");
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=${params}&community=RE&longitude=${lon}&latitude=${lat}&start=20100101&end=20101231&format=JSON`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("POWER API error");
  const j = await r.json();
  // Structure: properties.parameter.{PARAM}[1..12]
  return j?.properties?.parameter || null;
}

/**
 * Convertit la climatologie mensuelle en "probabilités" heuristiques.
 * Ici on n'a pas d'écarts-types → on approxime une probabilité relative
 * en comparant la moyenne mensuelle au seuil, avec une rampe douce.
 */
function estimateProbabilitiesForMonth(month, p) {
  // Valeurs mensuelles
  const T2M = p?.T2M?.[month];             // °C
  const RH2M = p?.RH2M?.[month];           // %
  const PRECTOT = p?.PRECTOTCORR?.[month]; // mm/jour (moyenne journalière mensuelle)
  const WS10M = p?.WS10M?.[month];         // m/s

  // Fonctions rampe pour approx. probabilité (0–100)
  const rampUp = (x, start, full) => clampPct(((x - start) / (full - start)) * 100);
  const rampDown = (x, full, end) => clampPct(((full - x) / (full - end)) * 100);

  // Très chaud: si > THRESHOLDS.veryHotC ; au-delà de 35°C on considère ~100%
  const pVeryHot = T2M != null ? rampUp(T2M, THRESHOLDS.veryHotC, THRESHOLDS.veryHotC + 5) : 0;

  // Très froid: si < 0°C ; < -10°C on considère ~100%
  const pVeryCold = T2M != null ? rampUp(-T2M, -THRESHOLDS.veryColdC, 10) : 0;

  // Très venteux: > 8.3 m/s ; > 12 m/s on considère ~100%
  const pVeryWindy = WS10M != null ? rampUp(WS10M, THRESHOLDS.veryWindyMS, 12) : 0;

  // Très humide: RH > 80% ; > 95% ~100%
  const pVeryHumid = RH2M != null ? rampUp(RH2M, THRESHOLDS.veryHumidPct, 95) : 0;

  // Très inconfortable: combine chaleur/humidité/vent (simple moyenne pondérée)
  const pUncomfortable = clampPct(0.5 * pVeryHot + 0.3 * pVeryHumid + 0.2 * pVeryWindy);

  // Bonus: pluie forte probable (approx depuis moyenne journalière > 5 mm/j)
  const pRainy = PRECTOT != null ? rampUp(PRECTOT, 5, 15) : 0;

  return {
    veryHot: pVeryHot,
    veryCold: pVeryCold,
    veryWindy: pVeryWindy,
    veryHumid: pVeryHumid,
    veryUncomfortable: pUncomfortable,
    rainy: pRainy,
    raw: { T2M, RH2M, PRECTOT, WS10M }
  };
}

app.get("/api/probabilities", async (req, res) => {
  try {
    const { lat, lon, date } = req.query;
    if (!lat || !lon || !date) return res.status(400).json({ error: "lat, lon, date requis" });
    const month = monthFromISO(date);
    const clim = await getClimatology(lat, lon);
    const result = estimateProbabilitiesForMonth(month, clim);
    res.json({ month, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur / données indisponibles" });
  }
});

const PORT = 5174;
app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
