/**
 * Simple animated SVG illustrations, one per exercise.
 *
 * Drawn as calm line figures that use `currentColor`, so they follow the
 * light/dark theme. Animations are pure CSS (see "Illustrations" in
 * styles.css) and are switched off for prefers-reduced-motion or the in-app
 * "reduce motion" setting. In that case the figure shows the key position.
 *
 * Coordinate system: viewBox 0 0 240 160, floor at y = 150.
 */

const FLOOR = '<line class="ill-floor" x1="6" y1="151" x2="234" y2="151"/>';

const CHAIR = `
  <g class="ill-prop">
    <line x1="28" y1="28" x2="28" y2="150"/>
    <line x1="28" y1="94" x2="96" y2="94"/>
    <line x1="92" y1="94" x2="92" y2="150"/>
  </g>`;

const SEATED_UPPER = `
  <circle class="ill-head" cx="52" cy="22" r="11"/>
  <line x1="50" y1="34" x2="56" y2="88"/>
  <polyline points="52,46 72,70 86,88"/>`;

/** A foot drawn flat on the floor: heel at x=133, toes at x=170. */
const FOOT_FLAT = '<path class="ill-foot" d="M132 140 L133 147 L170 147 Q174 147 172 143 L150 139 Z"/>';

function wrap(label, inner, extraClass = '') {
  return `<svg class="ill ${extraClass}" viewBox="0 0 240 160" role="img" aria-label="${label}" focusable="false">
    <g class="ill-body" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      ${inner}
    </g>
  </svg>`;
}

