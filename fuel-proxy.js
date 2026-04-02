const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── DELIVERY SCHEMA ──────────────────────────────────────────────────────────
// Structured metadata per product type. Lives server-side only.

const DELIVERY_SCHEMA = {
  bottle: {
    delivery_mode: 'semi_continuous',
    ease_of_use: 'high',
    requires_hand: false,
    absorption_speed: 'fast',
    context: 'any',
    notes: 'Passive sipping. Best background carb channel. Works on all terrain.'
  },
  gel: {
    delivery_mode: 'discrete',
    ease_of_use: 'medium',
    requires_hand: true,
    absorption_speed: 'fast',
    context: 'any',
    notes: 'Requires a clean window. Hard on technical terrain or steep climbs. Ideal around intensity.'
  },
  bar: {
    delivery_mode: 'discrete',
    ease_of_use: 'low',
    requires_hand: true,
    absorption_speed: 'medium',
    context: 'steady',
    notes: 'First hour or flat steady terrain only. Avoid on climbs or at race pace.'
  },
  food: {
    delivery_mode: 'discrete',
    ease_of_use: 'low',
    requires_hand: true,
    absorption_speed: 'slow',
    context: 'steady',
    notes: 'First hour or Z2 sections only. Not suitable for race-pace efforts.'
  },
  diy: {
    delivery_mode: 'semi_continuous',
    ease_of_use: 'high',
    requires_hand: false,
    absorption_speed: 'fast',
    context: 'any',
    notes: 'Same as bottle. Continuous background fueling.'
  },
  sodium: {
    delivery_mode: 'discrete',
    ease_of_use: 'high',
    requires_hand: false,
    absorption_speed: 'fast',
    context: 'any',
    notes: 'Sodium only. No carbs. Add to bottle or take with fluid.'
  },
  pack: {
    delivery_mode: 'continuous',
    ease_of_use: 'high',
    requires_hand: false,
    absorption_speed: 'fast',
    context: 'any',
    notes: 'Hands-free continuous sipping. Works on all terrain including climbs and technical sections. Frees bottles for concentrated carb mix. Significantly improves resilience.'
  }
};

// ── RESILIENCE ENGINE ────────────────────────────────────────────────────────

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

  const discretePct = discreteCarbs / totalCarbs;
  const hasMultipleChannels = channels.size > 1;

  const desc = rideDesc.toLowerCase();
  const isTechnical = /technical|singletrack|mtb/.test(desc);
  const isRolling = /rolling|undulating|repeated climb|short climb|constant/.test(desc);
  const hasNoFlat = /no flat|no sustained flat|never flat|no recovery/.test(desc);
  const hasAidStation = /aid station|feed zone|refill|café stop|support/.test(desc);
  const earlyEasy = /rolls out|pavement|flat early|gentle early|first.*flat|0.10 miles/.test(desc);

  let terrainPenalty = 0;
  if (isTechnical) terrainPenalty += 2;
  if (isRolling && hasNoFlat) terrainPenalty += 1;

  let classification = 'Buffered';
  if (discretePct > 0.65 || (terrainPenalty >= 2 && discretePct > 0.4) || (!hasMultipleChannels && discretePct > 0.5)) {
    classification = 'Tight';
  } else if (discretePct > 0.35 || terrainPenalty >= 1) {
    classification = 'Moderate';
  }

  const frontLoad = classification === 'Tight' || earlyEasy;
  const missTolerance = discretePct > 0.6 ? 'low' : discretePct > 0.35 ? 'medium' : 'high';

  return {
    classification,
    continuous_pct: Math.round((1 - discretePct) * 100),
    discrete_pct: Math.round(discretePct * 100),
    terrain_penalty: terrainPenalty,
    miss_tolerance: missTolerance,
    multiple_channels: hasMultipleChannels,
    front_load: frontLoad,
    has_aid_station: hasAidStation
  };
}

// ── PROMPT BUILDER ───────────────────────────────────────────────────────────
// Never exposed to browser.

