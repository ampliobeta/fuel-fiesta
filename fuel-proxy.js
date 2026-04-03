const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── DELIVERY SCHEMA ───────────────────────────────────────────────────────────

const DELIVERY_SCHEMA = {
  bottle: { delivery_mode: 'semi_continuous', ease_of_use: 'high', requires_hand: false, absorption_speed: 'fast', context: 'any', notes: 'Passive sipping. Best background carb channel. Works on all terrain.' },
  gel:    { delivery_mode: 'discrete', ease_of_use: 'medium', requires_hand: true, absorption_speed: 'fast', context: 'any', notes: 'Requires a clean window. Hard on technical terrain or steep climbs. Ideal around intensity.' },
  bar:    { delivery_mode: 'discrete', ease_of_use: 'low', requires_hand: true, absorption_speed: 'medium', context: 'steady', notes: 'First hour or flat steady terrain only. Avoid on climbs or at race pace.' },
  food:   { delivery_mode: 'discrete', ease_of_use: 'low', requires_hand: true, absorption_speed: 'slow', context: 'steady', notes: 'First hour or Z2 sections only. Not suitable for race-pace efforts.' },
  diy:    { delivery_mode: 'semi_continuous', ease_of_use: 'high', requires_hand: false, absorption_speed: 'fast', context: 'any', notes: 'Same as bottle. Continuous background fueling.' },
  sodium: { delivery_mode: 'discrete', ease_of_use: 'high', requires_hand: false, absorption_speed: 'fast', context: 'any', notes: 'Sodium only. No carbs. Add to bottle or take with fluid.' },
  pack:   { delivery_mode: 'continuous', ease_of_use: 'high', requires_hand: false, absorption_speed: 'fast', context: 'any', notes: 'Hands-free continuous sipping. Works on all terrain. Frees bottles for concentrated carb mix. Significantly improves resilience.' }
};

// ── DELIVERY MODE CLASSIFIER ──────────────────────────────────────────────────
// Section 11-12 of engineering handoff

function classifyDeliveryMode(products) {
  const hasPack = products.some(p => p.type === 'pack');
  const bottleCount = products.filter(p => p.type === 'bottle' || p.type === 'diy').length;
  if (!hasPack) return 'bottle_based';
  if (bottleCount === 0) return 'pack_based';
  return 'hybrid';
}

// ── RESILIENCE SCORING ────────────────────────────────────────────────────────
// Sections 13-15 of engineering handoff

function computeResilience(products, rideDesc) {
  if (!products || products.length === 0) return null;

  const totalCarbs = products.reduce((s, p) => s + (p.carbs || 0), 0);
  if (totalCarbs === 0) return null;

  let continuousCarbs = 0, discreteCarbs = 0;
  const channels = new Set();

  products.forEach(p => {
    const schema = DELIVERY_SCHEMA[p.type] || DELIVERY_SCHEMA.gel;
    channels.add(schema.delivery_mode);
    if (schema.delivery_mode === 'semi_continuous' || schema.delivery_mode === 'continuous') {
      continuousCarbs += p.carbs || 0;
    } else {
      discreteCarbs += p.carbs || 0;
    }
  });

  const pctContinuous = totalCarbs > 0 ? continuousCarbs / totalCarbs : 0;
  const pctDiscrete = totalCarbs > 0 ? discreteCarbs / totalCarbs : 0;
  const channelCount = channels.size;

  const desc = rideDesc.toLowerCase();
  const fuelingAccess = /technical|singletrack|no flat|no sustained flat|never flat|repeated climb|rolling/.test(desc) ? 'limited' : 'moderate';
  const hasAidStation = /aid station|feed zone|refill|café stop|support/.test(desc);
  const earlyEasy = /rolls out|pavement|flat early|gentle early|0.10 miles/.test(desc);

  // Score per section 14
  let score = 100;
  if (pctContinuous < 0.4) score -= 18;
  else if (pctContinuous < 0.6) score -= 8;
  if (pctDiscrete > 0.55) score -= 16;
  else if (pctDiscrete > 0.40) score -= 8;
  if (fuelingAccess === 'limited' && pctDiscrete > 0.45) score -= 14;
  if (channelCount === 1) score -= 10;
  else if (channelCount === 2) score -= 4;
  const gramsLostIn15 = pctDiscrete * 1.9 * 15;
  if (gramsLostIn15 >= 20) score -= 12;
  else if (gramsLostIn15 >= 12) score -= 6;
  score = Math.max(0, Math.min(100, score));

  // Buckets per section 15
  const classification = score >= 80 ? 'Buffered' : score >= 60 ? 'Moderate' : 'Tight';

  return {
    score,
    classification,
    continuous_pct: Math.round(pctContinuous * 100),
    discrete_pct: Math.round(pctDiscrete * 100),
    channel_count: channelCount,
    fueling_access: fuelingAccess,
    front_load: classification === 'Tight' || earlyEasy,
    has_aid_station: hasAidStation,
    delivery_mode: classifyDeliveryMode(products)
  };
}

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────

