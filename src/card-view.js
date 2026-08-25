export const PATH_COLORS = {
  '毁灭': ['#d35454', '#5e2323'], '巡猎': ['#d67a35', '#673819'],
  '智识': ['#6e70d8', '#303169'], '同谐': ['#d7a63d', '#684e17'],
  '虚无': ['#8c55b7', '#402452'], '欢愉': ['#d65e9e', '#64274a'],
  '存护丰饶': ['#59a878', '#245039'], '记忆': ['#4e9fb8', '#224956'],
  '崩坏': ['#a85bd4', '#4f286d'],
};

export const PATH_ICONS = {
  '毁灭': 'img/icon/destruction.png', '巡猎': 'img/icon/hunt.png',
  '智识': 'img/icon/erudition.png', '同谐': 'img/icon/harmony.png',
  '虚无': 'img/icon/nihility.png', '欢愉': 'img/icon/elation.png',
  '存护丰饶': 'img/icon/preservation.png', '记忆': 'img/icon/remembrance.png',
  '崩坏': 'img/icon/honkai.svg',
};

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function pathStyle(def) {
  const [color, dark] = PATH_COLORS[def.class] || ['#6a7480', '#2a2f38'];
  const icon = PATH_ICONS[def.class] || '';
  return `--pc:${color};--pcd:${dark};--pi:url('../${icon}')`;
}

export function cardImage(def) {
  if (!def?.img) return '';
  const follower = def.type === '随从' ? ' follow' : '';
  return `<img class="art${follower}" src="${encodeURI(def.img)}" alt="" loading="lazy" decoding="async">`;
}

export function staticCardHTML(def, options = {}) {
  const token = def.isToken ? ' token' : '';
  const follower = def.type === '随从';
  const quality = def.isToken ? '衍生' : def.quality;
  const copies = options.copies ? `<div class="copies">×${options.copies}</div>` : '';
  return `<article class="catalog-card card q${esc(quality)}${token}" data-card-id="${esc(def.id)}" tabindex="0" style="${pathStyle(def)}">`
    + cardImage(def)
    + `<div class="cost"><b>${def.cost ?? 0}</b></div>`
    + copies
    + `<div class="cname">${esc(def.name)}</div>`
    + `<div class="effect"><div class="ct">${esc(def.note || '（无特殊效果）')}</div></div>`
    + (def.tag ? `<div class="subtype">${esc(def.tag)}</div>` : '')
    + (follower
      ? `<div class="atk"><b>${def.atk}</b></div><div class="hp"><b>${def.hp}</b></div>`
      : def.countdown ? `<div class="cd">${def.countdown}</div>` : '')
    + (options.showClass ? `<div class="class-chip">${esc(def.class)}</div>` : '')
    + '</article>';
}