const ILLUSTRATIONS = {
  'seated-calf-raise': () =>
    wrap(
      'Person sitting on a chair slowly lifting both heels while the ball of the foot stays down',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <line class="a-thigh-lift" x1="58" y1="88" x2="140" y2="88"/>
      <g class="a-shin-lift"><line x1="140" y1="88" x2="140" y2="138"/></g>
      <g class="a-heel-lift">${FOOT_FLAT}</g>
      <circle class="ill-mark" cx="162" cy="147" r="4"/>`,
    ),

  'ankle-pumps': () =>
    wrap(
      'Person sitting with one leg resting out straight, pointing the toes away then pulling them back towards the shin',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <line x1="58" y1="88" x2="180" y2="112"/>
      <ellipse class="ill-cushion" cx="184" cy="134" rx="26" ry="11"/>
      <g class="a-pump"><path class="ill-foot" d="M180 112 L186 120 L190 120 L192 86 Q190 82 186 85 Z"/></g>
      <line x1="58" y1="88" x2="120" y2="150" class="ill-faint"/>`,
    ),

  'ankle-circles': () =>
    wrap(
      'Person sitting with one foot raised, drawing slow circles with the foot',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <line x1="58" y1="88" x2="180" y2="112"/>
      <ellipse class="ill-cushion" cx="184" cy="134" rx="26" ry="11"/>
      <g class="a-circle"><path class="ill-foot" d="M180 112 L186 120 L190 120 L192 86 Q190 82 186 85 Z"/></g>
      <path class="ill-arrow" d="M174 74 A20 20 0 1 1 206 84" />
      <polyline class="ill-arrow" points="200,78 206,84 212,78"/>
      <line x1="58" y1="88" x2="120" y2="150" class="ill-faint"/>`,
    ),

  'heel-toe-rock': () =>
    wrap(
      'Person sitting, rocking the feet between lifting the toes and lifting the heels',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <line x1="58" y1="88" x2="140" y2="88"/>
      <line x1="140" y1="88" x2="140" y2="138"/>
      <g class="a-toes-up"><g class="a-heels-up">${FOOT_FLAT}</g></g>`,
    ),

  'seated-march': () =>
    wrap(
      'Person sitting tall, lifting one knee a little then placing the foot down gently',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <g class="ill-faint"><line x1="58" y1="90" x2="134" y2="90"/><line x1="134" y1="90" x2="134" y2="146"/></g>
      <g class="a-march">
        <line x1="58" y1="88" x2="140" y2="88"/>
        <line x1="140" y1="88" x2="140" y2="138"/>
        ${FOOT_FLAT}
      </g>`,
    ),

  'knee-extension': () =>
    wrap(
      'Person sitting, slowly straightening one knee, holding, then lowering',
      `${FLOOR}${CHAIR}${SEATED_UPPER}
      <line x1="58" y1="88" x2="140" y2="88"/>
      <g class="ill-faint"><line x1="134" y1="90" x2="134" y2="146"/></g>
      <g class="a-knee-ext">
        <line x1="140" y1="88" x2="140" y2="138"/>
        <path class="ill-foot" d="M138 136 L136 147 L156 147 Q160 146 157 142 L146 136 Z"/>
      </g>`,
    ),

  'toe-wiggle': () =>
    `<svg class="ill" viewBox="0 0 240 160" role="img" aria-label="Foot seen from above with toes gently spreading apart. The little toe is left to rest." focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
        <path class="ill-foot-top" d="M92 150 C80 120 84 80 96 64 C108 50 150 50 160 66 C170 84 166 122 150 150 Z"/>
        <g class="a-toe a-toe1"><ellipse cx="100" cy="44" rx="11" ry="14"/></g>
        <g class="a-toe a-toe2"><ellipse cx="122" cy="38" rx="8" ry="10"/></g>
        <g class="a-toe a-toe3"><ellipse cx="139" cy="42" rx="7" ry="9"/></g>
        <g class="a-toe a-toe4"><ellipse cx="153" cy="50" rx="6" ry="8"/></g>
        <ellipse class="ill-rest" cx="166" cy="62" rx="5.5" ry="7"/>
      </g>
      <text x="178" y="58" class="ill-label">rest</text>
    </svg>`,

  'standing-calf-raise': () =>
    wrap(
      'Person standing and holding a counter, rising slowly onto the middle of the forefoot',
      `${FLOOR}
      <g class="ill-prop"><rect x="40" y="58" width="56" height="92" rx="4"/></g>
      <g class="a-stand-rise">
        <circle class="ill-head" cx="132" cy="18" r="11"/>
        <line x1="132" y1="30" x2="132" y2="88"/>
        <polyline points="132,44 108,56 96,60"/>
        <line x1="132" y1="88" x2="130" y2="138"/>
      </g>
      <g class="a-stand-heel"><path class="ill-foot" d="M124 140 L125 147 L160 147 Q164 147 162 143 L140 139 Z"/></g>
      <circle class="ill-mark" cx="150" cy="147" r="4"/>`,
    ),

  stairs: () =>
    wrap(
      'Person walking slowly up stairs holding the handrail, with the whole foot on each step',
      `<g class="ill-prop">
        <polyline points="6,150 70,150 70,126 110,126 110,102 150,102 150,78 190,78 190,54 234,54"/>
        <line x1="40" y1="96" x2="210" y2="20"/>
      </g>
      <g class="a-climb">
        <circle class="ill-head" cx="96" cy="30" r="10"/>
        <line x1="96" y1="41" x2="96" y2="92"/>
        <polyline points="96,54 112,66 118,72"/>
        <polyline points="96,92 110,108 120,122"/>
        <polyline points="96,92 88,118 84,146"/>
        <line class="ill-foot-line" x1="76" y1="148" x2="96" y2="148"/>
        <line class="ill-foot-line" x1="114" y1="124" x2="134" y2="124"/>
      </g>`,
    ),

  elevation: () =>
    wrap(
      'Person lying on their back with lower legs on pillows so the feet are above the heart, doing gentle ankle pumps',
      `${FLOOR}
      <g class="ill-prop"><rect x="8" y="112" width="224" height="22" rx="6"/></g>
      <ellipse class="ill-cushion" cx="186" cy="92" rx="34" ry="18"/>
      <circle class="ill-head" cx="28" cy="98" r="10"/>
      <line x1="40" y1="102" x2="112" y2="104"/>
      <line x1="112" y1="104" x2="150" y2="74"/>
      <line x1="150" y1="74" x2="200" y2="66"/>
      <g class="a-pump-lying"><path class="ill-foot" d="M200 66 L208 70 L212 66 L208 42 Q205 38 202 42 Z"/></g>
      <path class="ill-heart" d="M70 92 c-3 -6 -11 -3 -8 3 l8 7 l8 -7 c3 -6 -5 -9 -8 -3 z"/>
      <line class="ill-guide" x1="62" y1="96" x2="226" y2="96"/>`,
    ),

  'wall-calf-stretch': () =>
    wrap(
      'Person facing a wall with hands on it, one foot back with the heel down, gently stretching the back calf',
      `${FLOOR}
      <g class="ill-prop"><line x1="214" y1="8" x2="214" y2="150"/></g>
      <g class="a-lean">
        <circle class="ill-head" cx="172" cy="28" r="11"/>
        <line x1="168" y1="40" x2="140" y2="92"/>
        <polyline points="164,50 190,52 212,48"/>
        <polyline points="140,92 166,116 170,142"/>
      </g>
      <line x1="140" y1="92" x2="92" y2="142"/>
      <path class="ill-foot" d="M84 140 L84 147 L112 147 Q116 147 113 143 L98 139 Z"/>
      <path class="ill-foot" d="M164 140 L164 147 L190 147 Q194 147 191 143 L178 139 Z"/>`,
    ),

  'walking-pad': () =>
    wrap(
      'Person walking slowly on a walking pad',
      `${FLOOR}
      <g class="ill-prop"><rect x="40" y="138" width="160" height="12" rx="6"/></g>
      <circle class="ill-head" cx="120" cy="20" r="11"/>
      <line x1="120" y1="32" x2="120" y2="86"/>
      <g class="a-arm-a"><line x1="120" y1="44" x2="120" y2="78"/></g>
      <g class="a-leg-a"><polyline points="120,86 120,112 120,134"/><line class="ill-foot-line" x1="116" y1="134" x2="134" y2="134"/></g>
      <g class="a-leg-b"><polyline points="120,86 120,112 120,134"/><line class="ill-foot-line" x1="116" y1="134" x2="134" y2="134"/></g>`,
    ),
};

/** SVG markup for an exercise (empty string if none). */
export function illustration(id) {
  const fn = ILLUSTRATIONS[id];
  return fn ? fn() : '';
}