function buildPrompt({ desc, tempLabel, sweatLabel, gutLabel, productList, deliveryContext, resilience, otherFoodStr }) {
  const dm = resilience ? resilience.delivery_mode : 'bottle_based';
  const resCtx = resilience ? `
Pre-computed system analysis (do not override):
- Delivery mode: ${dm}
- Resilience score: ${resilience.score}/100 → ${resilience.classification}
- Continuous carb sources: ${resilience.continuous_pct}%
- Discrete carb sources: ${resilience.discrete_pct}%
- Fueling access: ${resilience.fueling_access}
- Delivery channels: ${resilience.channel_count}
- Front-load: ${resilience.front_load}
- Aid station: ${resilience.has_aid_station}` : '';

  const delCtx = deliveryContext ? `\nDelivery context:\n${deliveryContext}` : '';

  return `You are a no-nonsense cycling nutritionist building a rideable fueling system. Return ONLY a JSON object — no markdown, no explanation.

Ride: ${desc}
Conditions: ${tempLabel}
Sweat profile: ${sweatLabel}
Gut capacity: ${gutLabel}
Available products:
${productList}
${otherFoodStr || ''}
${delCtx}
${resCtx}

Return this exact JSON — every field required:
{
  "ride_summary": "1 sentence describing ride demand",
  "duration_hours": <number>,
  "carbs_per_hour": <integer>,
  "sodium_per_hour": <integer>,
  "fluid_per_hour": "e.g. 600-750 ml/hr",
  "total_carbs": <integer>,
  "total_sodium": <integer>,
  "fuel_system": {
    "type": "pack_based | hybrid | bottle_based",
    "summary": "1 sentence only — name the primary channel and secondary channel. No math, no gram counts, no scoop counts."
  },
  "packing_list": {
    "required": [
      { "item": "item name and quantity — no scoop math", "carbs": <integer>, "note": "logistics note only" }
    ],
    "optional": [
      { "item": "optional item", "carbs": <integer>, "note": "when to use it" }
    ]
  },
  "execution": {
    "continuous": ["sip behavior for pack or bottle — 1 line each"],
    "discrete": ["gel and solid timing — 1 line each"],
    "terrain_notes": ["where windows are limited — 1 line each"]
  },
  "resilience": {
    "classification": "Tight | Moderate | Buffered",
    "note": "1 plain sentence — why, in terms of delivery mix and terrain",
    "front_load": true | false,
    "front_load_tip": "specific first 20-30min banking action, or empty string",
    "warning": "plain language execution fragility warning, or empty string"
  },
  "prep_details": {
    "containers": [
      { "container": "e.g. Hydration pack", "contents": "what goes in", "carbs": <integer>, "sodium": <integer> }
    ],
    "total_note": "X total carbs, Y total sodium for Zhr"
  },
  "ratio_note": "why carb ratio matters here, or empty string",
  "bottom_line": "1 sentence — consequence of under-fueling this specific ride",
  "stem_card": {
    "pre": "before rolling — max 8 words",
    "during": "background rhythm — max 8 words",
    "efforts": "at intensity moments — max 8 words",
    "target": "Xg/hr + one phrase — max 8 words"
  }
}

DELIVERY MODE RULES (use pre-computed value — do not override):
- pack_based: pack is primary for fluid AND carbs. Bottles are NOT required. Do not put bottles in packing_list.required.
- hybrid: pack handles continuous hydration. ONE bottle max as secondary — it goes in packing_list.optional unless rider has no other carb source. Gels are top-ups.
- bottle_based: no pack. Max 2 bottles. Gels fill carb gap.

CONTRADICTION PREVENTION (section 16 of spec):
- hybrid or pack_based: never list 2 bottles as required. Max 1 bottle, listed as optional.
- If pack present: pack is the first item in packing_list.required always.
- bottle_based: no pack references anywhere.
- Never make gels the primary carb source unless no bottles or pack are selected.

OUTPUT RULES:
- fuel_system.summary: conceptual only. No scoop counts, no gram math. Just: primary channel → secondary channel → backup.
- packing_list: logistics only. What to physically carry. No timing. No nutrition math in items. Math goes in prep_details.
- execution: split into continuous (sipping), discrete (gel/solid timing), terrain_notes (where windows are limited).
- prep_details: this is where scoop counts, carb totals per container, and concentration math live. Keep it OUT of packing_list.
- Explain the fuel system before the ingredients. This is the output order in the JSON and should be the mental model for the rider.

FUELING RULES:
- DURATION: use explicitly stated duration. Do not infer from distance.
- CARB TARGETS: push upper end for intensity above Z2. Standard: 85-90g/hr. Gut trained: 110-120g/hr for race efforts.
- PHILOSOPHY: protect power output at key moments. Gels are top-ups not rescues.
- SOLID FOOD: first hour or Z2 only. Note it in packing_list item note.
- SODIUM: Cool 400-600. Moderate 600-800. Hot 800-1000mg/hr.
- SALTY SWEATER: +40-60% sodium.
- MAURTEN: very low sodium — flag that sodium must come from other sources.
- SHORT RACE <45min: no bottle, pre-load 1-2 gels.
- CIRCUIT 45-75min: pre-load 2 gels, 1 light bottle, 1 spare gel.
- SHORT CRIT 45-75min: pre-load all, water only mid-race.
- GRAVEL 3-5hr: self-supported, sodium critical, intake every 20-30min.
- LONG RIDE 4hr+: pocket logistics and water stop plan.
- BOTTLES WITH NO DRINK MIX: If the rider mentions bottles in their ride description but has selected no drink mix product — those bottles carry water only. Do not reference any drink mix. Add to resilience.warning: "Bottles will carry water only — no drink mix selected. Add one from the kit builder to hit carb targets."
- NO PRODUCT INVENTION: ONLY use products explicitly selected in the kit builder or described in the other foods field. NEVER invent a hydration pack, bottle, gel, sports drink mix, or any gear not selected. NEVER use phrases like "sports drink mix", "carb drink", "electrolyte drink" unless a specific product was selected. If nothing was selected, the rider has water and whatever real food they described. Build the plan around that and flag the gap.
- IF THE PLAN SEEMS INADEQUATE: Say so plainly in resilience.warning. Recommend what type of product to add — but never invent it.
- OTHER FOODS: Items in the other foods field are real food only. Reason about nutrition naturally. Do not treat them as gear.
- ALL BRANDS EQUAL.
- STEM CARD: max 8 words per line, action words, screenshot-readable.
- Return ONLY the JSON object.`;
}