function buildPrompt({ desc, tempLabel, sweatLabel, gutLabel, productList, deliveryContext, resilience }) {
  const resCtx = resilience ? `
Pre-computed resilience data (use in reasoning):
- Classification: ${resilience.classification}
- Continuous sources: ${resilience.continuous_pct}% of carbs
- Discrete sources (gels/solids): ${resilience.discrete_pct}% of carbs
- Terrain penalty: ${resilience.terrain_penalty}/3
- Miss tolerance: ${resilience.miss_tolerance}
- Multiple channels: ${resilience.multiple_channels}
- Front-load: ${resilience.front_load}
- Aid station access: ${resilience.has_aid_station}` : '';

  const delCtx = deliveryContext ? `\nDelivery context:\n${deliveryContext}` : '';

  return `You are a no-nonsense cycling nutritionist. Return ONLY a JSON object — no markdown, no explanation.

Ride: ${desc}
Conditions: ${tempLabel}
Sweat profile: ${sweatLabel}
Gut capacity: ${gutLabel}
Available products:
${productList}
${delCtx}
${resCtx}

Return this exact JSON:
{
  "ride_summary": "1 sentence describing ride demand",
  "duration_hours": <number>,
  "carbs_per_hour": <integer>,
  "sodium_per_hour": <integer>,
  "fluid_per_hour": "e.g. 500-750 ml/hr",
  "pack_list": [
    { "item": "what to pack", "carbs": <total carbs this item contributes>, "note": "short note" }
  ],
  "total_carbs": <total for whole ride>,
  "total_sodium": <total for whole ride>,
  "field_notes": ["tip 1", "tip 2", "tip 3"],
  "ratio_note": "why ratio matters here, or empty string",
  "bottom_line": "1 sentence on consequence of under-fueling",
  "resilience": {
    "classification": "Tight | Moderate | Buffered",
    "note": "1 sentence explaining why — reference delivery mix and terrain",
    "front_load": true | false,
    "front_load_tip": "specific first 20-30min action, or empty string",
    "warning": "execution fragility warning, or empty string"
  },
  "stem_card": {
    "pre": "before rolling — max 8 words",
    "during": "background rhythm — max 8 words",
    "efforts": "at intensity moments — max 8 words",
    "target": "Xg/hr + one phrase — max 8 words"
  }
}

RULES:
- DURATION: Sum every block. Do not round.
- CARB TARGETS: Push upper end for any ride above Z2. Standard: 85-90g/hr. Gut trained: 110-120g/hr for race efforts. Never 60-80g/hr for hard efforts.
- FUELING PHILOSOPHY: Protect power output at key moments. Background fueling high enough that gels are top-ups not rescues. Prevent deficit, don't recover from it.
- SOLID FOOD: First hour or Z2 only. Always flag in note field. Liquid + gels primary for any intensity.
- SODIUM: Cool 400-600mg/hr. Moderate 600-800mg/hr. Hot 800-1000mg/hr. Never under 400mg/hr.
- HYDRATION PACK: If ANY pack is in the selected products, it MUST be the first item in pack_list regardless of carb content. Format: "Hydration Pack XL — water only" or "Hydration Pack XL — light mix". Note: "continuous hands-free hydration — frees bottles for concentrated carb mix". Always mention pack in field_notes. A pack fundamentally changes bottle strategy — bottles become carb delivery only, pack handles hydration.
- DURATION: Always use the explicitly stated duration if given. Do not infer from distance.
- BOTTLES: Max 2. Fill carb gap with gels and food. Unless hydration pack mentioned.
- DISCRETE DEPENDENCY: Over 60% from gels/solids = execution-sensitive. Flag in resilience.
- ROLLING TERRAIN + NO FLAT: Front-load and bias toward continuous sources.
- RESILIENCE: Use pre-computed data. Tight = high discrete + difficult terrain. Moderate = some buffer. Buffered = continuous dominates or aid access.
- FRONT LOAD: If true, give specific banking action for first 20-30 min.
- SHORT RACE <45min: No bottle. Pre-load 1-2 gels.
- CIRCUIT 45-75min: Pre-load 2 gels. 1 light bottle. 1 spare gel.
- SHORT CRIT 45-75min: Pre-load all. Water only mid-race.
- GRAVEL RACE 3-5hr: Self-supported, sodium critical, intake every 20-30 min.
- LONG RIDE 4hr+: Specific pocket logistics and water stop plan.
- SALTY SWEATER: +40-60% sodium above standard.
- MAURTEN: Very low sodium. Flag that sodium must come from other sources if selected.
- NO PRODUCT INVENTION: Only selected products.
- ALL BRANDS EQUAL: No brand gets special treatment.
- GI DISTRESS: Never blame product. It's timing, concentration, intensity, gut training.
- STEM CARD: Max 8 words per line. Action words. Screenshot-readable.
- Return ONLY the JSON object.`;
}

// ── ENDPOINT ─────────────────────────────────────────────────────────────────

app.post('/api/fuel', async (req, res) => {
  try {
    const { desc, tempLabel, sweatLabel, gutLabel, products } = req.body;

    if (!desc || !tempLabel) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

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
    const prompt = buildPrompt({ desc, tempLabel, sweatLabel, gutLabel, productList, deliveryContext, resilience });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
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
