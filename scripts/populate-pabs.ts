/**
 * populate-pabs.ts
 *
 * Populates the `users` and `pabs` tables with:
 *  - 1 PAB per unique HDB block in Singapore (sourced from data.gov.sg HDB resale dataset)
 *  - 3–5 PABs per major shopping mall / large building (hardcoded)
 *
 * Usage:
 *   bun run populate-pabs.ts
 *
 * Env vars required (same as .env.local):
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 */

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars.");
  console.error(
    "Run with: SUPABASE_URL=... SUPABASE_SECRET_KEY=... bun run populate-pabs.ts",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// OneMap search — no auth required for basic address search
// data.gov.sg — "HDB Existing Buildings" GeoJSON dataset (has coordinates)
const HDB_DATASET_ID = "d_16b157c52ed637edd6ba1232e026258d";
const DATAGOV_POLL = `https://api-open.data.gov.sg/v1/public/api/datasets/${HDB_DATASET_ID}/poll-download`;

// ---------------------------------------------------------------------------
// Shopping malls & large buildings — multiple PABs each
// ---------------------------------------------------------------------------

const LARGE_BUILDINGS: {
  name: string;
  streetName: string;
  postalCode: string;
  lat: number;
  lng: number;
  floors: string[]; // unit_no values — one PAB per entry
}[] = [
  {
    name: "VivoCity",
    streetName: "HarbourFront Walk",
    postalCode: "098585",
    lat: 1.2645,
    lng: 103.8222,
    floors: [
      "L1 Main Entrance",
      "L2 Central Atrium",
      "L3 Sky Park",
      "B1 MRT Link",
      "B2 Carpark",
    ],
  },
  {
    name: "Jewel Changi Airport",
    streetName: "Airport Boulevard",
    postalCode: "819666",
    lat: 1.3606,
    lng: 103.9893,
    floors: [
      "L1 Arrival Hall",
      "L2 Shopping",
      "L3 Dining",
      "B1 Train Station",
      "L4 Forest Valley",
    ],
  },
  {
    name: "ION Orchard",
    streetName: "Orchard Turn",
    postalCode: "238801",
    lat: 1.304,
    lng: 103.8319,
    floors: [
      "B4 MRT",
      "B1 Food Hall",
      "L1 Entrance",
      "L2 Fashion",
      "L4 Lifestyle",
    ],
  },
  {
    name: "Bugis Junction",
    streetName: "Victoria Street",
    postalCode: "188021",
    lat: 1.2993,
    lng: 103.8554,
    floors: ["B1 MRT Concourse", "L1 Entrance", "L2 Fashion", "L3 F&B"],
  },
  {
    name: "Tampines Mall",
    streetName: "Tampines Central 5",
    postalCode: "529510",
    lat: 1.3527,
    lng: 103.9455,
    floors: ["B1 Supermarket", "L1 Entrance", "L2 Fashion", "L3 Entertainment"],
  },
  {
    name: "Jurong Point",
    streetName: "Jurong West Central 1",
    postalCode: "648886",
    lat: 1.3399,
    lng: 103.7063,
    floors: ["B1 MRT", "L1 Entrance", "L2 Lifestyle", "L3 F&B", "L4 Community"],
  },
  {
    name: "Northpoint City",
    streetName: "Yishun Central 1",
    postalCode: "768441",
    lat: 1.4294,
    lng: 103.8357,
    floors: [
      "B1 MRT Link",
      "L1 Entrance",
      "L2 Fashion",
      "L3 Dining",
      "L4 Services",
    ],
  },
  {
    name: "Causeway Point",
    streetName: "Woodlands Square",
    postalCode: "738099",
    lat: 1.4359,
    lng: 103.7862,
    floors: ["B1 MRT", "L1 Entrance", "L2 Fashion", "L3 Entertainment"],
  },
  {
    name: "NEX",
    streetName: "Serangoon Central",
    postalCode: "556083",
    lat: 1.3503,
    lng: 103.8727,
    floors: [
      "B2 MRT",
      "B1 Basement",
      "L1 Entrance",
      "L2 Lifestyle",
      "L4 Recreation",
    ],
  },
  {
    name: "Plaza Singapura",
    streetName: "Orchard Road",
    postalCode: "238839",
    lat: 1.3006,
    lng: 103.8452,
    floors: [
      "B1 Supermarket",
      "L1 Entrance",
      "L2 Fashion",
      "L3 F&B",
      "L5 Cinema",
    ],
  },
  {
    name: "Westgate",
    streetName: "Gateway Drive",
    postalCode: "608532",
    lat: 1.3337,
    lng: 103.7424,
    floors: ["B1 MRT", "L1 Entrance", "L2 Fashion", "L3 Kids", "L4 Dining"],
  },
  {
    name: "AMK Hub",
    streetName: "Ang Mo Kio Ave 8",
    postalCode: "569933",
    lat: 1.3699,
    lng: 103.8495,
    floors: ["B1 MRT", "L1 Entrance", "L2 Lifestyle", "L3 F&B"],
  },
  {
    name: "Hougang Mall",
    streetName: "Hougang Ave 10",
    postalCode: "538766",
    lat: 1.3717,
    lng: 103.8929,
    floors: ["B1 Supermarket", "L1 Entrance", "L2 Fashion", "L3 F&B"],
  },
  {
    name: "Bedok Mall",
    streetName: "Bedok North Street 1",
    postalCode: "469660",
    lat: 1.3243,
    lng: 103.9299,
    floors: ["B1 MRT", "L1 Entrance", "L2 Lifestyle", "L3 Dining"],
  },
  {
    name: "Parkway Parade",
    streetName: "Marine Parade Road",
    postalCode: "449269",
    lat: 1.3021,
    lng: 103.9054,
    floors: [
      "B1 Supermarket",
      "L1 Entrance",
      "L2 Fashion",
      "L3 F&B",
      "L4 Entertainment",
    ],
  },
  {
    name: "Clementi Mall",
    streetName: "The Clementi Mall",
    postalCode: "129588",
    lat: 1.315,
    lng: 103.7652,
    floors: ["B1 MRT", "L1 Entrance", "L2 Lifestyle", "L3 F&B"],
  },
  {
    name: "White Sands",
    streetName: "Pasir Ris Central",
    postalCode: "518457",
    lat: 1.3728,
    lng: 103.9493,
    floors: ["B1 Supermarket", "L1 Entrance", "L2 Fashion", "L3 F&B"],
  },
  {
    name: "Punggol Plaza",
    streetName: "Punggol Central",
    postalCode: "828765",
    lat: 1.4017,
    lng: 103.9024,
    floors: ["L1 Entrance", "L2 Lifestyle", "L3 F&B"],
  },
  {
    name: "Sengkang Square",
    streetName: "Sengkang Square",
    postalCode: "545078",
    lat: 1.3918,
    lng: 103.8952,
    floors: ["B1 MRT", "L1 Entrance", "L2 Fashion", "L3 Dining"],
  },
  {
    name: "Compass One",
    streetName: "Sengkang Square",
    postalCode: "545078",
    lat: 1.3919,
    lng: 103.8956,
    floors: ["B1 MRT", "L1 Entrance", "L2 Lifestyle", "L3 F&B"],
  },
  {
    name: "Bukit Panjang Plaza",
    streetName: "Bukit Panjang Ring Road",
    postalCode: "670, Singapore",
    lat: 1.3784,
    lng: 103.7633,
    floors: ["B1 MRT", "L1 Entrance", "L2 Fashion", "L3 Dining"],
  },
  {
    name: "Toa Payoh Hub",
    streetName: "Lor 6 Toa Payoh",
    postalCode: "310480",
    lat: 1.3321,
    lng: 103.8477,
    floors: ["B1 Library", "L1 Sports", "L2 CC", "L3 F&B"],
  },
  {
    name: "Singapore General Hospital",
    streetName: "Outram Road",
    postalCode: "169608",
    lat: 1.2796,
    lng: 103.8353,
    floors: [
      "Block 1 A&E",
      "Block 2 OPD",
      "Block 3 Specialist",
      "Block 4 Wards",
      "Block 7 Cancer",
    ],
  },
  {
    name: "Tan Tock Seng Hospital",
    streetName: "Jalan Tan Tock Seng",
    postalCode: "308433",
    lat: 1.3213,
    lng: 103.8455,
    floors: [
      "Main Block A&E",
      "Annex A OPD",
      "Centre Bldg Wards",
      "NCID Block",
    ],
  },
  {
    name: "Changi General Hospital",
    streetName: "Simei Street 3",
    postalCode: "529889",
    lat: 1.3404,
    lng: 103.9494,
    floors: [
      "Block A A&E",
      "Block B OPD",
      "Block C Specialist",
      "Block D Wards",
    ],
  },
  {
    name: "National University Hospital",
    streetName: "Lower Kent Ridge Road",
    postalCode: "119074",
    lat: 1.2937,
    lng: 103.7832,
    floors: [
      "Main Tower A&E",
      "Kent Ridge Wing",
      "Clinic D Oncology",
      "Block EA Wards",
    ],
  },
  {
    name: "Khoo Teck Puat Hospital",
    streetName: "Yishun Central 2",
    postalCode: "768828",
    lat: 1.4247,
    lng: 103.838,
    floors: [
      "Tower A A&E",
      "Tower B OPD",
      "Tower C Specialist",
      "Garden Block",
    ],
  },
  {
    name: "Changi Airport T1",
    streetName: "Airport Boulevard",
    postalCode: "819642",
    lat: 1.3566,
    lng: 103.9887,
    floors: ["L1 Arrival", "L2 Departure", "L3 Transit", "B1 MRT"],
  },
  {
    name: "Changi Airport T2",
    streetName: "Airport Boulevard",
    postalCode: "819643",
    lat: 1.3591,
    lng: 103.9893,
    floors: ["L1 Arrival", "L2 Departure", "L3 Transit", "B1 MRT"],
  },
  {
    name: "Changi Airport T3",
    streetName: "Airport Boulevard",
    postalCode: "819663",
    lat: 1.3549,
    lng: 103.9872,
    floors: ["L1 Arrival", "L2 Departure", "L3 Transit", "B2 MRT"],
  },
  {
    name: "Marina Bay Sands",
    streetName: "Bayfront Avenue",
    postalCode: "018956",
    lat: 1.2837,
    lng: 103.8607,
    floors: ["L1 Casino", "L2 Shops", "L3 F&B", "L4 Convention", "Skypark"],
  },
  {
    name: "Gardens by the Bay",
    streetName: "Marina Gardens Drive",
    postalCode: "018953",
    lat: 1.2816,
    lng: 103.8636,
    floors: ["Flower Dome", "Cloud Forest", "Supertree Grove", "OCBC Skyway"],
  },
  {
    name: "Resorts World Sentosa",
    streetName: "Sentosa Gateway",
    postalCode: "098269",
    lat: 1.2577,
    lng: 103.8239,
    floors: ["Universal Studios", "SEA Aquarium", "Hotel Zone", "Casino"],
  },
  {
    name: "Raffles City",
    streetName: "North Bridge Road",
    postalCode: "179103",
    lat: 1.2936,
    lng: 103.8531,
    floors: ["B1 MRT", "L1 Entrance", "L2 Fashion", "L3 F&B"],
  },
  {
    name: "313@somerset",
    streetName: "Orchard Road",
    postalCode: "238895",
    lat: 1.3007,
    lng: 103.8384,
    floors: ["B3 MRT", "L1 Entrance", "L2 Fashion", "L4 F&B", "L5 Lifestyle"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const BATCH_SIZE = 500;

interface PABRow {
  lat: number;
  lng: number;
  streetName: string | null;
  unitNo: string | null;
  postalCode: string | null;
}

/** Bulk-insert a batch of PAB rows. Inserts users first, then pabs. */
async function batchInsertPABs(
  rows: PABRow[],
): Promise<{ inserted: number; failed: number }> {
  if (!rows.length) return { inserted: 0, failed: 0 };

  const ids = rows.map(() => crypto.randomUUID());

  // 1. Bulk insert users
  const { error: userErr } = await supabase
    .from("users")
    .insert(ids.map((id) => ({ id, type: "pab" })));

  if (userErr) {
    console.error("  users batch insert error:", userErr.message);
    return { inserted: 0, failed: rows.length };
  }

  // 2. Bulk insert pabs
  const { error: pabErr } = await supabase.from("pabs").insert(
    rows.map((r, i) => ({
      id: ids[i],
      latitude: r.lat,
      longitude: r.lng,
      street_name: r.streetName,
      unit_no: r.unitNo,
      postal_code: r.postalCode,
    })),
  );

  if (pabErr) {
    console.error("  pabs batch insert error:", pabErr.message);
    // Roll back users
    await supabase.from("users").delete().in("id", ids);
    return { inserted: 0, failed: rows.length };
  }

  return { inserted: rows.length, failed: 0 };
}

// ---------------------------------------------------------------------------
// Step 1 + 2: Fetch HDB Existing Buildings GeoJSON and insert PABs
// ---------------------------------------------------------------------------

interface GeoJSONFeature {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  };
  properties: Record<string, string | number | null>;
}

/** Compute centroid from any GeoJSON geometry coordinates. */
function centroid(
  geometry: GeoJSONFeature["geometry"],
): { lat: number; lng: number } | null {
  const flatten = (coords: unknown): number[][] => {
    if (typeof coords[0] === "number") return [coords as number[]];
    return (coords as unknown[]).flatMap(flatten);
  };
  const pts = flatten(geometry.coordinates);
  if (!pts.length) return null;
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { lat, lng };
}

async function populateHDBBlocks() {
  // 1. Get the GeoJSON download URL from data.gov.sg poll-download endpoint
  console.log("\nFetching HDB Existing Buildings GeoJSON from data.gov.sg…");

  let downloadUrl: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(DATAGOV_POLL, {
      headers: { "User-Agent": "PAB-Populate-Script/1.0" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`  poll-download returned ${res.status}`);
      break;
    }

    const json = (await res.json()) as {
      code: number;
      data?: { url?: string };
    };

    if (json.code === 0 && json.data?.url) {
      downloadUrl = json.data.url;
      break;
    }

    // Not ready yet — poll again
    console.log(`  Not ready (code=${json.code}), polling again in 3s…`);
    await sleep(3000);
  }

  if (!downloadUrl) {
    console.error(
      "  Could not get GeoJSON download URL — skipping HDB blocks.",
    );
    return;
  }

  // 2. Download the GeoJSON (can be large — stream into text)
  console.log("  Downloading GeoJSON…");
  const dlRes = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(120000),
  });
  if (!dlRes.ok) {
    console.error(`  GeoJSON download failed: ${dlRes.status}`);
    return;
  }

  const geojson = (await dlRes.json()) as { features?: GeoJSONFeature[] };
  const features = geojson.features ?? [];
  console.log(`  ${features.length} HDB building features loaded.`);

  // 3. Batch-insert PABs (coordinates already in GeoJSON — no geocoding)
  let inserted = 0;
  let failed = 0;
  let batch: PABRow[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const result = await batchInsertPABs(batch);
    inserted += result.inserted;
    failed += result.failed;
    batch = [];
  };

  for (const f of features) {
    const pt = centroid(f.geometry);
    if (!pt) {
      failed++;
      continue;
    }

    const p = f.properties;
    const blk = String(p.blk_no ?? p.BLK_NO ?? p.block ?? "").trim();
    const street = String(p.street ?? p.street_name ?? "").trim();
    const postal = String(
      p.postal_cd ?? p.POSTAL_COD ?? p.postal_code ?? "",
    ).trim();

    batch.push({
      lat: pt.lat,
      lng: pt.lng,
      streetName: street || null,
      unitNo: blk ? `BLK ${blk}` : null,
      postalCode: postal || null,
    });

    if (batch.length >= BATCH_SIZE) {
      await flush();
      process.stdout.write(`  inserted=${inserted} failed=${failed}\r`);
    }
  }

  await flush();
  console.log(`\nHDB blocks done — inserted: ${inserted}, failed: ${failed}`);
}

// ---------------------------------------------------------------------------
// Step 3: Insert large buildings
// ---------------------------------------------------------------------------

async function populateLargeBuildings() {
  console.log(`\nInserting ${LARGE_BUILDINGS.length} large buildings…`);

  const rows: PABRow[] = LARGE_BUILDINGS.flatMap((b) =>
    b.floors.map((floor) => ({
      lat: b.lat,
      lng: b.lng,
      streetName: b.streetName,
      unitNo: floor,
      postalCode: b.postalCode,
    })),
  );

  const { inserted, failed } = await batchInsertPABs(rows);
  console.log(
    `Large buildings done — inserted: ${inserted}, failed: ${failed}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== PAB Population Script ===\n");

  // 1. Large buildings first (fast, no geocoding needed)
  await populateLargeBuildings();

  // 2. HDB blocks (coordinates come from GeoJSON — no geocoding needed)
  await populateHDBBlocks();

  console.log("\n=== All done! ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