// ── ENDPOINT ──────────────────────────────────────────────────────────────────

app.post('/api/fuel', async (req, res) => {
  try {
    const { desc, tempLabel, sweatLabel, gutLabel, products, otherFood } = req.body;
    if (!desc || !tempLabel) return res.status(400).json({ error: 'Missing required fields' });

    const otherFoodStr = otherFood ? `\nAdditional foods / stops the rider has access to (reason about nutrition naturally — you know these foods):\n${otherFood}` : '';

    const productList = products && products.length > 0
      ? products.map(p => {
          const s = DELIVERY_SCHEMA[p.type] || {};
          return `${p.name} (${p.carbs}g carbs, ${p.sodium}mg sodium per ${p.unit}${p.ratio ? ', ' + p.ratio : ''}) — delivery: ${s.delivery_mode || 'discrete'}, context: ${s.context || 'any'}`;
        }).join('\n')
      : 'No specific products selected — give general advice.';

    const deliveryContext = products && products.length > 0
      ? products.map(p => `${p.name}: ${(DELIVERY_SCHEMA[p.type] || {}).notes || ''}`).join('\n')
      : null;

    const resilience = computeResilience(products, desc);
    const prompt = buildPrompt({ desc, tempLabel, sweatLabel, gutLabel, productList, deliveryContext, resilience, otherFoodStr });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Fuel Control running on port ${PORT}`));
